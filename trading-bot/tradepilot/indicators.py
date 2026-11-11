"""Indicators. Pure functions, no I/O, easy to test."""
from __future__ import annotations

from collections import defaultdict
from datetime import datetime, time, timedelta
from typing import Iterable, Sequence

from .config import NY
from .models import Bar

OPEN = time(9, 30)


def true_ranges(daily: Sequence[Bar]) -> list[float]:
    out = []
    for i, b in enumerate(daily):
        if i == 0:
            out.append(b.high - b.low)
        else:
            pc = daily[i - 1].close
            out.append(max(b.high - b.low, abs(b.high - pc), abs(b.low - pc)))
    return out


def atr(daily: Sequence[Bar], n: int = 14) -> float | None:
    """Simple average of the last n true ranges (the paper's 14-day ATR)."""
    if len(daily) < n + 1:
        return None
    return sum(true_ranges(daily)[-n:]) / n


def avg_volume(daily: Sequence[Bar], n: int = 14) -> float | None:
    if len(daily) < n:
        return None
    return sum(b.volume for b in daily[-n:]) / n


def rsi(closes: Sequence[float], n: int = 14) -> float | None:
    """Wilder's RSI."""
    if len(closes) < n + 1:
        return None
    gains = [max(0.0, closes[i] - closes[i - 1]) for i in range(1, len(closes))]
    losses = [max(0.0, closes[i - 1] - closes[i]) for i in range(1, len(closes))]
    ag, al = sum(gains[:n]) / n, sum(losses[:n]) / n
    for i in range(n, len(gains)):
        ag = (ag * (n - 1) + gains[i]) / n
        al = (al * (n - 1) + losses[i]) / n
    return 100.0 if al == 0 else 100 - 100 / (1 + ag / al)


def session_vwap(bars: Iterable[Bar]) -> float | None:
    pv = vol = 0.0
    for b in bars:
        typical = b.vwap if b.vwap else (b.high + b.low + b.close) / 3
        pv += typical * b.volume
        vol += b.volume
    return pv / vol if vol else None


def ny(ts: datetime) -> datetime:
    return ts.astimezone(NY)


def session_bars(bars: Iterable[Bar], day) -> list[Bar]:
    """Regular-session bars (9:30-16:00 NY) of one day, in time order."""
    out = [b for b in bars if ny(b.ts).date() == day and time(9, 30) <= ny(b.ts).time() < time(16, 0)]
    return sorted(out, key=lambda b: b.ts)


def opening_range(bars: Sequence[Bar], minutes: int, bar_minutes: int | None = None) -> Bar | None:
    """Combine the bars that START inside the first `minutes` of the session into one bar.
    Returns None unless the window is complete."""
    if not bars:
        return None
    day = ny(bars[0].ts).date()
    start = datetime.combine(day, OPEN, NY)
    end = start + timedelta(minutes=minutes)
    inside = [b for b in bars if start <= ny(b.ts) < end]
    if not inside:
        return None
    step = timedelta(minutes=bar_minutes) if bar_minutes else _step(bars)
    if ny(inside[-1].ts) + step < end:     # window not finished (or data missing)
        return None
    return Bar(
        symbol=inside[0].symbol, ts=inside[0].ts, open=inside[0].open,
        high=max(b.high for b in inside), low=min(b.low for b in inside), close=inside[-1].close,
        volume=sum(b.volume for b in inside),
    )


def _step(bars: Sequence[Bar]) -> timedelta:
    if len(bars) >= 2:
        d = min(abs(bars[i + 1].ts - bars[i].ts) for i in range(min(len(bars) - 1, 5)))
        if d > timedelta(0):
            return d
    return timedelta(minutes=1)


def avg_opening_volume(intraday: Iterable[Bar], minutes: int, before_day, n: int = 14,
                       bar_minutes: int | None = None) -> float | None:
    """Average volume of the first `minutes` of each of the last n sessions before `before_day`."""
    by_day: dict = defaultdict(list)
    for b in intraday:
        d = ny(b.ts).date()
        if d < before_day:
            by_day[d].append(b)
    vols = []
    for d in sorted(by_day)[-n:]:
        orb = opening_range(sorted(by_day[d], key=lambda b: b.ts), minutes, bar_minutes)
        if orb is not None:
            vols.append(orb.volume)
    if len(vols) < max(5, n // 2):
        return None
    return sum(vols) / len(vols)


def aggregate(bars: Sequence[Bar], minutes: int) -> list[Bar]:
    """1-minute bars -> N-minute bars aligned to the session open."""
    groups: dict = defaultdict(list)
    for b in bars:
        t = ny(b.ts)
        start = datetime.combine(t.date(), OPEN, NY)
        k = int((t - start).total_seconds() // (minutes * 60))
        groups[(t.date(), k)].append(b)
    out = []
    for key in sorted(groups):
        g = sorted(groups[key], key=lambda b: b.ts)
        day, k = key
        ts = datetime.combine(day, OPEN, NY) + timedelta(minutes=k * minutes)
        out.append(Bar(g[0].symbol, ts, g[0].open, max(b.high for b in g), min(b.low for b in g), g[-1].close,
                       sum(b.volume for b in g)))
    return out
