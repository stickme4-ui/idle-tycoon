"""MarketContext: everything the strategies may look at, in one place."""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta

from . import indicators as ind
from .config import NY
from .models import Bar, NewsAnalysis, NewsItem


@dataclass
class SymbolStats:
    symbol: str
    atr: float | None
    avg_volume: float | None
    avg_or_volume: float | None   # average opening-range volume over the lookback
    prev_close: float | None


@dataclass
class MarketContext:
    now: datetime
    universe: list = field(default_factory=list)
    stats: dict = field(default_factory=dict)                         # sym -> SymbolStats
    bars: dict = field(default_factory=lambda: defaultdict(list))     # sym -> today's 1-min bars
    news: dict = field(default_factory=lambda: defaultdict(list))     # sym -> [(NewsItem, NewsAnalysis)]
    last_price: dict = field(default_factory=dict)

    @property
    def today(self) -> date:
        return self.now.astimezone(NY).date()

    def session_open(self) -> datetime:
        return datetime.combine(self.today, time(9, 30), NY)

    def add_bar(self, bar: Bar) -> None:
        lst = self.bars[bar.symbol]
        if lst and lst[-1].ts == bar.ts:
            lst[-1] = bar             # an updated bar replaces the earlier copy
        elif not lst or lst[-1].ts < bar.ts:
            lst.append(bar)
        else:                         # out of order: insert and keep sorted
            lst.append(bar)
            lst.sort(key=lambda b: b.ts)
        self.last_price[bar.symbol] = bar.close

    def add_news(self, item: NewsItem, analysis: NewsAnalysis) -> None:
        for s in item.symbols:
            self.news[s].append((item, analysis))

    def session(self, sym: str) -> list[Bar]:
        return ind.session_bars(self.bars.get(sym, []), self.today)

    def vwap(self, sym: str) -> float | None:
        return ind.session_vwap(self.session(sym))

    def rvol_so_far(self, sym: str) -> float | None:
        """Today's volume so far vs. the typical volume by this time of day.
        Intraday volume is U-shaped; we use a simple shape: 30 % of the day's
        volume trades in the first hour, 20 % in the last hour, the rest evenly."""
        st = self.stats.get(sym)
        bars = self.session(sym)
        if not st or not st.avg_volume or not bars:
            return None
        mins = (self.now.astimezone(NY) - self.session_open()).total_seconds() / 60
        mins = max(1.0, min(390.0, mins))
        if mins <= 60:
            frac = 0.30 * mins / 60
        elif mins <= 330:
            frac = 0.30 + 0.50 * (mins - 60) / 270
        else:
            frac = 0.80 + 0.20 * (mins - 330) / 60
        return sum(b.volume for b in bars) / (st.avg_volume * frac)

    def recent_news(self, sym: str, minutes: int = 24 * 60) -> list:
        cutoff = self.now - timedelta(minutes=minutes)
        return [(i, a) for i, a in self.news.get(sym, []) if i.ts >= cutoff]

    def regime(self) -> dict:
        """Broad market tone from SPY: above or below its session VWAP, and today's change."""
        sym = "SPY"
        price, vwap = self.last_price.get(sym), self.vwap(sym)
        st = self.stats.get(sym)
        if price is None or vwap is None:
            return {"tone": "unknown", "spy": price, "spy_vwap": vwap, "spy_change_pct": None}
        chg = (price / st.prev_close - 1) * 100 if st and st.prev_close else None
        tone = "risk_on" if price > vwap * 1.0005 else "risk_off" if price < vwap * 0.9995 else "flat"
        return {"tone": tone, "spy": round(price, 2), "spy_vwap": round(vwap, 2),
                "spy_change_pct": round(chg, 2) if chg is not None else None}


def build_stats(symbol: str, daily: list[Bar], intraday: list[Bar], today: date, or_minutes: int,
                lookback: int, bar_minutes: int | None = None) -> SymbolStats:
    past = [b for b in daily if ind.ny(b.ts).date() < today]
    return SymbolStats(
        symbol=symbol,
        atr=ind.atr(past, lookback),
        avg_volume=ind.avg_volume(past, lookback),
        avg_or_volume=ind.avg_opening_volume(intraday, or_minutes, today, lookback, bar_minutes),
        prev_close=past[-1].close if past else None,
    )
