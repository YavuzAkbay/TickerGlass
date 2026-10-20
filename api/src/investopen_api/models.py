from datetime import datetime
from typing import Any

from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base


class Bar(Base):
    """Cached OHLCV bar. `ts` is the bar open time in unix seconds (UTC).

    `close` is split-adjusted (as Yahoo returns it); `adj_close` is additionally
    dividend-adjusted. Adjusted OHLC is derived at read time via adj_close / close.
    """

    __tablename__ = "bars"

    symbol: Mapped[str] = mapped_column(String(32), primary_key=True)
    interval: Mapped[str] = mapped_column(String(8), primary_key=True)
    prepost: Mapped[bool] = mapped_column(Boolean, primary_key=True)
    ts: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    open: Mapped[float] = mapped_column(Float)
    high: Mapped[float] = mapped_column(Float)
    low: Mapped[float] = mapped_column(Float)
    close: Mapped[float] = mapped_column(Float)
    adj_close: Mapped[float] = mapped_column(Float)
    volume: Mapped[float] = mapped_column(Float)


class SeriesMeta(Base):
    """Fetch bookkeeping for one cached series."""

    __tablename__ = "series_meta"

    symbol: Mapped[str] = mapped_column(String(32), primary_key=True)
    interval: Mapped[str] = mapped_column(String(8), primary_key=True)
    prepost: Mapped[bool] = mapped_column(Boolean, primary_key=True)
    backfilled_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    tail_fetched_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class SymbolMeta(Base):
    """Cached symbol metadata (exchange, timezone, session, tick size, ...)."""

    __tablename__ = "symbol_meta"

    symbol: Mapped[str] = mapped_column(String(32), primary_key=True)
    data: Mapped[dict[str, Any]] = mapped_column(JSON)
    fetched_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


# ---------------------------------------------------------------- user data
#
# Phase 7 persistence (docs/persistence.md). JSON payloads are opaque to the
# server but carry `schema_version` so clients can upgrade old shapes on read.
# `revision` starts at 1 and is bumped on every content write (optimistic
# concurrency: writers send the revision they based their change on).


