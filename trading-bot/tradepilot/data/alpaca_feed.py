"""Real-time and historical data from Alpaca.

* History: daily bars (ATR, average volume) and each past session's opening
  range (average opening volume), fetched once before the open.
* Live: a websocket of 1-minute bars and trades for the symbols that matter
  (SPY, QQQ, open proposals, positions), plus the real-time news websocket.
* The free plan streams IEX only and caps the websocket at 30 symbols, so the
  whole universe's opening range is fetched by REST at 9:35.
  For live trading the paid SIP feed (ALPACA_DATA_FEED=sip) is recommended:
  IEX is only a small slice of the volume.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import date, datetime, time, timedelta, timezone

from ..config import NY
from ..models import Bar, NewsItem

log = logging.getLogger("tradepilot.feed")


def _bar(b) -> Bar:
    return Bar(b.symbol, b.timestamp, float(b.open), float(b.high), float(b.low), float(b.close),
               float(b.volume), float(b.vwap) if getattr(b, "vwap", None) else None)


def _news(n) -> NewsItem:
    return NewsItem(id=str(n.id), ts=n.created_at, headline=n.headline or "", summary=n.summary or "",
                    symbols=list(n.symbols or []), source=n.source or "")


class AlpacaFeed:
    live = True

    def __init__(self, key: str, secret: str, feed: str = "iex", max_stream_symbols: int = 30):
        from alpaca.data.enums import DataFeed
        from alpaca.data.historical import StockHistoricalDataClient
        from alpaca.data.historical.news import NewsClient
        from alpaca.data.historical.screener import ScreenerClient

        self.key, self.secret = key, secret
        self.feed = DataFeed(feed)
        self.hist = StockHistoricalDataClient(key, secret)
        self.news_client = NewsClient(key, secret)
        self.screener = ScreenerClient(key, secret)
        self.max_stream = max_stream_symbols
        self.stream = None
        self.news_stream = None
        self.streamed: set = set()
        self.tasks: list = []
        self.engine = None

    # ---- REST ----
    async def universe(self, size: int, watchlist: list) -> list[str]:
        from alpaca.data.requests import MostActivesRequest
        syms = ["SPY", "QQQ"] + list(watchlist)
        try:
            ma = await asyncio.to_thread(self.screener.get_most_actives, MostActivesRequest(top=min(100, size), by="volume"))
            syms += [a.symbol for a in ma.most_actives]
        except Exception as e:
            log.warning("most actives: %s", e)
        out = []
        for s in syms:
            if s not in out and s.isalpha():   # skip warrants/units such as ABC.WS
                out.append(s)
        return out[: max(size, len(watchlist) + 2)]

    async def _bars(self, symbols, tf, start, end) -> dict:
        from alpaca.data.requests import StockBarsRequest
        out: dict = {}
        for i in range(0, len(symbols), 100):
            req = StockBarsRequest(symbol_or_symbols=symbols[i:i + 100], timeframe=tf, start=start, end=end,
                                   feed=self.feed)
            res = await asyncio.to_thread(self.hist.get_stock_bars, req)
            for sym, bars in res.data.items():
                out.setdefault(sym, []).extend(_bar(b) for b in bars)
        return out

    async def history(self, symbols: list, today: date, or_minutes: int, lookback: int):
        from alpaca.data.timeframe import TimeFrame, TimeFrameUnit
        start = datetime.combine(today - timedelta(days=int(lookback * 1.6) + 10), time(0), NY)
        end = datetime.combine(today, time(0), NY)
        daily = await self._bars(symbols, TimeFrame.Day, start, end)
        intraday: dict = {}
        tf = TimeFrame(or_minutes, TimeFrameUnit.Minute)
        d, days = today, 0
        while days < lookback and d > today - timedelta(days=lookback * 2 + 10):
            d -= timedelta(days=1)
            if d.weekday() >= 5:
                continue
            o = datetime.combine(d, time(9, 30), NY)
            got = await self._bars(symbols, tf, o, o + timedelta(minutes=or_minutes))
            if got:
                days += 1
                for s, bars in got.items():
                    intraday.setdefault(s, []).extend(bars)
        return daily, intraday

    async def backfill_today(self, symbols: list, now: datetime) -> list[Bar]:
        from alpaca.data.timeframe import TimeFrame
        o = datetime.combine(now.astimezone(NY).date(), time(9, 30), NY)
        if now <= o:
            return []
        got = await self._bars(symbols, TimeFrame.Minute, o, now)
        return [b for bars in got.values() for b in bars]

    async def recent_news(self, symbols: list, since: datetime) -> list[NewsItem]:
        from alpaca.data.requests import NewsRequest
        try:
            res = await asyncio.to_thread(self.news_client.get_news,
                                          NewsRequest(symbols=",".join(symbols[:50]), start=since, limit=50))
            items = res.data.get("news", []) if hasattr(res, "data") else []
            return [_news(n) for n in items]
        except Exception as e:
            log.warning("news history: %s", e)
            return []

    # ---- websockets ----
    async def start(self, engine) -> None:
        from alpaca.data.live import NewsDataStream, StockDataStream
        self.engine = engine
        self.stream = StockDataStream(self.key, self.secret, feed=self.feed)
        self.news_stream = NewsDataStream(self.key, self.secret)

        async def on_bar(b):
            await engine.on_bar(_bar(b))

        async def on_trade(t):
            await engine.on_price(t.symbol, float(t.price), t.timestamp)

        async def on_news(n):
            await engine.on_news(_news(n))

        self._on_bar, self._on_trade = on_bar, on_trade
        self.news_stream.subscribe_news(on_news, "*")
        await self.watch_prices(["SPY", "QQQ"])
        self.tasks = [asyncio.create_task(self._keep(self.stream)), asyncio.create_task(self._keep(self.news_stream))]

    async def _keep(self, s) -> None:
        while True:
            try:
                await s._run_forever()
            except asyncio.CancelledError:
                raise
            except Exception as e:
                log.warning("stream dropped (%s), reconnecting", e)
            await asyncio.sleep(3)

    async def watch_prices(self, symbols) -> None:
        """Stream bars + trades for these symbols (up to the plan's websocket cap)."""
        if not self.stream:
            return
        want = [s for s in symbols if s not in self.streamed]
        room = self.max_stream - len(self.streamed)
        want = want[: max(0, room)]
        if want:
            self.stream.subscribe_bars(self._on_bar, *want)
            self.stream.subscribe_trades(self._on_trade, *want)
            self.streamed.update(want)

    async def stop(self) -> None:
        for t in self.tasks:
            t.cancel()
        for s in (self.stream, self.news_stream):
            try:
                if s:
                    await s.stop_ws()
            except Exception:
                pass
