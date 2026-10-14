from datetime import datetime
from typing import Any

from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    DateTime,
    Float,
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


class SymbolFlag(Base):
    """Global color flag of a symbol (one color per symbol)."""

    __tablename__ = "symbol_flags"

    symbol: Mapped[str] = mapped_column(String(32), primary_key=True)
    color: Mapped[str] = mapped_column(String(16))
    #: Flagged-at; reset when the color changes.
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
