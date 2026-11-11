"""The interface every broker adapter implements (sync; the engine runs it in a thread)."""
from __future__ import annotations

from typing import Protocol

from ..models import Account, OrderResult, Position, Side


class Broker(Protocol):
    name: str
    paper: bool

    def account(self) -> Account: ...
    def positions(self) -> list[Position]: ...
    def clock(self) -> dict: ...                       # {"is_open": bool, "next_open": dt, "next_close": dt}
    def last_price(self, symbol: str) -> float | None: ...
    def submit_entry(self, symbol: str, side: Side, qty: int, stop: float, target: float | None,
                     client_id: str) -> OrderResult: ...
    def order_status(self, order_id: str) -> dict: ...  # {"status", "filled_price", "filled_qty", "exit_price", "closed"}
    def close_position(self, symbol: str) -> OrderResult: ...
    def close_all(self) -> None: ...