class Layout(Base):
    """A named chart layout: chart state + indicator instances + per-chart settings."""

    __tablename__ = "layouts"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    name: Mapped[str] = mapped_column(String(200))
    state: Mapped[dict[str, Any]] = mapped_column(JSON)
    schema_version: Mapped[int] = mapped_column(Integer)
    revision: Mapped[int] = mapped_column(Integer)
    is_last_used: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class DrawingRow(Base):
    """One drawing (engine `Drawing` JSON). `symbol` null = synced across symbols."""

    __tablename__ = "drawings"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    symbol: Mapped[str | None] = mapped_column(String(32), index=True)
    pane_id: Mapped[str] = mapped_column(String(64))
    z: Mapped[int] = mapped_column(Integer)
    data: Mapped[dict[str, Any]] = mapped_column(JSON)
    schema_version: Mapped[int] = mapped_column(Integer)
    revision: Mapped[int] = mapped_column(Integer)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class IndicatorTemplate(Base):
    """A named set of indicator instances."""

    __tablename__ = "indicator_templates"
    __table_args__ = (UniqueConstraint("name", name="uq_indicator_templates_name"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    name: Mapped[str] = mapped_column(String(200))
    instances: Mapped[list[Any]] = mapped_column(JSON)
    schema_version: Mapped[int] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class DrawingTemplate(Base):
    """A named style for one drawing tool; `is_default` marks the tool's default style."""

    __tablename__ = "drawing_templates"
    __table_args__ = (UniqueConstraint("tool_type", "name", name="uq_drawing_templates_type_name"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    tool_type: Mapped[str] = mapped_column(String(64), index=True)
    name: Mapped[str] = mapped_column(String(200))
    style: Mapped[dict[str, Any]] = mapped_column(JSON)
    is_default: Mapped[bool] = mapped_column(Boolean, default=False)
    schema_version: Mapped[int] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class ChartTemplate(Base):
    """A named chart style/theme template."""

    __tablename__ = "chart_templates"
    __table_args__ = (UniqueConstraint("name", name="uq_chart_templates_name"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    name: Mapped[str] = mapped_column(String(200))
    data: Mapped[dict[str, Any]] = mapped_column(JSON)
    schema_version: Mapped[int] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class Setting(Base):
    """User settings as key -> JSON value (favorites, saved defaults, UI prefs)."""

    __tablename__ = "settings"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[Any] = mapped_column(JSON)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class Note(Base):
    """A free-text note; `symbol` null = general note."""

    __tablename__ = "notes"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    symbol: Mapped[str | None] = mapped_column(String(32), index=True)
    text: Mapped[str] = mapped_column(Text)
    revision: Mapped[int] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class Watchlist(Base):
    """A named watchlist.

    `items` = ordered [{type:'symbol',symbol} | {type:'section',id,title,collapsed}].
    """

    __tablename__ = "watchlists"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    name: Mapped[str] = mapped_column(String(200))
    items: Mapped[list[Any]] = mapped_column(JSON)
    revision: Mapped[int] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class UserScript(Base):
    """A user-authored indicator script (docs/plans/user-scripts.md §5).

    `manifest` = the compiled definition manifest, null if the last save did not compile.
    """

    __tablename__ = "user_scripts"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    name: Mapped[str] = mapped_column(String(100))
    source: Mapped[str] = mapped_column(Text)
    manifest: Mapped[Any | None] = mapped_column(JSON, nullable=True)
    api_version: Mapped[int] = mapped_column(Integer)
    revision: Mapped[int] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class SymbolFlag(Base):
    """Global color flag of a symbol (one color per symbol)."""

    __tablename__ = "symbol_flags"

    symbol: Mapped[str] = mapped_column(String(32), primary_key=True)
    color: Mapped[str] = mapped_column(String(16))
    #: Flagged-at; reset when the color changes.
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


# ------------------------------------------------------------------- alerts
#
# Phase 10 (docs/alerts.md §1.1). Only the API writes these tables; the Node
# service goes through REST. `alert_states` is service-owned runtime state, kept
# apart so its writes never bump `alerts.revision`.


class Alert(Base):
    """A price/indicator alert. `spec` is the validated `AlertSpec` JSON."""

    __tablename__ = "alerts"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    name: Mapped[str] = mapped_column(String(200))
    symbol: Mapped[str] = mapped_column(String(128), index=True)
    interval: Mapped[str] = mapped_column(String(16))
    prepost: Mapped[bool] = mapped_column(Boolean)
    spec: Mapped[dict[str, Any]] = mapped_column(JSON)
    schema_version: Mapped[int] = mapped_column(Integer)
    message: Mapped[str] = mapped_column(Text)
    notify: Mapped[dict[str, Any]] = mapped_column(JSON)
    #: active | paused | triggered | expired | error
    status: Mapped[str] = mapped_column(String(16), index=True)
    status_reason: Mapped[str | None] = mapped_column(String(500))
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    #: First drawing operand of `spec` (derived by the server).
    drawing_id: Mapped[str | None] = mapped_column(String(64), index=True)
    revision: Mapped[int] = mapped_column(Integer)
    fire_count: Mapped[int] = mapped_column(Integer, default=0)
    last_fired_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class AlertState(Base):
    """Evaluator runtime state, valid only for the alert revision it was written for."""

    __tablename__ = "alert_states"

    alert_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("alerts.id", ondelete="CASCADE"), primary_key=True
    )
    revision: Mapped[int] = mapped_column(Integer)
    state: Mapped[dict[str, Any]] = mapped_column(JSON)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class AlertLog(Base):
    """One fire. Outlives its alert (`alert_id` is deliberately not a foreign key)."""

    __tablename__ = "alert_log"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    #: Idempotency key chosen by the service.
    fire_id: Mapped[str] = mapped_column(String(36), unique=True)
    alert_id: Mapped[str | None] = mapped_column(String(36), index=True)
    alert_name: Mapped[str] = mapped_column(String(200))
    symbol: Mapped[str] = mapped_column(String(128), index=True)
    interval: Mapped[str] = mapped_column(String(16))
    kind: Mapped[str] = mapped_column(String(8))
    fired_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    bar_time: Mapped[int] = mapped_column(BigInteger)
    message: Mapped[str] = mapped_column(Text)
    values: Mapped[dict[str, Any]] = mapped_column(JSON)
    delayed: Mapped[bool] = mapped_column(Boolean)
    final: Mapped[bool] = mapped_column(Boolean)
    read: Mapped[bool] = mapped_column(Boolean, default=False)


class AlertDelivery(Base):
    """Persisted outbox row: one external notification of one log entry."""

    __tablename__ = "alert_deliveries"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    log_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("alert_log.id", ondelete="CASCADE"), index=True
    )
    #: webhook | telegram | email
    channel: Mapped[str] = mapped_column(String(16))
    #: Per-alert webhook URL (null = the API's default).
    target: Mapped[str | None] = mapped_column(String(500))
    #: pending | sent | failed
    status: Mapped[str] = mapped_column(String(8))
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    next_attempt_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    last_error: Mapped[str | None] = mapped_column(String(500))
