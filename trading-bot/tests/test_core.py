from datetime import date, datetime, time, timedelta

import pytest

from helpers import daily_series, mk, opening_history
from tradepilot import indicators as ind
from tradepilot import risk as R
from tradepilot.broker.sim import SimBroker
from tradepilot.config import NY, OrbConfig, RiskLimits
from tradepilot.market import MarketContext, build_stats
from tradepilot.models import Account, Bar, Position, Proposal, Side, Signal
from tradepilot.strategies.orb import OrbStrategy

D = date(2026, 11, 10)   # a Tuesday


# ---------------------------------------------------------------- indicators
def test_atr_and_avg_volume():
    bars = daily_series("X", D, n=20, price=50, rng=2.0)
    assert ind.atr(bars, 14) == pytest.approx(2.0)
    assert ind.avg_volume(bars, 14) == 2_000_000
    assert ind.atr(bars[:10], 14) is None


def test_opening_range_needs_complete_window():
    bars = [mk("X", D, 9, 30 + m, 10, 10.5 + m * 0.1, 9.8, 10.2) for m in range(4)]
    assert ind.opening_range(bars, 5) is None                     # 9:34 bar missing
    bars.append(mk("X", D, 9, 34, 10.2, 11, 10.1, 10.9))
    orb = ind.opening_range(bars, 5)
    assert (orb.open, orb.high, orb.low, orb.close) == (10, 11, 9.8, 10.9)
    assert orb.volume == 5000
    five = [mk("X", D, 9, 30, 10, 11, 9, 10.5, 777)]
    assert ind.opening_range(five, 5, bar_minutes=5).volume == 777


def test_avg_opening_volume_and_vwap_and_aggregate():
    hist = opening_history("X", D, n=14, vol_per_min=10_000)
    assert ind.avg_opening_volume(hist, 5, D, 14) == pytest.approx(50_000)
    bars = [mk("X", D, 9, 30, 10, 10, 10, 10, 100), mk("X", D, 9, 31, 20, 20, 20, 20, 300)]
    assert ind.session_vwap(bars) == pytest.approx(17.5)
    agg = ind.aggregate([mk("X", D, 9, 30 + m, 10 + m, 11 + m, 9 + m, 10.5 + m) for m in range(10)], 5)
    assert len(agg) == 2 and agg[0].high == 15 and agg[1].open == 15


# ---------------------------------------------------------------- ORB strategy
def _ctx(now, syms_or):
    """syms_or: {sym: (open, high, low, close, volume_per_min)} for the first 5 minutes today."""
    ctx = MarketContext(now=now)
    for sym, (o, h, l, c, v) in syms_or.items():
        ctx.universe.append(sym)
        ctx.stats[sym] = build_stats(sym, daily_series(sym, D, price=o), opening_history(sym, D), D, 5, 14)
        for m in range(5):
            ctx.add_bar(mk(sym, D, 9, 30 + m, o if m == 0 else c, h, l, c, v))
    return ctx


def test_orb_long_signal_ranked_by_rvol():
    now = datetime.combine(D, time(9, 35, 30), NY)
    ctx = _ctx(now, {"AAA": (50, 51, 49.8, 50.9, 40_000), "BBB": (50, 50.5, 49.9, 50.4, 20_000),
                     "CCC": (50, 50.5, 49.9, 50.4, 5_000), "DOJI": (50, 50.5, 49.5, 50, 90_000)})
    strat = OrbStrategy(OrbConfig(top_n=5), RiskLimits())
    sigs = strat.on_clock(ctx)
    assert [s.symbol for s in sigs] == ["AAA", "BBB"]            # CCC: rvol 0.5 < 1; DOJI: no direction
    a = sigs[0]
    assert a.side == Side.BUY and a.entry == 51.01
    assert a.stop == pytest.approx(51.01 - 0.10 * 2.0)              # 10 % of ATR(2.0)
    assert a.features["rvol"] == pytest.approx(4.0)
    assert strat.on_clock(ctx) == []                                 # once per day


