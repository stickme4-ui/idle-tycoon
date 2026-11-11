from datetime import date, datetime, time, timedelta

from tradepilot.config import NY
from tradepilot.models import Bar


def mk(sym, d: date, hh, mm, o, h, l, c, v=1000.0):
    return Bar(sym, datetime.combine(d, time(hh, mm), NY), o, h, l, c, v)


def daily_series(sym, end: date, n=20, price=50.0, rng=2.0, vol=2_000_000):
    out, d = [], end
    days = []
    while len(days) < n:
        d -= timedelta(days=1)
        if d.weekday() < 5:
            days.append(d)
    for dd in sorted(days):
        out.append(Bar(sym, datetime.combine(dd, time(9, 30), NY), price, price + rng / 2, price - rng / 2, price, vol))
    return out


def opening_history(sym, end: date, n=14, vol_per_min=10_000):
    out, d, k = [], end, 0
    while k < n:
        d -= timedelta(days=1)
        if d.weekday() >= 5:
            continue
        k += 1
        for m in range(5):
            out.append(mk(sym, d, 9, 30 + m, 50, 50, 50, 50, vol_per_min))
    return out
