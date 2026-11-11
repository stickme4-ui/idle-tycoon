"""Backtest the ORB / Stocks-in-Play strategy on history, with costs.

    python -m tradepilot.backtest --source demo --days 120
    python -m tradepilot.backtest --source alpaca --start 2025-06-01 --end 2026-10-31 \
        --symbols-file my_universe.txt            # needs ALPACA keys in .env

What it does honestly:
  * the same signal code as the live bot (strategies/orb.py: orb_signal);
  * 5-minute bars: if the stop and the entry fall in the same bar, it counts
    the stop (conservative); a gap through a level fills at the bar's open;
  * slippage on every fill and a per-share commission;
  * position size = risk % of equity at the stop, capped by position size and
    leverage, like the live risk manager;
  * a Monte-Carlo resampling of the trading days for the range of outcomes,
    and the first half vs. the second half of the period, to see if the edge is stable.
What it cannot do: know the future, model halts, borrow costs for shorts,
or the real queue at the open. Treat results as an upper bound.
"""
from __future__ import annotations

import argparse
import gzip
import json
import math
import random
import statistics
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta
from pathlib import Path

from . import indicators as ind
from .config import NY, ROOT, OrbConfig
from .market import build_stats
from .models import Bar, Side
from .strategies.orb import orb_signal


@dataclass
class BTConfig:
    orb: OrbConfig = field(default_factory=OrbConfig)
    start_equity: float = 25_000.0
    risk_pct: float = 1.0               # the paper risks 1 % per trade
    max_leverage: float = 1.0           # 1 = cash account; the paper allows 4x
    max_position_pct: float = 25.0
    slippage_bps: float = 2.0
    commission_per_share: float = 0.0035
    allow_short: bool = True
    exit_time: time = time(15, 55)
    bar_minutes: int = 5


@dataclass
class Trade:
    day: date
    symbol: str
    side: str
    entry: float
    stop: float
    qty: int
    fill: float
    exit: float
    reason: str
    pnl: float
    r: float
    rvol: float


def _day_bars(intraday: list[Bar]) -> dict:
    by = defaultdict(list)
    for b in intraday:
        t = ind.ny(b.ts)
        if time(9, 30) <= t.time() < time(16, 0):
            by[t.date()].append(b)
    return {d: sorted(v, key=lambda b: b.ts) for d, v in by.items()}


def simulate_trade(sig, bars: list[Bar], start_idx: int, cfg: BTConfig) -> tuple | None:
    """Walk the bars after the opening range. Returns (fill, exit, reason) or None if never triggered."""
    long = sig.side == Side.BUY
    slip = cfg.slippage_bps / 10_000
    fill = None
    entry_bar = -1
    for i in range(start_idx, len(bars)):
        b = bars[i]
        t = ind.ny(b.ts).time()
        bar_end = (datetime.combine(date(2000, 1, 1), t) + timedelta(minutes=cfg.bar_minutes)).time()
        if fill is None:
            if bar_end > time(15, 30):            # no new entries late in the day
                return None
            hit = b.high >= sig.entry if long else b.low <= sig.entry
            if not hit:
                continue
            px = max(sig.entry, b.open) if long else min(sig.entry, b.open)
            fill = px * (1 + slip) if long else px * (1 - slip)
            entry_bar = i
            if (long and fill <= sig.stop) or (not long and fill >= sig.stop):
                return None                         # gapped through the stop before we got in
        # same bar as the entry counts too (conservative)
        stop_hit = b.low <= sig.stop if long else b.high >= sig.stop
        tgt_hit = sig.target is not None and (b.high >= sig.target if long else b.low <= sig.target)
        if stop_hit:
            if i == entry_bar:
                px = sig.stop                                                # the open was before our entry
            else:
                px = min(sig.stop, b.open) if long else max(sig.stop, b.open)   # a gap fills worse than the stop
            return fill, px * (1 - slip) if long else px * (1 + slip), "stop"
        if tgt_hit:
            return fill, sig.target, "target"
        if bar_end >= cfg.exit_time:
            px = b.close
            return fill, px * (1 - slip) if long else px * (1 + slip), "close"
    if fill is not None:
        px = bars[-1].close
        return fill, px * (1 - slip) if long else px * (1 + slip), "close"
    return None


