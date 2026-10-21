from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import Engine, update
from sqlalchemy.orm import Session

from tickerglass_api.db import make_engine, run_migrations
from tickerglass_api.models import SymbolMeta
from tickerglass_api.providers.base import (
    RateLimited,
    SymbolNotFound,
    UpstreamUnavailable,
)
from tickerglass_api.services.symbols import SYMBOL_TTL, SymbolService


class InfoProvider:
    """Counts `symbol_info` calls; raises `error` when set."""

    def __init__(self) -> None:
        self.calls = 0
        self.error: Exception | None = None
        self.name = "Apple Inc."

    def symbol_info(self, symbol: str) -> dict[str, Any]:
        self.calls += 1
        if self.error is not None:
            raise self.error
        return {"symbol": symbol, "name": self.name}


@pytest.fixture
def engine(tmp_path: Path) -> Engine:
    url = f"sqlite:///{tmp_path}/s.db"
    run_migrations(url)
    return make_engine(url)


def _expire(engine: Engine) -> None:
    with Session(engine) as s:
        s.execute(update(SymbolMeta).values(fetched_at=datetime.now(UTC) - SYMBOL_TTL))
        s.commit()


def test_info_cached_then_refreshed(engine: Engine) -> None:
    provider = InfoProvider()
    svc = SymbolService(engine, provider)  # type: ignore[arg-type]
    assert svc.info("aapl")["name"] == "Apple Inc."
    svc.info("AAPL")
    assert provider.calls == 1

    _expire(engine)
    provider.name = "Apple"
    assert svc.info("AAPL")["name"] == "Apple"
    assert provider.calls == 2


@pytest.mark.parametrize("error", [RateLimited("slow down", 30), UpstreamUnavailable("offline")])
def test_info_serves_stale_row_when_refresh_fails(engine: Engine, error: Exception) -> None:
    provider = InfoProvider()
    svc = SymbolService(engine, provider)  # type: ignore[arg-type]
    svc.info("AAPL")
    _expire(engine)

    provider.error = error
    assert svc.info("AAPL") == {"symbol": "AAPL", "name": "Apple Inc."}
    assert provider.calls == 2


def test_info_errors_without_cached_row(engine: Engine) -> None:
    provider = InfoProvider()
    provider.error = UpstreamUnavailable("offline")
    svc = SymbolService(engine, provider)  # type: ignore[arg-type]
    with pytest.raises(UpstreamUnavailable):
        svc.info("AAPL")


def test_info_not_found_is_not_masked_by_stale_row(engine: Engine) -> None:
    provider = InfoProvider()
    svc = SymbolService(engine, provider)  # type: ignore[arg-type]
    svc.info("AAPL")
    _expire(engine)
    provider.error = SymbolNotFound("AAPL")
    with pytest.raises(SymbolNotFound):
        svc.info("AAPL")
