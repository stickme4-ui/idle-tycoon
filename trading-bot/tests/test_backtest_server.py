from datetime import date, datetime, time

from fastapi.testclient import TestClient

from helpers import mk
from tradepilot.backtest import BTConfig, demo_data, run, simulate_trade
from tradepilot.models import Side, Signal

D = date(2026, 11, 10)


def test_same_bar_entry_and_stop_counts_as_stop():
    sig = Signal("X", "orb", Side.BUY, 51.0, 50.8, None)
    bars = [mk("X", D, 9, 30, 50, 50.9, 49.9, 50.5), mk("X", D, 9, 35, 50.5, 51.2, 50.7, 51.1)]
    fill, exit_px, reason = simulate_trade(sig, bars, 1, BTConfig(slippage_bps=0))
    assert (fill, reason) == (51.0, "stop") and exit_px == 50.8


def test_exit_at_close_and_no_trigger():
    sig = Signal("X", "orb", Side.BUY, 51.0, 50.0, None)
    bars = [mk("X", D, 9, 30, 50, 50.9, 49.9, 50.5), mk("X", D, 9, 35, 50.5, 51.5, 50.4, 51.4),
            mk("X", D, 15, 50, 52, 52.5, 51.8, 52.4)]
    assert simulate_trade(sig, bars, 1, BTConfig(slippage_bps=0))[2] == "close"
    flat = [mk("X", D, 9, 30, 50, 50.9, 49.9, 50.5), mk("X", D, 9, 35, 50.5, 50.8, 50.4, 50.6)]
    assert simulate_trade(sig, flat, 1, BTConfig()) is None


def test_backtest_runs_on_demo_data():
    from tradepilot.backtest import DEMO_START
    daily, intraday = demo_data(8)
    res = run(daily, intraday, BTConfig(), start=DEMO_START)
    assert res["days"] == 8 and res["trades"] > 0
    assert set(res["monte_carlo"]) >= {"return_pct_p5", "max_dd_pct_p95"}


def test_server_endpoints_without_starting_the_market():
    from tradepilot.ai import Analyst
    from tradepilot.broker.sim import SimBroker
    from tradepilot.clock import SimClock
    from tradepilot.config import NY, Settings
    from tradepilot.engine import Engine
    from tradepilot.journal import Journal
    from tradepilot.server import create_app
    from test_engine import FakeFeed

    s = Settings(config_path="/dev/null/none.json")
    e = Engine(s, SimBroker(), FakeFeed(), SimClock(datetime.combine(D, time(10), NY)), Analyst(enabled=False), Journal())
    app = create_app(s, engine=e, autostart=False)
    with TestClient(app) as c:
        assert c.get("/").status_code == 200
        st = c.get("/api/state").json()
        assert st["mode"] == "manual" and st["demo"] is True
        pub = c.get("/api/settings").json()
        assert "alpaca_key" not in pub and "alpaca_secret" not in pub
        assert c.post("/api/proposals/NOPE/execute").json()["ok"] is False
        assert c.post("/api/mode", json={"mode": "auto"}).json()["ok"] is True
        assert c.post("/api/kill", json={"on": True}).json()["ok"] is True
        assert c.get("/api/state").json()["mode"] == "manual"
