"""Settings: environment (.env) for secrets and modes, config.json for limits.

Secrets (API keys) only ever come from the environment / .env file. They are
never written to config.json, never sent to the browser and never logged.
"""
from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass, field, fields
from pathlib import Path
from zoneinfo import ZoneInfo

NY = ZoneInfo("America/New_York")
ROOT = Path(__file__).resolve().parent.parent


def load_dotenv(path: Path) -> None:
    """Tiny .env reader (KEY=VALUE lines). Existing environment variables win."""
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def _bool(name: str, default: bool) -> bool:
    v = os.environ.get(name)
    if v is None or v == "":
        return default
    return v.strip().lower() in ("1", "true", "yes", "on")


@dataclass
class RiskLimits:
    """Hard limits. The risk manager blocks anything over them, in every mode."""
    risk_per_trade_pct: float = 0.5        # % of equity lost if the stop is hit
    max_risk_per_trade_usd: float = 100.0  # ... and never more than this many dollars
    max_daily_loss_pct: float = 2.0        # stop trading for the day at -2 % ...
    max_daily_loss_usd: float = 300.0      # ... or at this many dollars, whichever comes first
    max_trades_per_day: int = 6
    max_open_positions: int = 4
    max_position_pct: float = 25.0         # one position is at most 25 % of equity
    max_total_exposure_pct: float = 100.0  # 100 % = no margin
    max_consecutive_losses: int = 3        # circuit breaker
    no_entries_before: str = "09:35"
    no_entries_after: str = "15:30"
    flat_by: str = "15:55"                 # everything is closed at this time (day trading)
    max_entry_drift_r: float = 0.5         # refuse to chase: fill may be at most 0.5 R past the plan
    allow_short: bool = False
    pdt_guard: bool = False                # old $25k pattern-day-trader rule, if your broker still applies it
    min_price: float = 5.0
    blocked_symbols: list = field(default_factory=list)


@dataclass
class OrbConfig:
    """Opening-range breakout on Stocks in Play (Zarattini, Barbon & Aziz, 2024)."""
    enabled: bool = True
    or_minutes: int = 5
    top_n: int = 20                 # trade only the N highest relative-volume stocks
    min_rvol: float = 1.0           # opening-range volume at least 100 % of its 14-day average
    min_avg_volume: float = 1_000_000
    min_atr: float = 0.50
    lookback_days: int = 14
    stop_atr_frac: float = 0.10     # stop = 10 % of the 14-day ATR from the entry
    target_r: float | None = None   # None = no target, exit at flat_by (as in the paper)
    auto_allowed: bool = True


@dataclass
class NewsMomentumConfig:
    """Experimental: strong news + price confirmation. Manual only by default."""
    enabled: bool = True
    min_materiality: float = 0.7
    min_abs_sentiment: float = 0.6
    min_rvol: float = 2.0
    stop_atr_frac: float = 0.25
    target_r: float = 2.0
    max_age_minutes: int = 10
    auto_allowed: bool = False


@dataclass
class AutoConfig:
    min_score: float = 70.0
    require_ai_ok: bool = True      # in auto mode, a "skip" from the AI review blocks the trade


@dataclass
class Settings:
    broker: str = "sim"
    alpaca_key: str = ""
    alpaca_secret: str = ""
    alpaca_paper: bool = True
    data_feed: str = "iex"
    anthropic_key_set: bool = False
    ai_model: str = "claude-opus-5-5"
    allow_live_auto: bool = False
    host: str = "127.0.0.1"
    port: int = 8000
    sim_speed: float = 60.0
    watchlist: list = field(default_factory=lambda: ["SPY", "QQQ", "AAPL", "MSFT", "NVDA", "TSLA", "AMD", "META", "AMZN", "GOOGL"])
    universe_size: int = 100
    risk: RiskLimits = field(default_factory=RiskLimits)
    orb: OrbConfig = field(default_factory=OrbConfig)
    news: NewsMomentumConfig = field(default_factory=NewsMomentumConfig)
    auto: AutoConfig = field(default_factory=AutoConfig)
    db_path: str = str(ROOT / "tradepilot.db")
    config_path: str = str(ROOT / "config.json")

    @property
    def is_live_money(self) -> bool:
        return self.broker == "alpaca" and not self.alpaca_paper

    def public(self) -> dict:
        """What the browser may see: no secrets."""
        d = asdict(self)
        for k in ("alpaca_key", "alpaca_secret", "db_path", "config_path"):
            d.pop(k, None)
        d["is_live_money"] = self.is_live_money
        return d

    # ---- config.json (editable limits) ----
    EDITABLE = ("risk", "orb", "news", "auto", "watchlist", "universe_size")

    def save(self) -> None:
        d = {k: (asdict(getattr(self, k)) if hasattr(getattr(self, k), "__dataclass_fields__") else getattr(self, k))
             for k in self.EDITABLE}
        Path(self.config_path).write_text(json.dumps(d, indent=2), encoding="utf-8")

    def apply(self, data: dict) -> None:
        for k, v in data.items():
            if k not in self.EDITABLE:
                continue
            cur = getattr(self, k)
            if hasattr(cur, "__dataclass_fields__") and isinstance(v, dict):
                names = {f.name: f for f in fields(cur)}
                for kk, vv in v.items():
                    if kk in names:
                        setattr(cur, kk, _coerce(getattr(cur, kk), vv))
            elif k == "watchlist" and isinstance(v, list):
                self.watchlist = [str(s).upper().strip() for s in v if str(s).strip()]
            elif k == "universe_size":
                self.universe_size = max(10, min(500, int(v)))


def _coerce(old, new):
    if new is None:
        return None
    if isinstance(old, bool):
        return bool(new) if not isinstance(new, str) else new.lower() in ("1", "true", "yes", "on")
    if isinstance(old, int) and not isinstance(old, bool):
        return int(new)
    if isinstance(old, float) or old is None:
        return float(new)
    if isinstance(old, list):
        return [str(x).upper() for x in new]
    return new


def load_settings(env_file: Path | None = None) -> Settings:
    load_dotenv(env_file or ROOT / ".env")
    s = Settings(
        broker=os.environ.get("BROKER", "sim").strip().lower() or "sim",
        alpaca_key=os.environ.get("ALPACA_API_KEY", ""),
        alpaca_secret=os.environ.get("ALPACA_SECRET_KEY", ""),
        alpaca_paper=_bool("ALPACA_PAPER", True),
        data_feed=os.environ.get("ALPACA_DATA_FEED", "iex").strip().lower() or "iex",
        anthropic_key_set=bool(os.environ.get("ANTHROPIC_API_KEY")),
        ai_model=os.environ.get("AI_MODEL", "claude-opus-5-5"),
        allow_live_auto=_bool("ALLOW_LIVE_AUTO", False),
        host=os.environ.get("HOST", "127.0.0.1"),
        port=int(os.environ.get("PORT", "8000")),
        sim_speed=float(os.environ.get("SIM_SPEED", "60")),
    )
    p = Path(s.config_path)
    if p.exists():
        s.apply(json.loads(p.read_text(encoding="utf-8")))
    return s
