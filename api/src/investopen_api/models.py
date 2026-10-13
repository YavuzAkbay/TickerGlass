from datetime import datetime
from typing import Any

from sqlalchemy import JSON, BigInteger, Boolean, DateTime, Float, String
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
