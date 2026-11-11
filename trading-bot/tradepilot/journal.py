"""SQLite trade journal: every proposal, decision, order and result is kept."""
from __future__ import annotations

import json
import sqlite3
from datetime import datetime


class Journal:
    def __init__(self, path: str = ":memory:"):
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.executescript("""
        CREATE TABLE IF NOT EXISTS events (ts TEXT, level TEXT, text TEXT);
        CREATE TABLE IF NOT EXISTS proposals (id TEXT, day TEXT, data TEXT, PRIMARY KEY (id, day));
        """)
        self.db.commit()

    def event(self, ts: datetime, level: str, text: str) -> None:
        self.db.execute("INSERT INTO events VALUES (?, ?, ?)", (ts.isoformat(), level, text))
        self.db.commit()

    def save_proposal(self, day: str, d: dict) -> None:
        self.db.execute("INSERT OR REPLACE INTO proposals VALUES (?, ?, ?)", (d["id"], day, json.dumps(d, default=str)))
        self.db.commit()

    def trades(self, limit: int = 200) -> list[dict]:
        rows = self.db.execute("SELECT data FROM proposals ORDER BY day DESC, id DESC LIMIT ?", (limit,)).fetchall()
        out = [json.loads(r[0]) for r in rows]
        return [d for d in out if d.get("fill_price") is not None]

    def stats(self) -> dict:
        t = [d for d in self.trades(10_000) if d.get("pnl") is not None]
        wins = [d["pnl"] for d in t if d["pnl"] > 0]
        losses = [d["pnl"] for d in t if d["pnl"] <= 0]
        return {"trades": len(t), "wins": len(wins), "win_rate": round(len(wins) / len(t) * 100, 1) if t else None,
                "net_pnl": round(sum(d["pnl"] for d in t), 2),
                "profit_factor": round(sum(wins) / -sum(losses), 2) if losses and sum(losses) < 0 else None}
