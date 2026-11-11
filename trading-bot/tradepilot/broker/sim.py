"""A simulated broker: market fills with slippage, stop and target legs filled on bar highs/lows.

Used by the demo mode, the tests and as the execution model of the backtester.
"""
from __future__ import annotations

import itertools
from dataclasses import dataclass, field
from datetime import datetime

from ..models import Account, Bar, OrderResult, Position, Side


@dataclass
class _Pos:
    qty: int
    avg: float


@dataclass
class _Order:
    id: str
    symbol: str
    side: Side
    qty: int
    stop: float
    target: float | None
    filled_price: float | None = None
    exit_price: float | None = None
    status: str = "filled"
    closed: bool = False


class SimBroker:
    name = "sim"
    paper = True

    def __init__(self, cash: float = 25_000.0, slippage_bps: float = 2.0, commission_per_share: float = 0.0):
        self.cash = cash
        self.last_equity = cash
        self.slip = slippage_bps / 10_000
        self.commission = commission_per_share
        self.prices: dict = {}
        self.pos: dict = {}
        self.orders: dict = {}
        self.ids = itertools.count(1)
        self.is_open = True
        self.now: datetime | None = None
        self.fills: list = []

    # ---- market updates from the feed ----
    def on_bar(self, bar: Bar) -> None:
        """Move the price, then fill any stop / target leg the bar touched (stop first: conservative)."""
        for o in list(self.orders.values()):
            if o.closed or o.symbol != bar.symbol or o.symbol not in self.pos:
                continue
            long = o.side == Side.BUY
            hit_stop = bar.low <= o.stop if long else bar.high >= o.stop
            hit_target = o.target is not None and (bar.high >= o.target if long else bar.low <= o.target)
            if hit_stop:
                # a gap through the stop fills at the open, which can be worse than the stop
                px = min(o.stop, bar.open) if long else max(o.stop, bar.open)
                self._exit(o, px * (1 - self.slip) if long else px * (1 + self.slip))
            elif hit_target:
                px = max(o.target, bar.open) if long else min(o.target, bar.open)
                self._exit(o, px)
        self.prices[bar.symbol] = bar.close

    def on_tick(self, symbol: str, price: float) -> None:
        self.on_bar(Bar(symbol, self.now, price, price, price, price, 0))

    def new_day(self) -> None:
        self.last_equity = self.account().equity

    # ---- Broker interface ----
    def account(self) -> Account:
        mv = sum(p.qty * self.prices.get(s, p.avg) for s, p in self.pos.items())
        equity = self.cash + mv
        gross = sum(abs(p.qty) * self.prices.get(s, p.avg) for s, p in self.pos.items())
        return Account(equity=equity, cash=self.cash, buying_power=max(0.0, equity - gross),
                       last_equity=self.last_equity, paper=True)

    def positions(self) -> list[Position]:
        return [Position(s, p.qty, p.avg, self.prices.get(s, p.avg)) for s, p in self.pos.items() if p.qty]

    def clock(self) -> dict:
        return {"is_open": self.is_open, "next_open": None, "next_close": None}

    def last_price(self, symbol: str) -> float | None:
        return self.prices.get(symbol)

    def submit_entry(self, symbol, side, qty, stop, target, client_id) -> OrderResult:
        px = self.prices.get(symbol)
        if px is None:
            return OrderResult(False, error=f"no price for {symbol}")
        if qty <= 0:
            return OrderResult(False, error="qty must be positive")
        long = side == Side.BUY
        if long and stop >= px or not long and stop <= px:
            return OrderResult(False, error="stop is on the wrong side of the price")
        fill = round(px * (1 + self.slip) if long else px * (1 - self.slip), 4)
        signed = qty if long else -qty
        if long and qty * fill > self.account().buying_power:
            return OrderResult(False, error="insufficient buying power")
        self.cash -= signed * fill + self.commission * qty
        p = self.pos.get(symbol)
        if p:
            tot = p.qty + signed
            p.avg = (p.avg * p.qty + fill * signed) / tot if tot else 0.0
            p.qty = tot
        else:
            self.pos[symbol] = _Pos(signed, fill)
        oid = f"SIM{next(self.ids)}"
        self.orders[oid] = _Order(oid, symbol, side, qty, stop, target, filled_price=fill)
        self.fills.append((self.now, symbol, side.value, qty, fill))
        return OrderResult(True, oid, "filled", fill, qty)

    def _exit(self, o: _Order, px: float) -> None:
        p = self.pos.get(o.symbol)
        if not p or not p.qty:
            o.closed = True
            return
        qty = min(abs(p.qty), o.qty)
        signed = qty if p.qty > 0 else -qty
        self.cash += signed * px - self.commission * qty
        p.qty -= signed
        if p.qty == 0:
            del self.pos[o.symbol]
        o.exit_price, o.closed, o.status = round(px, 4), True, "closed"
        self.fills.append((self.now, o.symbol, "sell" if signed > 0 else "buy", qty, px))

    def order_status(self, order_id: str) -> dict:
        o = self.orders.get(order_id)
        if not o:
            return {"status": "unknown", "closed": True}
        return {"status": o.status, "filled_price": o.filled_price, "filled_qty": o.qty,
                "exit_price": o.exit_price, "closed": o.closed}

    def close_position(self, symbol: str) -> OrderResult:
        p = self.pos.get(symbol)
        if not p:
            return OrderResult(True, status="flat")
        px = self.prices.get(symbol, p.avg)
        px = px * (1 - self.slip) if p.qty > 0 else px * (1 + self.slip)
        for o in self.orders.values():
            if o.symbol == symbol and not o.closed:
                self._exit(o, px)
        if symbol in self.pos:  # a position without an open order
            self.cash += self.pos[symbol].qty * px
            del self.pos[symbol]
        return OrderResult(True, status="closed", filled_price=px)

    def close_all(self) -> None:
        for s in list(self.pos):
            self.close_position(s)
