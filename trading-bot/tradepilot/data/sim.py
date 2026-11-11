"""Demo market: a synthetic, seeded stock market with "stocks in play" and headlines.

Nothing here is real data. It exists so you can see and practise the whole
flow (scan -> proposal -> click -> fill -> stop/exit) without any account.
Ticker names are made up on purpose.
"""
from __future__ import annotations

import asyncio
import math
import random
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone

from ..config import NY
from ..models import Bar, NewsItem

NAMES = ["ALFX", "BRVN", "CRLX", "DLTA", "ECHX", "FXTR", "GLFR", "HTLX", "INDG", "JLTX", "KILO", "LMRX",
         "MKRO", "NVMB", "OSCR", "PAPX", "QBCK", "ROMX", "SRRA", "TNGO", "UNFX", "VCTR", "WSKY", "XRAY",
         "YNKE", "ZULX", "AERO", "BOLT", "CYGN", "DYNX", "EMBR", "FLUX", "GRVT", "HELX", "IONQX", "JADE"]


def ushape(minute: int) -> float:
    """Relative volume by minute of the session (0..389): heavy at the open and close."""
    x = minute / 389
    return 0.55 + 2.6 * math.exp(-x * 14) + 0.9 * math.exp(-(1 - x) * 12)


@dataclass
class _Sym:
    name: str
    price: float
    daily_vol: float     # daily return stdev
    avg_volume: float


@dataclass
class _Day:
    drift: float         # per-minute drift
    vol_mult: float      # volume multiplier for the day
    vola_mult: float     # volatility multiplier
    news_minute: int | None = None
    news_good: bool = True


def trading_days_before(d: date, n: int) -> list[date]:
    out, x = [], d
    while len(out) < n:
        x -= timedelta(days=1)
        if x.weekday() < 5:
            out.append(x)
    return sorted(out)


class SimMarket:
    def __init__(self, seed: int = 7, n_symbols: int = 30):
        self.rng = random.Random(seed)
        r = self.rng
        self.syms = {"SPY": _Sym("SPY", 580.0, 0.009, 60e6), "QQQ": _Sym("QQQ", 500.0, 0.012, 40e6)}
        for name in NAMES[:n_symbols]:
            self.syms[name] = _Sym(name, round(r.uniform(8, 300), 2), r.uniform(0.018, 0.05), r.uniform(1.2e6, 25e6))

    def symbols(self) -> list[str]:
        return list(self.syms)

    # ---- history ----
    def history(self, today: date, or_minutes: int = 5, days: int = 30) -> tuple[dict, dict]:
        """Synthetic past sessions, generated once; days played in the demo are appended by record_day."""
        if getattr(self, "_hist", None):
            return self._hist
        daily, intraday = {}, {}
        for s in self.syms.values():
            px = s.price
            dl, il = [], []
            for d in trading_days_before(today, days):
                ret = self.rng.gauss(0, s.daily_vol)
                o = px
                c = max(1.0, px * (1 + ret))
                rng = abs(self.rng.gauss(0, s.daily_vol)) * px + abs(c - o)
                h, l = max(o, c) + rng * 0.4, min(o, c) - rng * 0.4
                vol = s.avg_volume * self.rng.lognormvariate(0, 0.3)
                ts = datetime.combine(d, time(9, 30), NY)
                dl.append(Bar(s.name, ts, o, h, max(0.5, l), c, vol))
                share = sum(ushape(m) for m in range(or_minutes)) / sum(ushape(m) for m in range(390))
                for m in range(or_minutes):
                    v = vol * share / or_minutes * self.rng.lognormvariate(0, 0.2)
                    il.append(Bar(s.name, ts + timedelta(minutes=m), o, o, o, o, v))
                px = c
            s.price = round(px, 2)
            daily[s.name], intraday[s.name] = dl, il
        self._hist = (daily, intraday)
        return self._hist

    def record_day(self, sym: str, bars: list, or_minutes: int = 5) -> None:
        if not bars or not getattr(self, "_hist", None):
            return
        daily, intraday = self._hist
        daily.setdefault(sym, []).append(Bar(sym, bars[0].ts, bars[0].open, max(b.high for b in bars),
                                             min(b.low for b in bars), bars[-1].close, sum(b.volume for b in bars)))
        intraday.setdefault(sym, []).extend(bars[:or_minutes])

    # ---- one session ----
    def plan_day(self) -> dict:
        r = self.rng
        market = r.gauss(0, 0.000015)
        plan = {}
        for s in self.syms.values():
            in_play = s.name not in ("SPY", "QQQ") and r.random() < 0.25
            if in_play:
                direction = 1 if r.random() < 0.55 else -1
                plan[s.name] = _Day(drift=direction * r.uniform(0.0, 0.00012) + market,
                                    vol_mult=r.uniform(2.0, 6.0), vola_mult=r.uniform(1.3, 2.2),
                                    news_minute=r.choice([None, r.randint(-30, 200)]), news_good=direction > 0)
            else:
                plan[s.name] = _Day(drift=market * (1.2 if s.name == "QQQ" else 1.0) + r.gauss(0, 0.00001),
                                    vol_mult=r.uniform(0.6, 1.3), vola_mult=r.uniform(0.8, 1.2))
        return plan

    def minute_bar(self, sym: str, d: _Day, ts: datetime, minute: int) -> Bar:
        s = self.syms[sym]
        r = self.rng
        sigma = s.daily_vol / math.sqrt(390) * d.vola_mult * math.sqrt(ushape(minute) / 1.2)
        o = s.price
        steps = [r.gauss(d.drift / 4, sigma / 2) for _ in range(4)]
        path = [o]
        for x in steps:
            path.append(path[-1] * (1 + x))
        c = max(0.5, path[-1])
        h, l = max(path) * (1 + abs(r.gauss(0, sigma / 4))), min(path) * (1 - abs(r.gauss(0, sigma / 4)))
        vol = s.avg_volume / 390 * ushape(minute) / 1.21 * d.vol_mult * r.lognormvariate(0, 0.35)
        s.price = round(c, 2)
        self.last_path = [round(x, 2) for x in path[1:]]
        return Bar(sym, ts, round(o, 2), round(h, 2), round(max(0.5, l), 2), round(c, 2), round(vol))

    def headline(self, sym: str, good: bool, ts: datetime, idx: int) -> NewsItem:
        good_h = [f"{sym} beats quarterly earnings estimates and raises full-year guidance",
                  f"{sym} wins major multi-year government contract",
                  f"{sym} receives FDA approval for lead product"]
        bad_h = [f"{sym} misses revenue estimates, cuts guidance",
                 f"{sym} announces secondary stock offering",
                 f"{sym} shares fall after regulator opens investigation"]
        h = self.rng.choice(good_h if good else bad_h)
        return NewsItem(id=f"SIMNEWS{idx}", ts=ts, headline=h, summary="(Demo headline, not real news.)",
                        symbols=[sym], source="demo")


