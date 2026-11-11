import asyncio
from datetime import date, datetime, time, timedelta
from types import SimpleNamespace

import pytest

from helpers import daily_series, mk, opening_history
from tradepilot.ai import Analyst, heuristic_news
from tradepilot.broker.sim import SimBroker
from tradepilot.clock import SimClock
from tradepilot.config import NY, Settings
from tradepilot.engine import Engine
from tradepilot.journal import Journal
from tradepilot.market import build_stats
from tradepilot.models import Bar, NewsItem, Status

D = date(2026, 11, 10)


class FakeFeed:
    live = False

    def __init__(self):
        self.watched = []

    async def universe(self, size, watchlist):
        return ["SPY", "AAA"]

    async def history(self, symbols, today, or_minutes, lookback):
        return ({s: daily_series(s, today) for s in symbols}, {s: opening_history(s, today) for s in symbols})

    async def recent_news(self, symbols, since):
        return []

    async def backfill_today(self, symbols, now):
        return []

    async def watch_prices(self, symbols):
        self.watched += symbols

    async def start(self, engine):
        pass

    async def stop(self):
        pass


def make_engine(**risk):
    s = Settings()
    for k, v in risk.items():
        setattr(s.risk, k, v)
    clock = SimClock(datetime.combine(D, time(9, 20), NY))
    broker = SimBroker(cash=25_000, slippage_bps=0)
    e = Engine(s, broker, FakeFeed(), clock, Analyst(enabled=False), Journal())
    return e, clock, broker


async def feed_open(e, clock, broker, green=True):
    await e.prepare_day()
    broker.is_open = True
    for m in range(5):
        c = 50.9 if green else 49.1
        b = mk("AAA", D, 9, 30 + m, 50 if m == 0 else c, 51 if green else 50.2, 49.8 if green else 49, c, 40_000)
        broker.on_bar(b)
        await e.on_bar(b)
        spy = mk("SPY", D, 9, 30 + m, 50, 50.2, 49.9, 50.1, 10_000)
        broker.on_bar(spy)
        await e.on_bar(spy)
    clock.set(datetime.combine(D, time(9, 35, 30), NY))
    await e.tick()


async def price(e, broker, clock, px, minute):
    clock.set(datetime.combine(D, time(9, 36), NY) + timedelta(minutes=minute))
    broker.now = clock.now()
    b = mk("AAA", D, clock.now().hour, clock.now().minute, px, px, px, px, 5000)
    broker.on_bar(b)
    await e.on_bar(b)
    await e.tick()


def run(coro):
    return asyncio.run(coro)


def test_manual_flow_waiting_triggered_execute_stop_out():
    async def go():
        e, clock, broker = make_engine()
        await feed_open(e, clock, broker)
        [p] = list(e.proposals.values())
        assert p.status == Status.WAITING and p.signal.entry == 51.01
        await price(e, broker, clock, 51.05, 1)                       # crosses the trigger
        assert p.status == Status.TRIGGERED                           # manual: waits for the click
        r = await e.execute(p.id)
        assert r["ok"] and p.status == Status.OPEN and p.fill_price == pytest.approx(51.05)
        assert broker.positions()[0].qty == p.qty
        await price(e, broker, clock, 50.70, 2)                       # below the stop (50.81)
        assert p.status == Status.CLOSED and p.pnl < 0
        assert e.day.consecutive_losses == 1 and e.day.entries == 1
        assert abs(p.pnl) <= e.s.risk.max_risk_per_trade_usd * 1.6   # gap past the stop can cost a bit more
    run(go())


def test_armed_proposal_executes_on_trigger():
    async def go():
        e, clock, broker = make_engine()
        await feed_open(e, clock, broker)
        [p] = list(e.proposals.values())
        assert (await e.arm(p.id))["ok"] and p.status == Status.ARMED
        await price(e, broker, clock, 51.02, 1)
        assert p.status == Status.OPEN
    run(go())


