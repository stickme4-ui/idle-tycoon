#!/usr/bin/env python3
"""Start TradePilot:  python run.py   then open http://127.0.0.1:8000"""
import logging
import sys

import uvicorn

from tradepilot.config import load_settings
from tradepilot.server import create_app


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    s = load_settings()
    if s.broker == "alpaca" and not (s.alpaca_key and s.alpaca_secret):
        sys.exit("BROKER=alpaca but ALPACA_API_KEY / ALPACA_SECRET_KEY are empty in .env")
    if s.is_live_money:
        print("\n" + "!" * 70 + "\n  LIVE MONEY: ALPACA_PAPER=false. Orders will use real money.\n" + "!" * 70 + "\n")
    print(f"TradePilot -> http://{s.host}:{s.port}   (broker: {s.broker}, paper: {not s.is_live_money})")
    uvicorn.run(create_app(s), host=s.host, port=s.port, log_level="warning")


if __name__ == "__main__":
    main()
