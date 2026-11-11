"""Web server: the dashboard, a JSON API and a websocket that pushes live state.

It listens on 127.0.0.1 by default: only your own computer can reach it.
"""
from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Body, FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .ai import Analyst
from .clock import RealClock, SimClock
from .config import NY, Settings, load_settings
from .engine import Engine
from .journal import Journal

WEB = Path(__file__).parent / "web"
log = logging.getLogger("tradepilot")


def build_engine(s: Settings) -> Engine:
    if s.broker == "alpaca":
        from .broker.alpaca import AlpacaBroker
        from .data.alpaca_feed import AlpacaFeed
        broker = AlpacaBroker(s.alpaca_key, s.alpaca_secret, paper=s.alpaca_paper, feed=s.data_feed)
        feed = AlpacaFeed(s.alpaca_key, s.alpaca_secret, feed=s.data_feed,
                          max_stream_symbols=30 if s.data_feed == "iex" else 200)
        clock = RealClock()
    else:
        from datetime import datetime, timezone
        from .broker.sim import SimBroker
        from .data.sim import SimFeed
        clock = SimClock(datetime.now(timezone.utc))
        broker = SimBroker(cash=25_000)
        feed = SimFeed(clock, broker, speed=s.sim_speed)
    analyst = Analyst(model=s.ai_model)
    return Engine(s, broker, feed, clock, analyst, Journal(s.db_path))


def create_app(settings: Settings | None = None, engine: Engine | None = None, autostart: bool = True) -> FastAPI:
    s = settings or load_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.engine = engine or build_engine(s)
        if autostart:
            await app.state.engine.start()
        yield
        await app.state.engine.stop()

    app = FastAPI(title="TradePilot", lifespan=lifespan)
    app.mount("/static", StaticFiles(directory=WEB), name="static")

    def eng() -> Engine:
        return app.state.engine

    @app.get("/")
    async def index():
        return FileResponse(WEB / "index.html")

    @app.get("/api/state")
    async def state():
        return eng().snapshot()

    @app.get("/api/settings")
    async def get_settings():
        return eng().s.public()

    @app.put("/api/settings")
    async def put_settings(data: dict = Body(...)):
        e = eng()
        e.s.apply(data)   # limits apply to the next order; open positions keep their broker-side stops
        e.s.save()
        e.log("info", "ההגדרות עודכנו")
        await e.broadcast()
        return e.s.public()

    @app.post("/api/proposals/{pid}/execute")
    async def execute(pid: str):
        return await eng().execute(pid, by="manual")

    @app.post("/api/proposals/{pid}/arm")
    async def arm(pid: str):
        return await eng().arm(pid)

    @app.post("/api/proposals/{pid}/dismiss")
    async def dismiss(pid: str):
        return await eng().dismiss(pid)

    @app.post("/api/proposals/{pid}/close")
    async def close(pid: str):
        return await eng().close(pid)

    @app.post("/api/mode")
    async def mode(data: dict = Body(...)):
        return await eng().set_mode(str(data.get("mode", "")), str(data.get("confirm", "")))

    @app.post("/api/kill")
    async def kill(data: dict = Body(...)):
        return await eng().set_kill(bool(data.get("on", True)), bool(data.get("flatten", False)))

    @app.post("/api/flatten")
    async def flatten():
        await eng().flatten("סגירה ידנית של כל הפוזיציות של הבוט")
        return {"ok": True}

    @app.post("/api/demo/speed")
    async def demo_speed(data: dict = Body(...)):
        f = eng().feed
        if not hasattr(f, "speed"):
            return JSONResponse({"ok": False, "reasons": ["רק במצב דמו"]}, status_code=400)
        f.speed = max(1.0, min(1200.0, float(data.get("speed", 60))))
        f.paused = bool(data.get("paused", False))
        return {"ok": True, "speed": f.speed, "paused": f.paused}

    @app.get("/api/journal")
    async def journal():
        return {"trades": eng().journal.trades(200), "stats": eng().journal.stats()}

    @app.websocket("/ws")
    async def ws(sock: WebSocket):
        await sock.accept()
        q: asyncio.Queue = asyncio.Queue(maxsize=2)

        async def push(snap):
            if q.full():
                q.get_nowait()
            q.put_nowait(snap)

        e = eng()
        e.listeners.add(push)
        try:
            await sock.send_json(e.snapshot())
            while True:
                snap = await q.get()
                await sock.send_json(snap)
        except (WebSocketDisconnect, RuntimeError):
            pass
        finally:
            e.listeners.discard(push)

    return app
