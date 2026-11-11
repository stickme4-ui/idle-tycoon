"""Plain data types shared by every part of the bot."""
from __future__ import annotations

import itertools
from dataclasses import asdict, dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any


class Side(str, Enum):
    BUY = "buy"
    SELL = "sell"   # a short sale when opening


class Status(str, Enum):
    WAITING = "waiting"        # setup found, price has not reached the trigger yet
    ARMED = "armed"            # you approved it: executes the moment it triggers
    TRIGGERED = "triggered"    # price reached the trigger: waiting for your click
    EXECUTING = "executing"
    OPEN = "open"              # filled, position is live
    CLOSED = "closed"
    REJECTED = "rejected"      # blocked by the risk manager
    EXPIRED = "expired"
    DISMISSED = "dismissed"
    FAILED = "failed"          # the broker refused the order


ACTIVE = {Status.WAITING, Status.ARMED, Status.TRIGGERED}


@dataclass
class Bar:
    symbol: str
    ts: datetime          # bar START time, timezone-aware
    open: float
    high: float
    low: float
    close: float
    volume: float
    vwap: float | None = None


@dataclass
class NewsItem:
    id: str
    ts: datetime
    headline: str
    summary: str = ""
    symbols: list = field(default_factory=list)
    source: str = ""


@dataclass
class NewsAnalysis:
    sentiment: float          # -1 (very bad) .. +1 (very good)
    materiality: float        # 0 (noise) .. 1 (moves the stock)
    catalyst: str             # earnings, guidance, m&a, fda, analyst, legal, macro, product, other
    direction: str            # up, down, unclear
    confidence: float         # 0..1
    summary_he: str           # one line in Hebrew
    by: str = "claude"        # claude | heuristic


@dataclass
class AIReview:
    verdict: str              # take | caution | skip
    confidence: int           # 0..100
    reasons_he: list
    risks_he: list
    by: str = "claude"


@dataclass
class Signal:
    symbol: str
    strategy: str
    side: Side
    entry: float              # trigger / planned entry price
    stop: float
    target: float | None
    trigger: str = "stop"     # "stop": wait for price to cross entry; "market": now
    features: dict = field(default_factory=dict)
    why_he: str = ""

    @property
    def risk_per_share(self) -> float:
        return abs(self.entry - self.stop)


_ids = itertools.count(1)


@dataclass
class Proposal:
    signal: Signal
    qty: int
    created_at: datetime
    expires_at: datetime
    id: str = field(default_factory=lambda: f"P{next(_ids):05d}")
    status: Status = Status.WAITING
    score: float = 0.0
    score_parts: dict = field(default_factory=dict)
    ai: AIReview | None = None
    news: list = field(default_factory=list)        # [NewsAnalysis as dict + headline]
    notes: list = field(default_factory=list)       # human-readable history
    auto_allowed: bool = True
    order_id: str | None = None
    fill_price: float | None = None
    filled_qty: int = 0
    exit_price: float | None = None
    pnl: float | None = None
    opened_at: datetime | None = None
    closed_at: datetime | None = None
    triggered_at: datetime | None = None

    @property
    def risk_usd(self) -> float:
        return round(self.qty * self.signal.risk_per_share, 2)

    def note(self, now: datetime, text: str) -> None:
        self.notes.append({"ts": now.isoformat(), "text": text})

    def to_dict(self) -> dict[str, Any]:
        s = self.signal
        return {
            "id": self.id, "status": self.status.value, "symbol": s.symbol, "strategy": s.strategy,
            "side": s.side.value, "entry": s.entry, "stop": s.stop, "target": s.target, "trigger": s.trigger,
            "qty": self.qty, "risk_usd": self.risk_usd, "notional": round(self.qty * s.entry, 2),
            "features": s.features, "why_he": s.why_he, "score": round(self.score, 1),
            "score_parts": self.score_parts, "ai": asdict(self.ai) if self.ai else None, "news": self.news,
            "notes": self.notes[-8:], "auto_allowed": self.auto_allowed, "order_id": self.order_id,
            "fill_price": self.fill_price, "filled_qty": self.filled_qty, "exit_price": self.exit_price,
            "pnl": self.pnl, "created_at": self.created_at.isoformat(), "expires_at": self.expires_at.isoformat(),
            "opened_at": self.opened_at.isoformat() if self.opened_at else None,
            "closed_at": self.closed_at.isoformat() if self.closed_at else None,
        }


@dataclass
class Account:
    equity: float
    cash: float
    buying_power: float
    last_equity: float        # equity at the previous close: day P&L = equity - last_equity
    paper: bool = True
    status: str = "ACTIVE"

    @property
    def day_pnl(self) -> float:
        return self.equity - self.last_equity


@dataclass
class Position:
    symbol: str
    qty: float                # negative for a short
    avg_price: float
    market_price: float

    @property
    def market_value(self) -> float:
        return self.qty * self.market_price

    @property
    def unrealized_pnl(self) -> float:
        return (self.market_price - self.avg_price) * self.qty


@dataclass
class OrderResult:
    ok: bool
    order_id: str | None = None
    status: str = ""
    filled_price: float | None = None
    filled_qty: int = 0
    error: str = ""
