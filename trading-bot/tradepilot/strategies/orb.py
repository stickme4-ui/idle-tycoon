"""Opening-range breakout on Stocks in Play.

Based on Zarattini, Barbon & Aziz, "A Profitable Day Trading Strategy For The
U.S. Equity Market" (2024), the variant they report the strongest results for:

  * Universe: price > $5, 14-day average volume >= 1M shares, 14-day ATR >= $0.50.
  * Stocks in Play: opening-range volume / its 14-day average (relative volume)
    >= 100 %, and only the top 20 by relative volume.
  * Direction from the first 5-minute candle: green -> long above its high,
    red -> short below its low, doji -> no trade.
  * Stop 10 % of the 14-day ATR away from the entry. No target: out at the close.

A backtest is not a promise: the paper covers 2016-2023, before costs that
real traders pay in full. Run the backtester on recent data before using it.
"""
from __future__ import annotations

from datetime import datetime, timedelta

from .. import indicators as ind
from ..config import OrbConfig, RiskLimits
from ..market import MarketContext
from ..models import Side, Signal


def orb_signal(sym: str, orb, stats, cfg: OrbConfig, rvol: float, rank: int, regime: dict | None = None) -> Signal | None:
    """The trade for one stock, or None (doji or no ATR)."""
    if stats.atr is None or orb.close == orb.open:
        return None
    long = orb.close > orb.open
    entry = round(orb.high + 0.01 if long else orb.low - 0.01, 2)
    dist = max(0.02, cfg.stop_atr_frac * stats.atr)
    stop = round(entry - dist if long else entry + dist, 2)
    target = None
    if cfg.target_r:
        target = round(entry + cfg.target_r * dist if long else entry - cfg.target_r * dist, 2)
    side = Side.BUY if long else Side.SELL
    word = "פריצה מעלה" if long else "שבירה מטה"
    why = (f"Stock in Play: נפח {cfg.or_minutes} הדקות הראשונות היה פי {rvol:.1f} מהממוצע "
           f"(דירוג {rank} מתוך המניות הפעילות). הנר הראשון {'ירוק' if long else 'אדום'}, "
           f"ולכן {word} של טווח הפתיחה ב-{entry}. סטופ {cfg.stop_atr_frac:.0%} מה-ATR "
           f"({stats.atr:.2f}$), יציאה {'ביעד ' + str(target) if target else 'בסוף היום'}.")
    return Signal(
        symbol=sym, strategy="orb", side=side, entry=entry, stop=stop, target=target, trigger="stop",
        features={"rvol": round(rvol, 2), "rvol_rank": rank, "atr": round(stats.atr, 2),
                  "or_high": round(orb.high, 2), "or_low": round(orb.low, 2), "or_open": round(orb.open, 2),
                  "or_close": round(orb.close, 2), "or_range_atr": round((orb.high - orb.low) / stats.atr, 2),
                  "avg_volume": round(stats.avg_volume or 0), "regime": (regime or {}).get("tone")},
        why_he=why,
    )


class OrbStrategy:
    name = "orb"

    def __init__(self, cfg: OrbConfig, risk: RiskLimits):
        self.cfg, self.risk = cfg, risk
        self.done_for = None
        self.last_scan: list = []     # what the scan saw, for the dashboard

    def eligible(self, ctx: MarketContext, sym: str) -> bool:
        st = ctx.stats.get(sym)
        if not st or st.atr is None or st.avg_volume is None or st.avg_or_volume is None:
            return False
        price = st.prev_close or 0
        return (price >= max(self.risk.min_price, 0.01) and st.avg_volume >= self.cfg.min_avg_volume
                and st.atr >= self.cfg.min_atr and sym not in self.risk.blocked_symbols)

    def on_clock(self, ctx: MarketContext) -> list[Signal]:
        if not self.cfg.enabled or self.done_for == ctx.today:
            return []
        ready = ctx.session_open() + timedelta(minutes=self.cfg.or_minutes)
        if ctx.now < ready:
            return []
        if ctx.now > ready + timedelta(minutes=20):      # too late to call it an opening-range breakout
            self.done_for = ctx.today
            return []
        rows = []
        missing = 0
        for sym in ctx.universe:
            if sym in ("SPY", "QQQ") or not self.eligible(ctx, sym):
                continue
            orb = ind.opening_range(ctx.session(sym), self.cfg.or_minutes)
            if orb is None:
                missing += 1
                continue
            rvol = orb.volume / ctx.stats[sym].avg_or_volume
            rows.append((sym, orb, rvol))
        # wait up to 2 minutes for late data before ranking
        if missing and ctx.now < ready + timedelta(minutes=2) and missing > 0.2 * (missing + len(rows)):
            return []
        self.done_for = ctx.today
        rows.sort(key=lambda r: r[2], reverse=True)
        in_play = [r for r in rows if r[2] >= self.cfg.min_rvol][: self.cfg.top_n]
        self.last_scan = [{"symbol": s, "rvol": round(rv, 2), "in_play": (s, o, rv) in in_play} for s, o, rv in rows[:50]]
        regime = ctx.regime()
        out = []
        for rank, (sym, orb, rvol) in enumerate(in_play, 1):
            sig = orb_signal(sym, orb, ctx.stats[sym], self.cfg, rvol, rank, regime)
            if sig is None:
                continue
            if sig.side == Side.SELL and not self.risk.allow_short:
                continue
            out.append(sig)
        return out

    def on_news(self, item, analysis, ctx) -> list[Signal]:
        return []
