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
from tickerglass_api.settings import Settings


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


class SearchProvider:
    """Counts `search` calls and returns `limit` rows (at most `total`)."""

    def __init__(self, total: int = 20) -> None:
        self.calls: list[tuple[str, int]] = []
        self.total = total
        self.error: Exception | None = None

    def search(self, query: str, limit: int) -> list[dict[str, Any]]:
        self.calls.append((query, limit))
        if self.error is not None:
            raise self.error
        return [{"symbol": f"{query.upper()}{i}"} for i in range(min(limit, self.total))]


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


def test_search_repeat_query_is_one_call(engine: Engine) -> None:
    provider = SearchProvider()
    svc = SymbolService(engine, provider)  # type: ignore[arg-type]
    first = svc.search("app", 5)
    assert svc.search("app", 5) == first
    assert len(provider.calls) == 1


def test_search_normalizes_case_and_whitespace(engine: Engine) -> None:
    provider = SearchProvider()
    svc = SymbolService(engine, provider)  # type: ignore[arg-type]
    svc.search("Apple", 5)
    for variant in ("apple", "  APPLE ", "aPPle\t"):
        assert svc.search(variant, 5)
    assert provider.calls == [("Apple", 5)]


def test_search_smaller_limit_slices_larger_refetches(engine: Engine) -> None:
    provider = SearchProvider()
    svc = SymbolService(engine, provider)  # type: ignore[arg-type]
    assert len(svc.search("a", 10)) == 10
    assert [r["symbol"] for r in svc.search("a", 3)] == ["A0", "A1", "A2"]
    assert len(svc.search("a", 10)) == 10
    assert provider.calls == [("a", 10)]
    assert len(svc.search("a", 15)) == 15
    assert provider.calls == [("a", 10), ("a", 15)]
    # The wider fetch now serves the narrower ones.
    assert len(svc.search("a", 10)) == 10
    assert len(provider.calls) == 2


def test_search_expires_and_serves_stale_on_error(engine: Engine) -> None:
    provider = SearchProvider()
    clock = Clock()
    svc = SymbolService(engine, provider, clock=clock)  # type: ignore[arg-type]
    first = svc.search("a", 5)
    clock.now += 86400 + 1
    provider.error = UpstreamUnavailable("offline")
    assert svc.search("a", 5) == first  # refetch failed, stale result served
    assert len(provider.calls) == 2
    provider.error = None
    assert svc.search("a", 5) == first
    assert len(provider.calls) == 3


def test_search_errors_without_cached_result(engine: Engine) -> None:
    provider = SearchProvider()
    provider.error = RateLimited("slow down", 30)
    svc = SymbolService(engine, provider)  # type: ignore[arg-type]
    with pytest.raises(RateLimited):
        svc.search("a", 5)
    provider.error = None
    assert svc.search("a", 5)


def test_unknown_symbol_is_remembered(engine: Engine) -> None:
    provider = InfoProvider()
    provider.error = SymbolNotFound("NOPE")
    clock = Clock()
    svc = SymbolService(
        engine,
        provider,  # type: ignore[arg-type]
        settings=Settings(cache_negative_ttl_s=3600),
        clock=clock,
    )
    for _ in range(3):
        with pytest.raises(SymbolNotFound):
            svc.info("nope")
    assert provider.calls == 1
    clock.now += 3601
    with pytest.raises(SymbolNotFound):
        svc.info("NOPE")
    assert provider.calls == 2
