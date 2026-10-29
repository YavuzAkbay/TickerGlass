"""The cache's provider marker: switching provider wipes market data, never user data."""

from datetime import UTC, datetime
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, func, select
from sqlalchemy.orm import Session

from tickerglass_api.app import create_app
from tickerglass_api.db import make_engine, run_migrations
from tickerglass_api.models import AppMeta, Bar, Note, SeriesMeta, SymbolMeta
from tickerglass_api.providers.demo import DemoProvider
from tickerglass_api.services.cache_source import CACHE_SOURCE_KEY, ensure_cache_source
from tickerglass_api.settings import Settings

NOW = datetime(2026, 6, 17, 15, 0, tzinfo=UTC)


@pytest.fixture
def engine(tmp_path: Path) -> Engine:
    url = f"sqlite:///{tmp_path}/c.db"
    run_migrations(url)
    return make_engine(url)


def fill(engine: Engine) -> None:
    with Session(engine) as s, s.begin():
        s.add(
            Bar(
                symbol="AAPL",
                interval="1d",
                prepost=False,
                ts=1,
                open=1,
                high=1,
                low=1,
                close=1,
                adj_close=1,
                volume=1,
            )
        )
        s.add(
            SeriesMeta(
                symbol="AAPL", interval="1d", prepost=False, backfilled_at=NOW, tail_fetched_at=NOW
            )
        )
        s.add(SymbolMeta(symbol="AAPL", data={"symbol": "AAPL"}, fetched_at=NOW))
        s.merge(
            Note(id="n1", symbol="AAPL", text="keep me", revision=1, created_at=NOW, updated_at=NOW)
        )


def counts(engine: Engine) -> dict[str, int]:
    with Session(engine) as s:
        return {
            m.__tablename__: s.scalar(select(func.count()).select_from(m)) or 0
            for m in (Bar, SeriesMeta, SymbolMeta, Note)
        }


def marker(engine: Engine) -> object:
    with Session(engine) as s:
        row = s.get(AppMeta, CACHE_SOURCE_KEY)
        return row.value if row else None


def test_first_run_records_the_marker_and_keeps_the_cache(engine: Engine) -> None:
    fill(engine)
    assert ensure_cache_source(engine, "yahoo") is False
    assert marker(engine) == "yahoo"
    assert counts(engine) == {"bars": 1, "series_meta": 1, "symbol_meta": 1, "notes": 1}


def test_cache_without_a_marker_was_filled_by_yahoo(
    engine: Engine, caplog: pytest.LogCaptureFixture
) -> None:
    # Before the marker existed Yahoo was the only provider: its bars must not be served
    # as another provider's.
    fill(engine)
    with caplog.at_level("WARNING"):
        assert ensure_cache_source(engine, "twelvedata") is True
    assert counts(engine) == {"bars": 0, "series_meta": 0, "symbol_meta": 0, "notes": 1}
    assert marker(engine) == "twelvedata"
    assert "yahoo to twelvedata" in caplog.text


def test_empty_cache_without_a_marker_has_nothing_to_wipe(engine: Engine) -> None:
    assert ensure_cache_source(engine, "twelvedata") is False
    assert marker(engine) == "twelvedata"
    fill(engine)
    assert ensure_cache_source(engine, "twelvedata") is False
    assert counts(engine)["bars"] == 1


def test_same_provider_keeps_the_cache(engine: Engine) -> None:
    ensure_cache_source(engine, "yahoo")
    fill(engine)
    assert ensure_cache_source(engine, "yahoo") is False
    assert counts(engine)["bars"] == 1


def test_switching_provider_wipes_market_data_only(
    engine: Engine, caplog: pytest.LogCaptureFixture
) -> None:
    ensure_cache_source(engine, "yahoo")
    fill(engine)
    with caplog.at_level("WARNING"):
        assert ensure_cache_source(engine, "twelvedata") is True
    assert counts(engine) == {"bars": 0, "series_meta": 0, "symbol_meta": 0, "notes": 1}
    assert marker(engine) == "twelvedata"
    assert "yahoo to twelvedata" in caplog.text
    # And back again: each switch wipes what the other provider cached.
    fill(engine)
    assert ensure_cache_source(engine, "yahoo") is True
    assert counts(engine)["bars"] == 0


def test_a_failed_wipe_leaves_the_marker_unchanged(
    engine: Engine, monkeypatch: pytest.MonkeyPatch
) -> None:
    ensure_cache_source(engine, "yahoo")
    fill(engine)
    real_execute = Session.execute

    def failing(self: Session, statement: object, *a: object, **kw: object) -> object:
        if "symbol_meta" in str(statement):
            raise RuntimeError("disk full")
        return real_execute(self, statement, *a, **kw)  # type: ignore[arg-type]

    monkeypatch.setattr(Session, "execute", failing)
    with pytest.raises(RuntimeError):
        ensure_cache_source(engine, "twelvedata")
    monkeypatch.undo()
    assert marker(engine) == "yahoo"
    assert counts(engine)["bars"] == 1  # one transaction: nothing was deleted


def make_app(tmp_path: Path, provider_id: str | None) -> TestClient:
    kwargs = {"provider": DemoProvider()} if provider_id is None else {}
    app = create_app(
        database_url=f"sqlite:///{tmp_path}/a.db",
        settings_override=Settings(_env_file=None, market_provider=provider_id or "demo"),
        **kwargs,  # type: ignore[arg-type]
    )
    return TestClient(app)


def test_app_start_wipes_on_provider_change_and_skips_custom_providers(tmp_path: Path) -> None:
    url = f"sqlite:///{tmp_path}/a.db"
    run_migrations(url)
    engine = make_engine(url)
    ensure_cache_source(engine, "yahoo")
    fill(engine)

    with make_app(tmp_path, None):  # a custom provider: no marker logic at all
        pass
    assert marker(engine) == "yahoo"
    assert counts(engine)["bars"] == 1

    with make_app(tmp_path, "demo"):
        pass
    assert marker(engine) == "demo"
    assert counts(engine) == {"bars": 0, "series_meta": 0, "symbol_meta": 0, "notes": 1}


def test_marker_is_not_exported(tmp_path: Path) -> None:
    with make_app(tmp_path, "demo") as client:
        bundle = client.get("/api/export")
        assert bundle.status_code == 200, bundle.text
        assert "cache_source" not in bundle.text
        assert "app_meta" not in bundle.text