def test_orb_short_only_when_allowed_and_not_before_ready():
    early = datetime.combine(D, time(9, 33), NY)
    ctx = _ctx(early, {"RED": (50, 50.2, 49, 49.1, 40_000)})
    assert OrbStrategy(OrbConfig(), RiskLimits()).on_clock(ctx) == []
    ctx.now = datetime.combine(D, time(9, 35, 30), NY)
    assert OrbStrategy(OrbConfig(), RiskLimits(allow_short=False)).on_clock(ctx) == []
    sig = OrbStrategy(OrbConfig(), RiskLimits(allow_short=True)).on_clock(ctx)[0]
    assert sig.side == Side.SELL and sig.entry == 48.99 and sig.stop > sig.entry


# ---------------------------------------------------------------- risk
def _acct(eq=25_000, day_pnl=0.0):
    return Account(equity=eq, cash=eq, buying_power=eq, last_equity=eq - day_pnl)


def _prop(entry=50.0, stop=49.5, qty=100, side=Side.BUY, sym="AAA"):
    now = datetime.combine(D, time(10, 0), NY)
    return Proposal(Signal(sym, "orb", side, entry, stop, None), qty, now, now + timedelta(hours=5))


def test_sizing_by_risk_and_caps():
    lim = RiskLimits(risk_per_trade_pct=0.5, max_risk_per_trade_usd=100, max_position_pct=50)
    qty, rule = R.size_position(50, 49.5, _acct(), lim)
    assert (qty, rule) == (200, "risk")                             # $100 / $0.50
    lim.max_position_pct = 25
    qty, rule = R.size_position(50, 49.5, _acct(), lim)             # capped by position size
    assert (qty, rule) == (125, "position_size")                    # 25 % of 25k / $50
    qty, _ = R.size_position(50, 49.5, _acct(day_pnl=-290), RiskLimits(max_daily_loss_usd=300))
    assert qty == 20                                                # only $10 of daily loss left


def test_risk_check_pass_and_blocks():
    lim, now = RiskLimits(), datetime.combine(D, time(10, 0), NY)
    p = _prop(qty=100)
    day = R.DayState(day=D)
    assert R.check(p, 50.0, _acct(), [], day, lim, now) == []
    assert any("חירום" in r for r in R.check(p, 50.0, _acct(), [], day, lim, now, kill_switch=True))
    assert any("לפני" in r for r in R.check(p, 50.0, _acct(), [], day, lim, datetime.combine(D, time(9, 31), NY)))
    assert any("ברח" in r for r in R.check(p, 50.40, _acct(), [], day, lim, now))        # 0.8 R past the entry
    assert any("הסטופ" in r for r in R.check(p, 49.40, _acct(), [], day, lim, now))
    held = [Position("AAA", 10, 50, 50)]
    assert any("כבר יש" in r for r in R.check(p, 50.0, _acct(), held, day, lim, now))
    assert any("היומית" in r for r in R.check(p, 50.0, _acct(day_pnl=-280), [], day, lim, now))
    day.consecutive_losses = 3
    assert any("ברצף" in r for r in R.check(p, 50.0, _acct(), [], day, lim, now))
    short = _prop(entry=50, stop=50.5, side=Side.SELL)
    assert any("שורט" in r for r in R.check(short, 50.0, _acct(), [], R.DayState(day=D), lim, now))


# ---------------------------------------------------------------- simulated broker
def test_sim_broker_stop_gap_and_target():
    b = SimBroker(cash=10_000, slippage_bps=0)
    b.prices["X"] = 50.0
    r = b.submit_entry("X", Side.BUY, 10, 49.0, 53.0, "c1")
    assert r.ok and r.filled_price == 50.0
    b.on_bar(Bar("X", datetime.now(NY), 48.0, 48.5, 47.5, 48.2, 0))   # gaps below the stop
    st = b.order_status(r.order_id)
    assert st["closed"] and st["exit_price"] == 48.0                    # filled at the open, worse than the stop
    assert b.account().equity == pytest.approx(10_000 - 20)
    b.prices["Y"] = 20.0
    r2 = b.submit_entry("Y", Side.SELL, 10, 21.0, 18.0, "c2")
    b.on_bar(Bar("Y", datetime.now(NY), 19.0, 19.2, 17.9, 18.1, 0))
    assert b.order_status(r2.order_id)["exit_price"] == 18.0
    assert not b.submit_entry("Y", Side.BUY, 1, 25.0, None, "c3").ok   # stop above price for a buy