def test_auto_mode_respects_score_and_kill_switch():
    async def go():
        e, clock, broker = make_engine()
        await e.set_mode("auto")
        e.s.auto.min_score = 101                                       # nothing can pass
        await feed_open(e, clock, broker)
        [p] = list(e.proposals.values())
        await price(e, broker, clock, 51.05, 1)
        assert p.status == Status.TRIGGERED                           # not auto-executed
        e2, clock2, broker2 = make_engine()
        await e2.set_mode("auto")
        e2.s.auto.min_score = 0
        await e2.set_kill(True)
        assert e2.mode == "manual"                                     # kill switch drops to manual
        await feed_open(e2, clock2, broker2)
        [p2] = list(e2.proposals.values())
        r = await e2.execute(p2.id)
        assert not r["ok"] and p2.status == Status.REJECTED
        e3, clock3, broker3 = make_engine()
        await e3.set_mode("auto")
        e3.s.auto.min_score = 0
        await feed_open(e3, clock3, broker3)
        [p3] = list(e3.proposals.values())
        await price(e3, broker3, clock3, 51.03, 1)
        assert p3.status == Status.OPEN                                # auto executed on the trigger
    run(go())


def test_live_money_auto_is_locked():
    async def go():
        e, _, _ = make_engine()
        e.s.broker, e.s.alpaca_paper = "alpaca", False
        r = await e.set_mode("auto")
        assert not r["ok"] and e.mode == "manual"
        e.s.allow_live_auto = True
        assert not (await e.set_mode("auto", "yes"))["ok"]
        assert (await e.set_mode("auto", "אני מבין את הסיכון"))["ok"]
    run(go())


def test_end_of_day_flatten():
    async def go():
        e, clock, broker = make_engine()
        await feed_open(e, clock, broker)
        [p] = list(e.proposals.values())
        await price(e, broker, clock, 51.05, 1)
        await e.execute(p.id)
        clock.set(datetime.combine(D, time(15, 55, 5), NY))
        await e.tick()
        assert p.status == Status.CLOSED and not broker.positions()
    run(go())


# ---------------------------------------------------------------- AI layer (no network)
class FakeMessages:
    def __init__(self, parsed, stop="end_turn"):
        self.parsed, self.stop, self.kwargs = parsed, stop, None

    async def parse(self, **kw):
        self.kwargs = kw
        return SimpleNamespace(stop_reason=self.stop, parsed_output=self.parsed)


def fake_client(parsed, stop="end_turn"):
    m = FakeMessages(parsed, stop)
    return SimpleNamespace(beta=SimpleNamespace(messages=m)), m


def test_news_analysis_uses_claude_and_falls_back():
    item = NewsItem("n1", datetime.now(NY), "AAA beats estimates and raises guidance", symbols=["AAA"])
    parsed = SimpleNamespace(sentiment=0.9, materiality=0.85, catalyst="earnings", direction="up", confidence=0.8,
                             summary_he="דוח חזק")
    client, m = fake_client(parsed)
    a = run(Analyst(client=client).analyze_news(item))
    assert a.by == "claude" and a.materiality == 0.85
    assert m.kwargs["model"] == "claude-opus-5-5" and m.kwargs["fallbacks"] == "default"
    client2, _ = fake_client(None, stop="refusal")
    b = run(Analyst(client=client2).analyze_news(NewsItem("n2", item.ts, item.headline, symbols=["AAA"])))
    assert b.by == "heuristic" and b.sentiment > 0
    assert heuristic_news(NewsItem("n3", item.ts, "BBB announces secondary offering", symbols=["BBB"])).sentiment < 0


def test_review_result_mapped():
    async def go():
        e, clock, broker = make_engine()
        await feed_open(e, clock, broker)
        [p] = list(e.proposals.values())
        parsed = SimpleNamespace(verdict="skip", confidence=80, reasons_he=["א"], risks_he=["ב"])
        client, _ = fake_client(parsed)
        rv = await Analyst(client=client).review(p, {"regime": {}, "news": [], "time": ""})
        assert rv.verdict == "skip" and rv.confidence == 80
    run(go())


def test_news_outside_the_universe_costs_no_ai_call():
    async def go():
        e, clock, broker = make_engine()
        await e.prepare_day()
        calls = []

        async def spy(item):
            calls.append(item.id)
            return heuristic_news(item)
        e.ai.analyze_news = spy
        now = clock.now()
        await e.on_news(NewsItem("x1", now, "ZZZZ beats estimates", symbols=["ZZZZ"]))
        await e.on_news(NewsItem("x2", now, "AAA beats estimates", symbols=["AAA"]))
        assert calls == ["x2"]
    run(go())