class SimFeed:
    """Drives the demo: advances a SimClock minute by minute and pushes bars and headlines to the engine."""
    live = False

    def __init__(self, clock, broker, speed: float = 60.0, seed: int = 7, start_day: date | None = None):
        self.clock, self.broker, self.speed = clock, broker, speed
        self.market = SimMarket(seed)
        self.day = start_day or self._next_weekday(datetime.now(timezone.utc).astimezone(NY).date())
        self.task: asyncio.Task | None = None
        self.news_idx = 0
        self.paused = False

    @staticmethod
    def _next_weekday(d: date) -> date:
        while d.weekday() >= 5:
            d += timedelta(days=1)
        return d

    async def universe(self, size: int, watchlist: list) -> list[str]:
        return self.market.symbols()[:size]

    async def history(self, symbols: list, today: date, or_minutes: int, lookback: int):
        return self.market.history(today, or_minutes, max(30, lookback + 5))

    async def backfill_today(self, symbols, now) -> list[Bar]:
        return []

    async def recent_news(self, symbols, since) -> list[NewsItem]:
        return []

    async def watch_prices(self, symbols) -> None:
        return None

    async def start(self, engine) -> None:
        self.task = asyncio.create_task(self._run(engine))

    async def stop(self) -> None:
        if self.task:
            self.task.cancel()

    async def _sleep_minute(self):
        await asyncio.sleep(60.0 / max(0.1, self.speed))
        while self.paused:
            await asyncio.sleep(0.2)

    async def _run(self, engine) -> None:
        while True:
            day = self.day
            open_dt = datetime.combine(day, time(9, 30), NY)
            self.clock.set(open_dt - timedelta(minutes=6))
            self.broker.is_open = False
            await engine.prepare_day()
            plan = self.market.plan_day()
            for sym, d in plan.items():   # pre-market headlines
                if d.news_minute is not None and d.news_minute < 0:
                    self.news_idx += 1
                    await engine.on_news(self.market.headline(sym, d.news_good, open_dt + timedelta(minutes=d.news_minute), self.news_idx))
            for _ in range(5):
                self.clock.set(self.clock.now() + timedelta(minutes=1))
                await engine.tick()
                await self._sleep_minute()
            self.broker.is_open = True
            today_bars: dict = {s: [] for s in plan}
            for m in range(390):
                ts = open_dt + timedelta(minutes=m)
                self.clock.set(ts + timedelta(minutes=1))
                self.broker.now = self.clock.now()
                for sym, d in plan.items():
                    bar = self.market.minute_bar(sym, d, ts, m)
                    today_bars[sym].append(bar)
                    for px in self.market.last_path[:-1]:   # intra-minute ticks, so triggers fill near the level
                        self.broker.on_tick(sym, px)
                        await engine.on_price(sym, px)
                    self.broker.on_bar(bar)
                    await engine.on_bar(bar)
                    if d.news_minute == m:
                        self.news_idx += 1
                        await engine.on_news(self.market.headline(sym, d.news_good, self.clock.now(), self.news_idx))
                await engine.tick()
                await self._sleep_minute()
            self.broker.is_open = False
            self.clock.set(open_dt + timedelta(hours=7))
            await engine.tick()
            await engine.end_day()
            for sym, bars in today_bars.items():
                self.market.record_day(sym, bars)
            await asyncio.sleep(max(1.0, 30 / max(0.1, self.speed)))
            self.day = self._next_weekday(day + timedelta(days=1))
            self.broker.new_day()