def run(daily: dict, intraday: dict, cfg: BTConfig, start: date | None = None, end: date | None = None) -> dict:
    days_by_sym = {s: _day_bars(v) for s, v in intraday.items()}
    all_days = sorted({d for m in days_by_sym.values() for d in m})
    if start:
        all_days = [d for d in all_days if d >= start]
    if end:
        all_days = [d for d in all_days if d <= end]
    equity = cfg.start_equity
    trades: list[Trade] = []
    curve = []
    o = cfg.orb
    n_or = max(1, o.or_minutes // cfg.bar_minutes)
    for d in all_days:
        rows = []
        for sym, by_day in days_by_sym.items():
            if sym in ("SPY", "QQQ") or d not in by_day:
                continue
            past_intraday = [b for dd, bars in by_day.items() if dd < d and (d - dd).days < 40 for b in bars[:n_or]]
            st = build_stats(sym, daily.get(sym, []), past_intraday, d, o.or_minutes, o.lookback_days, cfg.bar_minutes)
            if not st.atr or not st.avg_volume or not st.avg_or_volume or not st.prev_close:
                continue
            if st.prev_close < 5 or st.avg_volume < o.min_avg_volume or st.atr < o.min_atr:
                continue
            orb = ind.opening_range(by_day[d], o.or_minutes, cfg.bar_minutes)
            if orb is None:
                continue
            rows.append((sym, orb, orb.volume / st.avg_or_volume, st))
        rows.sort(key=lambda r: r[2], reverse=True)
        in_play = [r for r in rows if r[2] >= o.min_rvol][: o.top_n]
        day_pnl = used_notional = 0.0
        day_equity = equity
        for rank, (sym, orb, rvol, st) in enumerate(in_play, 1):
            sig = orb_signal(sym, orb, st, o, rvol, rank)
            if sig is None or (sig.side == Side.SELL and not cfg.allow_short):
                continue
            res = simulate_trade(sig, by_day_for(days_by_sym, sym, d), n_or, cfg)
            if res is None:
                continue
            fill, exit_px, reason = res
            risk_ps = abs(fill - sig.stop)
            if risk_ps <= 0:
                continue
            room = day_equity * cfg.max_leverage - used_notional
            qty = math.floor(min(day_equity * cfg.risk_pct / 100 / risk_ps,
                                 day_equity * cfg.max_position_pct / 100 / fill,
                                 max(0.0, room) / fill))
            if qty <= 0:
                continue
            used_notional += qty * fill
            sign = 1 if sig.side == Side.BUY else -1
            pnl = (exit_px - fill) * qty * sign - 2 * cfg.commission_per_share * qty
            trades.append(Trade(d, sym, sig.side.value, sig.entry, sig.stop, qty, round(fill, 4), round(exit_px, 4),
                                reason, round(pnl, 2), round((exit_px - fill) * sign / risk_ps, 3), round(rvol, 2)))
            day_pnl += pnl
        equity += day_pnl
        curve.append((d, equity))
    return report(trades, curve, cfg)


def by_day_for(days_by_sym, sym, d):
    return days_by_sym[sym][d]


def max_drawdown(values: list[float]) -> float:
    peak, mdd = -1e18, 0.0
    for v in values:
        peak = max(peak, v)
        mdd = max(mdd, (peak - v) / peak if peak > 0 else 0)
    return mdd


def report(trades: list[Trade], curve: list, cfg: BTConfig, seed: int = 11) -> dict:
    if not curve:
        return {"trades": 0, "note": "no data"}
    eq = [cfg.start_equity] + [v for _, v in curve]
    rets = [eq[i] / eq[i - 1] - 1 for i in range(1, len(eq))]
    wins = [t.pnl for t in trades if t.pnl > 0]
    losses = [t.pnl for t in trades if t.pnl <= 0]
    years = max(1 / 252, len(curve) / 252)
    total = eq[-1] / eq[0] - 1
    sd = statistics.pstdev(rets) if len(rets) > 1 else 0
    sharpe = (statistics.mean(rets) / sd * math.sqrt(252)) if sd > 0 else None
    # Monte Carlo: resample trading days with replacement
    rng = random.Random(seed)
    sims_ret, sims_dd = [], []
    for _ in range(2000):
        e, path = 1.0, [1.0]
        for _ in range(len(rets)):
            e *= 1 + rng.choice(rets)
            path.append(e)
        sims_ret.append(e - 1)
        sims_dd.append(max_drawdown(path))
    sims_ret.sort(), sims_dd.sort()
    q = lambda a, p: a[min(len(a) - 1, int(p * len(a)))]
    half = len(trades) // 2
    first, second = trades[:half], trades[half:]
    by_reason = defaultdict(int)
    for t in trades:
        by_reason[t.reason] += 1
    return {
        "days": len(curve), "trades": len(trades),
        "win_rate_pct": round(len(wins) / len(trades) * 100, 1) if trades else None,
        "avg_R": round(statistics.mean(t.r for t in trades), 3) if trades else None,
        "profit_factor": round(sum(wins) / -sum(losses), 2) if losses and sum(losses) < 0 else None,
        "total_return_pct": round(total * 100, 2),
        "cagr_pct": round(((1 + total) ** (1 / years) - 1) * 100, 2) if total > -1 else -100.0,
        "max_drawdown_pct": round(max_drawdown(eq) * 100, 2),
        "sharpe": round(sharpe, 2) if sharpe is not None else None,
        "exits": dict(by_reason),
        "first_half_avg_R": round(statistics.mean(t.r for t in first), 3) if first else None,
        "second_half_avg_R": round(statistics.mean(t.r for t in second), 3) if second else None,
        "monte_carlo": {"return_pct_p5": round(q(sims_ret, .05) * 100, 1), "return_pct_p50": round(q(sims_ret, .5) * 100, 1),
                        "return_pct_p95": round(q(sims_ret, .95) * 100, 1), "max_dd_pct_p50": round(q(sims_dd, .5) * 100, 1),
                        "max_dd_pct_p95": round(q(sims_dd, .95) * 100, 1)},
        "end_equity": round(eq[-1], 2),
        "trade_list": [t.__dict__ | {"day": str(t.day)} for t in trades[-50:]],
    }


# ------------------------------------------------------------------ data sources
DEMO_START = date(2026, 1, 5)

def demo_data(days: int, seed: int = 3) -> tuple[dict, dict]:
    from .data.sim import SimMarket, trading_days_before
    m = SimMarket(seed)
    start = DEMO_START
    daily, _ = m.history(start, 5, 30)
    intraday = defaultdict(list)
    d = start
    for _ in range(days):
        while d.weekday() >= 5:
            d += timedelta(days=1)
        plan = m.plan_day()
        o = datetime.combine(d, time(9, 30), NY)
        mins = defaultdict(list)
        for i in range(390):
            for sym, p in plan.items():
                mins[sym].append(m.minute_bar(sym, p, o + timedelta(minutes=i), i))
        for sym, bars in mins.items():
            intraday[sym].extend(ind.aggregate(bars, 5))
            m.record_day(sym, bars)
        d += timedelta(days=1)
    daily, _ = m.history(start)
    # the warm-up opening ranges, as 5-minute bars
    warm = defaultdict(list)
    for sym, bars in m._hist[1].items():
        for b in ind.aggregate(bars, 5):
            warm[sym].append(b)
    for sym in warm:
        intraday[sym] = sorted(warm[sym] + intraday[sym], key=lambda b: b.ts)
    return daily, intraday


def alpaca_data(symbols: list, start: date, end: date, feed: str = "iex") -> tuple[dict, dict]:
    import os
    from alpaca.data.enums import DataFeed
    from alpaca.data.historical import StockHistoricalDataClient
    from alpaca.data.requests import StockBarsRequest
    from alpaca.data.timeframe import TimeFrame, TimeFrameUnit
    from .config import load_dotenv
    load_dotenv(ROOT / ".env")
    c = StockHistoricalDataClient(os.environ["ALPACA_API_KEY"], os.environ["ALPACA_SECRET_KEY"])
    cache = ROOT / "data_cache"
    cache.mkdir(exist_ok=True)
    daily, intraday = {}, {}
    s0 = datetime.combine(start - timedelta(days=45), time(0), NY)
    e0 = datetime.combine(end + timedelta(days=1), time(0), NY)
    for sym in symbols:
        f = cache / f"{sym}_{start}_{end}_{feed}.json.gz"
        if f.exists():
            raw = json.loads(gzip.decompress(f.read_bytes()))
        else:
            raw = {}
            for key, tf in (("d", TimeFrame.Day), ("m5", TimeFrame(5, TimeFrameUnit.Minute))):
                res = c.get_stock_bars(StockBarsRequest(symbol_or_symbols=sym, timeframe=tf, start=s0, end=e0, feed=DataFeed(feed)))
                raw[key] = [[b.timestamp.isoformat(), b.open, b.high, b.low, b.close, b.volume] for b in res.data.get(sym, [])]
            f.write_bytes(gzip.compress(json.dumps(raw).encode()))
        mk = lambda rows: [Bar(sym, datetime.fromisoformat(r[0]), *map(float, r[1:6])) for r in rows]
        daily[sym], intraday[sym] = mk(raw["d"]), mk(raw["m5"])
        print(f"  {sym}: {len(daily[sym])} days, {len(intraday[sym])} 5-min bars", flush=True)
    return daily, intraday


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(description="Backtest the ORB / Stocks-in-Play strategy")
    ap.add_argument("--source", choices=["demo", "alpaca"], default="demo")
    ap.add_argument("--days", type=int, default=120, help="demo: number of synthetic days")
    ap.add_argument("--start", type=date.fromisoformat)
    ap.add_argument("--end", type=date.fromisoformat)
    ap.add_argument("--symbols", default="", help="comma separated")
    ap.add_argument("--symbols-file")
    ap.add_argument("--feed", default="iex")
    ap.add_argument("--top-n", type=int, default=20)
    ap.add_argument("--risk-pct", type=float, default=1.0)
    ap.add_argument("--leverage", type=float, default=1.0)
    ap.add_argument("--slippage-bps", type=float, default=2.0)
    ap.add_argument("--commission", type=float, default=0.0035)
    ap.add_argument("--long-only", action="store_true")
    ap.add_argument("--target-r", type=float)
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)
    cfg = BTConfig(orb=OrbConfig(top_n=a.top_n, target_r=a.target_r), risk_pct=a.risk_pct, max_leverage=a.leverage,
                   slippage_bps=a.slippage_bps, commission_per_share=a.commission, allow_short=not a.long_only)
    if a.source == "demo":
        daily, intraday = demo_data(a.days)
        res = run(daily, intraday, cfg, start=DEMO_START)
    else:
        syms = [s.strip().upper() for s in a.symbols.split(",") if s.strip()]
        if a.symbols_file:
            syms += [s.strip().upper() for s in Path(a.symbols_file).read_text().split() if s.strip()]
        if not syms or not a.start or not a.end:
            ap.error("--source alpaca needs --start, --end and --symbols or --symbols-file")
        daily, intraday = alpaca_data(syms, a.start, a.end, a.feed)
        res = run(daily, intraday, cfg, a.start, a.end)
    if a.json:
        print(json.dumps(res, indent=2, default=str))
        return
    trades = res.pop("trade_list", [])
    print("\n=== Backtest: ORB on Stocks in Play ===" + ("  (DEMO DATA: synthetic, says nothing about real markets)" if a.source == "demo" else ""))
    for k, v in res.items():
        print(f"  {k:20s} {v}")
    print(f"\n  last {min(10, len(trades))} trades:")
    for t in trades[-10:]:
        print(f"   {t['day']} {t['symbol']:5s} {t['side']:4s} qty {t['qty']:5d} fill {t['fill']:9.2f} exit {t['exit']:9.2f} {t['reason']:6s} {t['pnl']:+9.2f} ({t['r']:+.2f}R)")


if __name__ == "__main__":
    main()
