"""Alpaca adapter (paper by default). Keys come from the environment only.

Entries are market orders with the stop attached at the broker (bracket when
there is a target, OTO when there is only a stop), so the protective stop
lives on Alpaca's servers even if this program crashes.
"""
from __future__ import annotations

import logging

from ..models import Account, OrderResult, Position, Side

log = logging.getLogger("tradepilot.alpaca")


def _f(x) -> float | None:
    try:
        return float(x) if x is not None else None
    except (TypeError, ValueError):
        return None


class AlpacaBroker:
    name = "alpaca"

    def __init__(self, key: str, secret: str, paper: bool = True, feed: str = "iex"):
        from alpaca.data.enums import DataFeed
        from alpaca.data.historical import StockHistoricalDataClient
        from alpaca.trading.client import TradingClient

        if not key or not secret:
            raise ValueError("ALPACA_API_KEY / ALPACA_SECRET_KEY are missing in .env")
        self.paper = paper
        self.trading = TradingClient(key, secret, paper=paper)
        self.data = StockHistoricalDataClient(key, secret)
        self.feed = DataFeed(feed)
        self.price_cache: dict = {}

    def account(self) -> Account:
        a = self.trading.get_account()
        return Account(equity=_f(a.equity) or 0.0, cash=_f(a.cash) or 0.0, buying_power=_f(a.buying_power) or 0.0,
                       last_equity=_f(a.last_equity) or _f(a.equity) or 0.0, paper=self.paper,
                       status=str(getattr(a.status, "value", a.status)))

    def positions(self) -> list[Position]:
        out = []
        for p in self.trading.get_all_positions():
            qty = _f(p.qty) or 0.0
            side = str(getattr(p.side, "value", p.side))
            if side == "short" and qty > 0:
                qty = -qty
            out.append(Position(p.symbol, qty, _f(p.avg_entry_price) or 0.0,
                                _f(p.current_price) or _f(p.avg_entry_price) or 0.0))
        return out

    def clock(self) -> dict:
        c = self.trading.get_clock()
        return {"is_open": bool(c.is_open), "next_open": c.next_open, "next_close": c.next_close}

    def set_price(self, symbol: str, price: float) -> None:
        """The live feed keeps this current so execution does not wait on a REST call."""
        self.price_cache[symbol] = price

    def last_price(self, symbol: str) -> float | None:
        from alpaca.data.requests import StockLatestTradeRequest
        try:
            t = self.data.get_stock_latest_trade(StockLatestTradeRequest(symbol_or_symbols=symbol, feed=self.feed))
            px = _f(t[symbol].price)
            if px:
                self.price_cache[symbol] = px
                return px
        except Exception as e:  # network or data permission problems: fall back to the stream's price
            log.warning("latest trade %s: %s", symbol, e)
        return self.price_cache.get(symbol)

    def submit_entry(self, symbol, side, qty, stop, target, client_id) -> OrderResult:
        from alpaca.common.exceptions import APIError
        from alpaca.trading.enums import OrderClass, OrderSide, TimeInForce
        from alpaca.trading.requests import MarketOrderRequest, StopLossRequest, TakeProfitRequest

        kw = dict(symbol=symbol, qty=int(qty), side=OrderSide.BUY if side == Side.BUY else OrderSide.SELL,
                  time_in_force=TimeInForce.DAY, client_order_id=client_id,
                  stop_loss=StopLossRequest(stop_price=round(stop, 2)))
        if target is not None:
            kw.update(order_class=OrderClass.BRACKET, take_profit=TakeProfitRequest(limit_price=round(target, 2)))
        else:
            kw.update(order_class=OrderClass.OTO)
        try:
            o = self.trading.submit_order(MarketOrderRequest(**kw))
        except APIError as e:
            return OrderResult(False, error=str(e)[:300])
        except Exception as e:
            return OrderResult(False, error=f"{type(e).__name__}: {e}"[:300])
        return OrderResult(True, str(o.id), str(getattr(o.status, "value", o.status)),
                           _f(o.filled_avg_price), int(_f(o.filled_qty) or 0))

    def order_status(self, order_id: str) -> dict:
        from alpaca.trading.requests import GetOrderByIdRequest
        o = self.trading.get_order_by_id(order_id, filter=GetOrderByIdRequest(nested=True))
        status = str(getattr(o.status, "value", o.status))
        exit_price, closed = None, False
        for leg in o.legs or []:
            ls = str(getattr(leg.status, "value", leg.status))
            if ls == "filled":
                exit_price, closed = _f(leg.filled_avg_price), True
        if status in ("canceled", "expired", "rejected") and not _f(o.filled_qty):
            closed = True
        return {"status": status, "filled_price": _f(o.filled_avg_price), "filled_qty": int(_f(o.filled_qty) or 0),
                "exit_price": exit_price, "closed": closed}

    def close_position(self, symbol: str) -> OrderResult:
        from alpaca.trading.enums import QueryOrderStatus
        from alpaca.trading.requests import GetOrdersRequest
        try:
            # the stop / target legs hold the shares: cancel them first
            for o in self.trading.get_orders(GetOrdersRequest(status=QueryOrderStatus.OPEN, symbols=[symbol])):
                self.trading.cancel_order_by_id(o.id)
            o = self.trading.close_position(symbol)
            return OrderResult(True, str(getattr(o, "id", "")), "submitted")
        except Exception as e:
            return OrderResult(False, error=str(e)[:300])

    def close_all(self) -> None:
        self.trading.close_all_positions(cancel_orders=True)
