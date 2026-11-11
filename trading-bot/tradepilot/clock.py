from __future__ import annotations

from datetime import datetime, timezone


class RealClock:
    simulated = False

    def now(self) -> datetime:
        return datetime.now(timezone.utc)


class SimClock:
    simulated = True

    def __init__(self, start: datetime):
        self.t = start

    def now(self) -> datetime:
        return self.t

    def set(self, t: datetime) -> None:
        self.t = t
