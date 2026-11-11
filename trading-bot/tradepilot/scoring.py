"""A transparent 0-100 score for every proposal. Every point is explained."""
from __future__ import annotations

from .models import Proposal, Side


def score(p: Proposal) -> tuple[float, dict]:
    s, f = p.signal, p.signal.features
    long = s.side == Side.BUY
    parts: dict = {}
    # 1. How "in play" the stock is (the paper's main filter)
    rvol = f.get("rvol") or 0
    parts["נפח חריג"] = min(30.0, 10.0 * max(0.0, rvol - 0.5))
    rank = f.get("rvol_rank")
    if rank:
        parts["דירוג נפח"] = max(0.0, 10.0 - 0.5 * (rank - 1))
    # 2. Market tone agrees with the direction
    tone = f.get("regime")
    if tone in ("risk_on", "risk_off"):
        agree = (tone == "risk_on") == long
        parts["כיוון השוק (SPY)"] = 15.0 if agree else -10.0
    # 3. News agrees / disagrees
    if p.news:
        avg = sum(n["sentiment"] * n["materiality"] for n in p.news) / len(p.news)
        parts["חדשות"] = max(-20.0, min(20.0, (avg if long else -avg) * 25))
    elif s.strategy == "news":
        parts["חדשות"] = 15.0
    # 4. A compact opening range relative to ATR is a cleaner breakout
    rr = f.get("or_range_atr")
    if rr is not None:
        parts["טווח פתיחה"] = 10.0 if rr <= 0.35 else 5.0 if rr <= 0.6 else 0.0
    # 5. The AI review
    if p.ai:
        bonus = {"take": 1.0, "caution": 0.3, "skip": -1.0}.get(p.ai.verdict, 0.0)
        parts["ניתוח Claude"] = round(bonus * 15 * p.ai.confidence / 100, 1)
    base = 25.0
    total = max(0.0, min(100.0, base + sum(parts.values())))
    return round(total, 1), {"בסיס": base, **{k: round(v, 1) for k, v in parts.items()}}
