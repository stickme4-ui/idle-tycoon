"""Risk manager: position sizing and the hard checks every order must pass.

The rules (and their spirit) follow trader-risk/check.py from the
day-trader-skill pack, plus a daily-loss stop that counts open risk, a
consecutive-loss circuit breaker, a kill switch and an anti-chase check at
the moment of execution.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime, time

from .config import NY, RiskLimits
from .models import Account, Position, Proposal, Side, Status


def hhmm(text: str) -> time:
    h, m = text.split(":")
    return time(int(h), int(m))


@dataclass
class DayState:
    """What happened today, kept by the engine."""
    day: object = None
    entries: int = 0
    consecutive_losses: int = 0
    realized_pnl: float = 0.0
    day_trades: list = field(default_factory=list)   # dates of round trips (for the PDT guard)
    halted_reason: str = ""

    def reset_if_new(self, day) -> None:
        if self.day != day:
            keep = [d for d in self.day_trades if (day - d).days <= 7]
            self.__init__(day=day, day_trades=keep)


def size_position(entry: float, stop: float, account: Account, limits: RiskLimits,
                  open_risk_usd: float = 0.0, exposure_usd: float = 0.0) -> tuple[int, str]:
    """Whole shares so that a stop-out loses at most the per-trade budget. Returns (qty, limiting rule)."""
    per_share = abs(entry - stop)
    if per_share <= 0 or entry <= 0:
        return 0, "stop"
    equity = max(0.0, account.equity)
    budget = min(equity * limits.risk_per_trade_pct / 100, limits.max_risk_per_trade_usd)
    daily_left = daily_loss_budget(account, limits) - open_risk_usd
    reasons = {"risk": budget / per_share}
    reasons["daily_loss"] = max(0.0, daily_left) / per_share
    reasons["position_size"] = equity * limits.max_position_pct / 100 / entry
    exposure_left = equity * limits.max_total_exposure_pct / 100 - exposure_usd
    reasons["exposure"] = max(0.0, exposure_left) / entry
    reasons["buying_power"] = max(0.0, account.buying_power) / entry
    rule = min(reasons, key=reasons.get)
    return max(0, math.floor(reasons[rule])), rule


def daily_loss_budget(account: Account, limits: RiskLimits) -> float:
    """How many dollars may still be lost today before the daily stop."""
    cap = min(limits.max_daily_loss_usd, account.last_equity * limits.max_daily_loss_pct / 100)
    return cap + min(0.0, account.day_pnl)


def entry_window(now: datetime, limits: RiskLimits, close_time: time = time(16, 0)) -> str | None:
    t = now.astimezone(NY).time()
    if now.astimezone(NY).weekday() >= 5:
        return "השוק סגור (סוף שבוע)"
    if t < hhmm(limits.no_entries_before):
        return f"לא נכנסים לפני {limits.no_entries_before}"
    last = min(hhmm(limits.no_entries_after), close_time)
    if t >= last:
        return f"לא נכנסים אחרי {last.strftime('%H:%M')}"
    return None


def check(p: Proposal, price: float, account: Account, positions: list[Position], day: DayState,
          limits: RiskLimits, now: datetime, open_risk_usd: float = 0.0, market_open: bool = True,
          kill_switch: bool = False) -> list[str]:
    """Every reason this exact order may not go now. Empty list = PASS."""
    s, why = p.signal, []
    long = s.side == Side.BUY
    if kill_switch:
        why.append("מתג החירום פעיל")
    if day.halted_reason:
        why.append(f"המסחר נעצר להיום: {day.halted_reason}")
    if not market_open:
        why.append("השוק סגור")
    w = entry_window(now, limits)
    if w:
        why.append(w)
    if s.symbol in limits.blocked_symbols:
        why.append(f"{s.symbol} ברשימה החסומה")
    if not long and not limits.allow_short:
        why.append("מכירה בחסר (שורט) כבויה בהגדרות")
    if p.qty <= 0:
        why.append("כמות 0: התקציב לא מספיק אפילו למניה אחת")
    if price < limits.min_price:
        why.append(f"מחיר מתחת ל-{limits.min_price}$")
    # the stop must be on the right side of the price, and we refuse to chase
    if long and price <= s.stop or not long and price >= s.stop:
        why.append("המחיר כבר עבר את הסטופ")
    risk_ps = s.risk_per_share
    drift = (price - s.entry) if long else (s.entry - price)
    allowed = max(limits.max_entry_drift_r * risk_ps, price * 0.0005)   # at least ~half a spread on liquid names
    if risk_ps > 0 and drift > allowed:
        why.append(f"המחיר ברח {drift:.2f}$ מעבר לכניסה המתוכננת (מעל {limits.max_entry_drift_r:g}R): לא רודפים")
    # the loss at the stop, computed from the price we would really pay
    loss = p.qty * abs(price - s.stop)
    per_trade_cap = min(account.equity * limits.risk_per_trade_pct / 100, limits.max_risk_per_trade_usd)
    if loss > per_trade_cap * 1.05 + 0.5:
        why.append(f"הפסד בסטופ {loss:.0f}$ מעל המותר לעסקה ({per_trade_cap:.0f}$)")
    if loss > daily_loss_budget(account, limits) - open_risk_usd:
        why.append("העסקה תחרוג ממגבלת ההפסד היומית (כולל הסיכון בפוזיציות הפתוחות)")
    if day.entries >= limits.max_trades_per_day:
        why.append(f"הגעת למקסימום {limits.max_trades_per_day} עסקאות היום")
    if day.consecutive_losses >= limits.max_consecutive_losses:
        why.append(f"{day.consecutive_losses} הפסדים ברצף: מפסק הזרם הופעל")
    held = [x for x in positions if x.qty != 0]
    if any(x.symbol == s.symbol for x in held):
        why.append(f"כבר יש פוזיציה ב-{s.symbol}")
    if len(held) >= limits.max_open_positions:
        why.append(f"כבר {len(held)} פוזיציות פתוחות (מקסימום {limits.max_open_positions})")
    notional = p.qty * price
    if notional > account.equity * limits.max_position_pct / 100 * 1.02:
        why.append(f"הפוזיציה {notional:,.0f}$ גדולה מ-{limits.max_position_pct:g}% מההון")
    exposure = sum(abs(x.market_value) for x in held) + notional
    if exposure > account.equity * limits.max_total_exposure_pct / 100 * 1.02:
        why.append("החשיפה הכוללת תעבור את המותר (בלי מרג'ין)")
    if long and notional > account.buying_power:
        why.append("אין מספיק כוח קנייה")
    if limits.pdt_guard and account.equity < 25_000 and len(day.day_trades) >= 3:
        why.append("הגנת PDT: כבר 3 עסקאות יום ב-5 ימי מסחר")
    return why


def open_risk(proposals: list[Proposal]) -> float:
    """Dollars at risk in positions the bot holds (to their stops)."""
    return sum(p.filled_qty * p.signal.risk_per_share for p in proposals if p.status == Status.OPEN)
