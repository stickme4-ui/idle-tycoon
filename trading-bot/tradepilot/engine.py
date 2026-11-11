"""The engine: data in -> strategies -> proposals -> AI review -> risk -> orders -> tracking.

Two ways a proposal becomes an order:
  * manual: you click "execute" (or "arm" it in advance so it fires on its trigger);
  * auto:   the engine executes it on its trigger when it passes the auto rules.
Either way the risk manager re-checks the exact order at the current price first.
"""
from __future__ import annotations

import asyncio
import logging
from collections import deque
from datetime import datetime, time, timedelta

from . import risk as R
from .config import NY, Settings
from .market import MarketContext, build_stats
from .models import ACTIVE, Proposal, Side, Signal, Status
from .scoring import score
from .strategies.news_momentum import NewsMomentumStrategy
from .strategies.orb import OrbStrategy

log = logging.getLogger("tradepilot.engine")


class Engine:
    def __init__(self, settings: Settings, broker, feed, clock, analyst, journal):
        self.s, self.broker, self.feed, self.clock, self.ai, self.journal = settings, broker, feed, clock, analyst, journal
        self.ctx = MarketContext(now=clock.now())
        self.orb = OrbStrategy(settings.orb, settings.risk)
        self.newsstrat = NewsMomentumStrategy(settings.news, settings.risk)
        self.strategies = [self.orb, self.newsstrat]
        self.proposals: dict = {}
        self.mode = "manual"
        self.live_auto_confirmed = False
        self.kill = False
        self.day = R.DayState()
        self.account = None
        self.positions: list = []
        self.market_open = False
        self.events: deque = deque(maxlen=300)
        self.news_log: deque = deque(maxlen=60)
        self.listeners: set = set()
        self.lock = asyncio.Lock()
        self.prepared_for = None
        self.backfilled_for = None
        self.flattened_for = None
        self.last_sync: datetime | None = None
        self.preparing = False
        self.review_sem = asyncio.Semaphore(4)
        self.bg: set = set()
        self.loop_task = None
        self.started = False

    # ------------------------------------------------------------------ lifecycle
    async def start(self) -> None:
        await self.sync(force=True)
        await self.feed.start(self)
        if not self.clock.simulated:
            self.loop_task = asyncio.create_task(self._loop())
        self.started = True
        self.log("info", f"הבוט עלה: ברוקר {self.broker.name} ({'כסף אמיתי' if self.s.is_live_money else 'נייר / דמו'})")

    async def stop(self) -> None:
        if self.loop_task:
            self.loop_task.cancel()
        await self.feed.stop()

    async def _loop(self) -> None:
        while True:
            try:
                await self.tick()
            except asyncio.CancelledError:
                raise
            except Exception as e:  # never let one bad tick kill the bot
                log.exception("tick")
                self.log("error", f"שגיאה בלולאה: {e}")
            await asyncio.sleep(2)

    def _spawn(self, coro) -> None:
        t = asyncio.create_task(coro)
        self.bg.add(t)
        t.add_done_callback(self.bg.discard)

    # ------------------------------------------------------------------ helpers
    def log(self, level: str, text: str) -> None:
        now = self.clock.now()
        self.events.append({"ts": now.isoformat(), "level": level, "text": text})
        try:
            self.journal.event(now, level, text)
        except Exception:
            pass

    def ny_time(self) -> time:
        return self.clock.now().astimezone(NY).time()

    def save(self, p: Proposal) -> None:
        try:
            self.journal.save_proposal(str(self.ctx.today), p.to_dict())
        except Exception:
            pass

    async def _call(self, fn, *a):
        """Broker calls: in a thread for real brokers, inline for the simulator."""
        if self.broker.name == "sim":
            return fn(*a)
        return await asyncio.to_thread(fn, *a)

    # ------------------------------------------------------------------ the day
    async def prepare_day(self) -> None:
        if self.preparing:
            return
        self.preparing = True
        try:
            now = self.clock.now()
            self.ctx = MarketContext(now=now)
            today = self.ctx.today
            for p in self.proposals.values():
                self.save(p)
            self.proposals = {k: p for k, p in self.proposals.items() if p.status == Status.OPEN}
            self.day.reset_if_new(today)
            self.orb.done_for = None
            self.newsstrat.fired.clear()
            self.flattened_for = self.backfilled_for = None
            self.log("info", f"הכנה ליום המסחר {today}: בונה רשימת מניות ונתוני עבר")
            universe = await self.feed.universe(self.s.universe_size, self.s.watchlist)
            daily, intraday = await self.feed.history(universe, today, self.s.orb.or_minutes, self.s.orb.lookback_days)
            self.ctx.universe = universe
            for sym in universe:
                self.ctx.stats[sym] = build_stats(sym, daily.get(sym, []), intraday.get(sym, []), today,
                                                  self.s.orb.or_minutes, self.s.orb.lookback_days)
            ok = sum(1 for sym in universe if self.orb.eligible(self.ctx, sym))
            self.log("info", f"{len(universe)} מניות ברשימה, {ok} עוברות את סינון הנזילות וה-ATR")
            since = datetime.combine(today - timedelta(days=1), time(16, 0), NY)
            for item in (await self.feed.recent_news(universe, since))[:25]:
                await self.on_news(item, fresh=False)
            self.prepared_for = today
        finally:
            self.preparing = False

    async def end_day(self) -> None:
        for p in self.proposals.values():
            if p.status in ACTIVE:
                p.status = Status.EXPIRED
            self.save(p)
        st = self.journal.stats()
        self.log("info", f"סוף יום. רווח/הפסד היום: {self.day.realized_pnl:+.2f}$. סה\"כ עסקאות ביומן: {st['trades']}")

    async def tick(self) -> None:
        now = self.clock.now()
        self.ctx.now = now
        t = now.astimezone(NY)
        today = t.date()
        if not self.clock.simulated:
            if self.prepared_for != today and t.weekday() < 5 and t.time() >= time(9, 0):
                await self.prepare_day()
            ready = (datetime.combine(today, time(9, 30), NY) + timedelta(minutes=self.s.orb.or_minutes, seconds=10))
            if self.prepared_for == today and self.backfilled_for != today and t >= ready and t.time() < time(16, 0):
                self.backfilled_for = today
                try:
                    for b in await self.feed.backfill_today(self.ctx.universe, now):
                        self.ctx.add_bar(b)
                except Exception as e:
                    self.log("error", f"משיכת נתוני הפתיחה נכשלה: {e}")
        if self.prepared_for == today:
            for strat in self.strategies:
                for sig in strat.on_clock(self.ctx):
                    await self.propose(sig)
        await self._expire(now)
        flat = R.hhmm(self.s.risk.flat_by)
        if t.time() >= flat and self.flattened_for != today and t.weekday() < 5:
            self.flattened_for = today
            if any(p.status == Status.OPEN for p in self.proposals.values()):
                await self.flatten("סגירה אוטומטית בסוף היום (מסחר יומי)")
        if self.clock.simulated or not self.last_sync or (now - self.last_sync).total_seconds() >= 10:
            await self.sync()
        await self.broadcast()

    async def _expire(self, now: datetime) -> None:
        for p in self.proposals.values():
            if p.status in ACTIVE and now >= p.expires_at:
                p.status = Status.EXPIRED
                p.note(now, "פג תוקף")
                self.save(p)
            elif p.status == Status.TRIGGERED and p.triggered_at and now - p.triggered_at > timedelta(minutes=10):
                p.status = Status.EXPIRED
                p.note(now, "הטריגר עבר לפני יותר מ-10 דקות ולא בוצע")
                self.save(p)

    # ------------------------------------------------------------------ data in
    async def on_bar(self, bar) -> None:
        self.ctx.add_bar(bar)
        if hasattr(self.broker, "set_price"):
            self.broker.set_price(bar.symbol, bar.close)
        await self.on_price(bar.symbol, bar.close, bar.ts, bar.high, bar.low)

    async def on_price(self, sym: str, price: float, ts=None, high: float | None = None, low: float | None = None) -> None:
        self.ctx.last_price[sym] = price
        for p in list(self.proposals.values()):
            if p.signal.symbol != sym or p.status not in (Status.WAITING, Status.ARMED):
                continue
            s = p.signal
            hi, lo = high if high is not None else price, low if low is not None else price
            hit = hi >= s.entry if s.side == Side.BUY else lo <= s.entry
            if hit:
                await self.on_trigger(p)

    def _relevant(self, symbols) -> bool:
        """Only headlines about stocks we scan, hold or have a proposal for are worth an AI call:
        the live news stream carries thousands of headlines a day."""
        watched = set(self.ctx.universe) | {p.signal.symbol for p in self.proposals.values()}
        watched |= {x.symbol for x in self.positions}
        return any(s in watched for s in symbols)

    async def on_news(self, item, fresh: bool = True) -> None:
        if not self._relevant(item.symbols):
            return
        a = await self.ai.analyze_news(item)
        self.ctx.add_news(item, a)
        row = {"ts": item.ts.isoformat(), "symbols": item.symbols, "headline": item.headline, "source": item.source,
               "sentiment": a.sentiment, "materiality": a.materiality, "catalyst": a.catalyst,
               "direction": a.direction, "summary_he": a.summary_he, "by": a.by}
        self.news_log.appendleft(row)
        for p in self.proposals.values():
            if p.signal.symbol in item.symbols and p.status in ACTIVE:
                p.news.append(row)
                p.score, p.score_parts = score(p)
        if fresh and self.prepared_for == self.ctx.today:
            for strat in self.strategies:
                for sig in strat.on_news(item, a, self.ctx):
                    await self.propose(sig)

    # ------------------------------------------------------------------ proposals
    def _strategy_cfg(self, name: str):
        return self.s.orb if name == "orb" else self.s.news

    async def propose(self, sig: Signal) -> Proposal | None:
        now = self.clock.now()
        for p in self.proposals.values():
            if p.signal.symbol == sig.symbol and p.signal.strategy == sig.strategy and p.created_at.astimezone(NY).date() == self.ctx.today:
                return None
        acct = self.account or await self._call(self.broker.account)
        qty, rule = R.size_position(sig.entry, sig.stop, acct, self.s.risk, R.open_risk(list(self.proposals.values())),
                                    sum(abs(x.market_value) for x in self.positions))
        last = datetime.combine(self.ctx.today, R.hhmm(self.s.risk.no_entries_after), NY)
        expires = min(last, now + timedelta(minutes=15)) if sig.trigger == "market" else last
        p = Proposal(signal=sig, qty=qty, created_at=now, expires_at=expires,
                     auto_allowed=self._strategy_cfg(sig.strategy).auto_allowed)
        p.news = [{"ts": i.ts.isoformat(), "headline": i.headline, "sentiment": a.sentiment, "materiality": a.materiality,
                   "summary_he": a.summary_he, "catalyst": a.catalyst, "by": a.by}
                  for i, a in self.ctx.recent_news(sig.symbol)][-5:]
        p.score, p.score_parts = score(p)
        p.note(now, f"נוצרה הצעה ({sig.strategy}); גודל לפי כלל: {rule}")
        p.ai_pending = self.ai.enabled
        self.proposals[p.id] = p
        self.save(p)
        side = "קנייה" if sig.side == Side.BUY else "שורט"
        self.log("signal", f"הצעה חדשה: {side} {sig.symbol} ב-{sig.entry} (סטופ {sig.stop}), ציון {p.score}")
        await self.feed.watch_prices([sig.symbol])
        if self.ai.enabled:
            self._spawn(self._review(p))
        if sig.trigger == "market":
            await self.on_trigger(p)
        return p

    async def _review(self, p: Proposal) -> None:
        async with self.review_sem:
            ctx = {"regime": self.ctx.regime(), "news": p.news, "time": self.clock.now().astimezone(NY).isoformat()}
            try:
                p.ai = await self.ai.review(p, ctx)
            except Exception as e:
                self.log("error", f"ניתוח Claude נכשל ל-{p.signal.symbol}: {e}")
            p.ai_pending = False
            p.score, p.score_parts = score(p)
            if p.ai:
                p.note(self.clock.now(), f"Claude: {p.ai.verdict} ({p.ai.confidence})")
            elif self.ai.last_error:
                p.note(self.clock.now(), self.ai.last_error)
            self.save(p)
            if p.status == Status.TRIGGERED and self.auto_ok(p)[0]:
                await self.execute(p.id, by="auto")
            await self.broadcast()

    def auto_ok(self, p: Proposal) -> tuple[bool, str]:
        if self.mode != "auto":
            return False, "מצב ידני"
        if self.s.is_live_money and not (self.s.allow_live_auto and self.live_auto_confirmed):
            return False, "מצב אוטומטי בכסף אמיתי נעול"
        if not p.auto_allowed:
            return False, "האסטרטגיה הזו מותרת רק ידנית"
        if getattr(p, "ai_pending", False) and self.s.auto.require_ai_ok:
            return False, "ממתין לניתוח Claude"
        if self.s.auto.require_ai_ok and p.ai and p.ai.verdict == "skip":
            return False, "Claude המליץ לדלג"
        if p.score < self.s.auto.min_score:
            return False, f"ציון {p.score} מתחת לסף {self.s.auto.min_score:g}"
        return True, ""

    async def on_trigger(self, p: Proposal) -> None:
        now = self.clock.now()
        if p.status == Status.ARMED:
            p.triggered_at = now
            await self.execute(p.id, by="armed")
            return
        ok, why = self.auto_ok(p)
        p.status, p.triggered_at = Status.TRIGGERED, now
        if ok:
            await self.execute(p.id, by="auto")
        else:
            p.note(now, f"הגיע לטריגר: ממתין ללחיצה שלך ({why})")
            self.log("signal", f"{p.signal.symbol} הגיע לנקודת הכניסה. מוכן לביצוע בלחיצה")
            self.save(p)

    # ------------------------------------------------------------------ actions
    async def execute(self, pid: str, by: str = "manual") -> dict:
        async with self.lock:
            p = self.proposals.get(pid)
            if not p:
                return {"ok": False, "reasons": ["הצעה לא קיימת"]}
            if p.status not in ACTIVE:
                return {"ok": False, "reasons": [f"ההצעה במצב {p.status.value}"]}
            s, now = p.signal, self.clock.now()
            if s.trigger == "stop" and p.status == Status.WAITING and by == "manual":
                # executing before the trigger = entering at market now; allowed, the drift rule still applies
                p.note(now, "ביצוע ידני לפני הטריגר")
            p.status = Status.EXECUTING
            try:
                price = await self._call(self.broker.last_price, s.symbol) or self.ctx.last_price.get(s.symbol)
                acct = await self._call(self.broker.account)
                positions = await self._call(self.broker.positions)
                clock = await self._call(self.broker.clock)
            except Exception as e:
                p.status = Status.TRIGGERED
                return {"ok": False, "reasons": [f"אין חיבור לברוקר: {e}"]}
            if price is None:
                p.status = Status.TRIGGERED
                return {"ok": False, "reasons": ["אין מחיר עדכני"]}
            orisk = R.open_risk(list(self.proposals.values()))
            exposure = sum(abs(x.market_value) for x in positions)
            p.qty, _ = R.size_position(price, s.stop, acct, self.s.risk, orisk, exposure)
            reasons = R.check(p, price, acct, positions, self.day, self.s.risk, now, orisk,
                              market_open=bool(clock.get("is_open")), kill_switch=self.kill)
            if reasons:
                p.status = Status.REJECTED
                p.note(now, "נחסם: " + "; ".join(reasons))
                self.log("risk", f"{s.symbol} נחסם על ידי מנהל הסיכונים: {reasons[0]}")
                self.save(p)
                await self.broadcast()
                return {"ok": False, "reasons": reasons}
            cid = f"tp-{self.ctx.today:%Y%m%d}-{p.id}"
            res = await self._call(self.broker.submit_entry, s.symbol, s.side, p.qty, s.stop, s.target, cid)
            if not res.ok:
                p.status = Status.FAILED
                p.note(now, f"הברוקר דחה: {res.error}")
                self.log("error", f"הזמנה ל-{s.symbol} נדחתה: {res.error}")
                self.save(p)
                await self.broadcast()
                return {"ok": False, "reasons": [res.error]}
            p.status, p.order_id, p.opened_at = Status.OPEN, res.order_id, now
            p.fill_price, p.filled_qty = res.filled_price, res.filled_qty or (p.qty if res.filled_price else 0)
            self.day.entries += 1
            who = {"manual": "בלחיצה שלך", "armed": "אושר מראש ובוצע בטריגר", "auto": "אוטומטית"}[by]
            p.note(now, f"נשלחה הזמנה {who}: {p.qty} מניות, מחיר שוק ~{price:.2f}, סטופ {s.stop}")
            self.log("trade", f"בוצע {who}: {'קנייה' if s.side == Side.BUY else 'שורט'} {p.qty} {s.symbol} @ ~{price:.2f}")
            self.save(p)
        await self.sync(force=True)
        await self.broadcast()
        return {"ok": True, "order_id": res.order_id}

    async def arm(self, pid: str) -> dict:
        p = self.proposals.get(pid)
        if not p or p.status != Status.WAITING:
            return {"ok": False, "reasons": ["אפשר לאשר מראש רק הצעה שממתינה לטריגר"]}
        p.status = Status.ARMED
        p.note(self.clock.now(), "אישרת מראש: תבוצע ברגע שהמחיר יגיע לנקודת הכניסה")
        self.save(p)
        await self.broadcast()
        return {"ok": True}

    async def dismiss(self, pid: str) -> dict:
        p = self.proposals.get(pid)
        if not p or p.status not in ACTIVE:
            return {"ok": False, "reasons": ["לא ניתן לדחות"]}
        p.status = Status.DISMISSED
        p.note(self.clock.now(), "נדחתה על ידך")
        self.save(p)
        await self.broadcast()
        return {"ok": True}

    async def close(self, pid: str) -> dict:
        p = self.proposals.get(pid)
        if not p or p.status != Status.OPEN:
            return {"ok": False, "reasons": ["אין פוזיציה פתוחה"]}
        res = await self._call(self.broker.close_position, p.signal.symbol)
        p.note(self.clock.now(), "נסגרה ידנית" if res.ok else f"סגירה נכשלה: {res.error}")
        await self.sync(force=True)
        await self.broadcast()
        return {"ok": res.ok, "reasons": [res.error] if not res.ok else []}

    async def flatten(self, reason: str) -> None:
        for p in list(self.proposals.values()):
            if p.status in ACTIVE:
                p.status = Status.EXPIRED
                p.note(self.clock.now(), reason)
            if p.status == Status.OPEN:
                res = await self._call(self.broker.close_position, p.signal.symbol)
                p.note(self.clock.now(), reason if res.ok else f"סגירה נכשלה: {res.error}")
        self.log("trade", reason)
        await self.sync(force=True)

    async def set_mode(self, mode: str, confirm: str = "") -> dict:
        if mode not in ("manual", "auto"):
            return {"ok": False, "reasons": ["מצב לא מוכר"]}
        if mode == "auto" and self.s.is_live_money:
            if not self.s.allow_live_auto:
                return {"ok": False, "reasons": ["מצב אוטומטי בכסף אמיתי נעול. כדי לפתוח: ALLOW_LIVE_AUTO=true בקובץ .env, ורק אחרי תקופת נייר מוצלחת"]}
            if confirm.strip() != "אני מבין את הסיכון":
                return {"ok": False, "reasons": ["כדי להפעיל אוטומטי בכסף אמיתי הקלד: אני מבין את הסיכון"]}
            self.live_auto_confirmed = True
        self.mode = mode
        self.log("info", f"מצב שונה ל{'אוטומטי' if mode == 'auto' else 'ידני'}")
        await self.broadcast()
        return {"ok": True}

    async def set_kill(self, on: bool, flatten: bool = False) -> dict:
        self.kill = on
        if on:
            self.mode = "manual"
            self.log("risk", "מתג החירום הופעל: אין כניסות חדשות, המצב חזר לידני")
            if flatten:
                await self.flatten("מתג חירום: סגירת כל הפוזיציות של הבוט")
        else:
            self.log("info", "מתג החירום כובה")
        await self.broadcast()
        return {"ok": True}

    # ------------------------------------------------------------------ broker sync
    async def sync(self, force: bool = False) -> None:
        try:
            self.account = await self._call(self.broker.account)
            self.positions = await self._call(self.broker.positions)
            self.market_open = bool((await self._call(self.broker.clock)).get("is_open"))
        except Exception as e:
            self.log("error", f"סנכרון מול הברוקר נכשל: {e}")
            return
        self.last_sync = self.clock.now()
        held = {x.symbol: x for x in self.positions}
        now = self.clock.now()
        for p in self.proposals.values():
            if p.status != Status.OPEN:
                continue
            st = None
            if p.order_id and (p.fill_price is None or p.signal.symbol not in held):
                try:
                    st = await self._call(self.broker.order_status, p.order_id)
                except Exception:
                    st = None
            if st and p.fill_price is None and st.get("filled_price"):
                p.fill_price, p.filled_qty = st["filled_price"], st.get("filled_qty") or p.qty
            if st and st.get("status") in ("canceled", "expired", "rejected") and not p.fill_price:
                p.status = Status.FAILED
                p.note(now, f"ההזמנה לא בוצעה ({st['status']})")
                continue
            settled = p.opened_at and (now - p.opened_at).total_seconds() > (0 if self.clock.simulated else 5)
            if p.fill_price and p.signal.symbol not in held and settled:
                exit_px = (st or {}).get("exit_price") or self.ctx.last_price.get(p.signal.symbol) or p.fill_price
                sign = 1 if p.signal.side == Side.BUY else -1
                p.exit_price = round(exit_px, 4)
                p.pnl = round((exit_px - p.fill_price) * p.filled_qty * sign, 2)
                p.status, p.closed_at = Status.CLOSED, now
                self.day.realized_pnl += p.pnl
                self.day.consecutive_losses = 0 if p.pnl > 0 else self.day.consecutive_losses + 1
                self.day.day_trades.append(self.ctx.today)
                p.note(now, f"נסגרה ב-{exit_px:.2f}: {p.pnl:+.2f}$")
                self.log("trade", f"{p.signal.symbol} נסגרה: {p.pnl:+.2f}$")
                self.save(p)
        # daily loss stop (realized + unrealized, from the broker's own equity)
        if self.account and not self.day.halted_reason:
            if R.daily_loss_budget(self.account, self.s.risk) <= 0:
                self.day.halted_reason = f"הגעת למגבלת ההפסד היומית ({self.account.day_pnl:+.0f}$)"
                self.log("risk", self.day.halted_reason + ". אין כניסות חדשות היום")
            elif self.day.consecutive_losses >= self.s.risk.max_consecutive_losses:
                self.day.halted_reason = f"{self.day.consecutive_losses} הפסדים ברצף"
                self.log("risk", "מפסק זרם: " + self.day.halted_reason)

    # ------------------------------------------------------------------ UI state
    def snapshot(self) -> dict:
        a = self.account
        today = self.ctx.today
        props = sorted(self.proposals.values(), key=lambda p: (p.status not in (Status.TRIGGERED, Status.OPEN, Status.ARMED),
                                                               p.status not in ACTIVE, -p.score))
        out_props = []
        for p in props:
            d = p.to_dict()
            d["ai_pending"] = getattr(p, "ai_pending", False)
            d["auto_ok"], d["auto_why"] = self.auto_ok(p)
            d["last_price"] = self.ctx.last_price.get(p.signal.symbol)
            out_props.append(d)
        cap = R.daily_loss_budget(a, self.s.risk) if a else None
        return {
            "now": self.clock.now().isoformat(), "ny_time": self.clock.now().astimezone(NY).strftime("%Y-%m-%d %H:%M:%S"),
            "broker": self.broker.name, "paper": not self.s.is_live_money, "demo": self.broker.name == "sim",
            "market_open": self.market_open, "mode": self.mode, "kill": self.kill,
            "live_auto_locked": self.s.is_live_money and not self.s.allow_live_auto,
            "ai": {"enabled": self.ai.enabled, "model": self.ai.model, "error": self.ai.last_error, "calls": self.ai.calls},
            "account": None if not a else {"equity": round(a.equity, 2), "cash": round(a.cash, 2),
                                           "buying_power": round(a.buying_power, 2), "day_pnl": round(a.day_pnl, 2)},
            "positions": [{"symbol": x.symbol, "qty": x.qty, "avg": round(x.avg_price, 2), "price": round(x.market_price, 2),
                           "pnl": round(x.unrealized_pnl, 2)} for x in self.positions],
            "proposals": out_props,
            "risk": {"entries": self.day.entries, "max_trades": self.s.risk.max_trades_per_day,
                     "realized": round(self.day.realized_pnl, 2), "loss_left": round(cap, 2) if cap is not None else None,
                     "consecutive_losses": self.day.consecutive_losses, "halted": self.day.halted_reason},
            "regime": self.ctx.regime(), "scan": self.orb.last_scan[:25], "news": list(self.news_log)[:25],
            "events": list(self.events)[-60:][::-1], "stats": self.journal.stats(),
            "universe": len(self.ctx.universe), "prepared": str(self.prepared_for) == str(today),
        }

    async def broadcast(self) -> None:
        if not self.listeners:
            return
        snap = self.snapshot()
        for fn in list(self.listeners):
            try:
                await fn(snap)
            except Exception:
                self.listeners.discard(fn)
