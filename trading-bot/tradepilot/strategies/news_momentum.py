"""Experimental: trade a strong headline when the price agrees with it.

Idea from Lopez-Lira & Tang, "Can ChatGPT Forecast Stock Price Movements?"
(revised 2025): large language models read the direction of a headline well,
and some of the move continues. They also find the edge shrinking as more
people use LLMs, and strongest in small stocks. So this strategy demands a
material headline, a price above (below) VWAP, and heavy volume. It is off in
auto mode by default: prove it in paper trading first.
"""
from __future__ import annotations

from datetime import timedelta

from ..config import NewsMomentumConfig, RiskLimits
from ..market import MarketContext
from ..models import NewsAnalysis, NewsItem, Side, Signal


class NewsMomentumStrategy:
    name = "news"

    def __init__(self, cfg: NewsMomentumConfig, risk: RiskLimits):
        self.cfg, self.risk = cfg, risk
        self.fired: set = set()

    def on_clock(self, ctx: MarketContext) -> list[Signal]:
        return []

    def on_news(self, item: NewsItem, a: NewsAnalysis, ctx: MarketContext) -> list[Signal]:
        c = self.cfg
        if not c.enabled or ctx.now - item.ts > timedelta(minutes=c.max_age_minutes):
            return []
        if a.materiality < c.min_materiality or abs(a.sentiment) < c.min_abs_sentiment or a.direction == "unclear":
            return []
        out = []
        for sym in item.symbols:
            key = (ctx.today, sym)
            st = ctx.stats.get(sym)
            price = ctx.last_price.get(sym)
            vwap = ctx.vwap(sym)
            rvol = ctx.rvol_so_far(sym)
            if key in self.fired or not st or not st.atr or price is None or vwap is None or rvol is None:
                continue
            if price < self.risk.min_price or sym in self.risk.blocked_symbols or rvol < c.min_rvol:
                continue
            long = a.sentiment > 0 and a.direction == "up"
            short = a.sentiment < 0 and a.direction == "down"
            if long and price <= vwap or short and price >= vwap or not (long or short):
                continue
            if short and not self.risk.allow_short:
                continue
            dist = max(0.02, c.stop_atr_frac * st.atr)
            entry = round(price, 2)
            stop = round(entry - dist if long else entry + dist, 2)
            target = round(entry + c.target_r * dist if long else entry - c.target_r * dist, 2)
            self.fired.add(key)
            out.append(Signal(
                symbol=sym, strategy="news", side=Side.BUY if long else Side.SELL, entry=entry, stop=stop,
                target=target, trigger="market",
                features={"sentiment": a.sentiment, "materiality": a.materiality, "catalyst": a.catalyst,
                          "rvol": round(rvol, 2), "vwap": round(vwap, 2), "atr": round(st.atr, 2),
                          "regime": ctx.regime().get("tone")},
                why_he=(f"חדשה מהותית ({a.catalyst}): {a.summary_he} המחיר {'מעל' if long else 'מתחת'} "
                        f"ל-VWAP ({vwap:.2f}) והנפח פי {rvol:.1f} מהרגיל. יעד {c.target_r:g}R, סטופ "
                        f"{c.stop_atr_frac:.0%} מה-ATR."),
            ))
        return out
