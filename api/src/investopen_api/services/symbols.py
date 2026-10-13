from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import Engine
from sqlalchemy.orm import Session

from ..models import SymbolMeta
from ..providers.base import MarketDataProvider

SYMBOL_TTL = timedelta(hours=24)


class SymbolService:
    def __init__(self, engine: Engine, provider: MarketDataProvider) -> None:
        self._engine = engine
        self._provider = provider

    def info(self, symbol: str) -> dict[str, Any]:
        symbol = symbol.upper()
        now = datetime.now(UTC)
        with Session(self._engine) as s:
            row = s.get(SymbolMeta, symbol)
            if row is not None:
                fetched = (
                    row.fetched_at if row.fetched_at.tzinfo else row.fetched_at.replace(tzinfo=UTC)
                )
                if now - fetched < SYMBOL_TTL:
                    return row.data
            data = self._provider.symbol_info(symbol)
            s.merge(SymbolMeta(symbol=symbol, data=data, fetched_at=now))
            s.commit()
            return data

    def search(self, query: str, limit: int) -> list[dict[str, Any]]:
        return self._provider.search(query, limit)
