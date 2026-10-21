import asyncio
import logging
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from alembic import command
from sqlalchemy import Engine, create_engine, inspect, select, text
from sqlalchemy.orm import Session
from test_userdata import alembic_config

from tickerglass_api.app import create_app
from tickerglass_api.db import Base, make_engine
from tickerglass_api.intervals import resolve_interval
from tickerglass_api.models import Bar, SeriesMeta, SymbolMeta
from tickerglass_api.services import maintenance
from tickerglass_api.services.bars import BarService, PruneReport
from tickerglass_api.services.maintenance import (
    VACUUM_MIN_FREE_BYTES,
    CacheMaintenance,
    should_vacuum,
)
from tickerglass_api.services.stats import CacheStats
from tickerglass_api.settings import Settings

NOW = datetime(2026, 10, 21, 12, tzinfo=UTC)
MB = 1024 * 1024


class NoProvider:
    """Upstream must not be touched by maintenance."""

    def __getattr__(self, name: str) -> object:
        raise AssertionError(f"unexpected upstream call: {name}")


def make_service(tmp_path: Path) -> tuple[Engine, BarService, CacheStats]:
    engine = make_engine(f"sqlite:///{tmp_path}/m.db")
    Base.metadata.create_all(engine)
    stats = CacheStats()
    return engine, BarService(engine, NoProvider(), stats=stats), stats  # type: ignore[arg-type]


def add_series(engine: Engine, symbol: str, interval: str, used: datetime, bars: int = 3) -> None:
    with Session(engine) as s:
        s.add(
            SeriesMeta(
                symbol=symbol,
                interval=interval,
                prepost=False,
                backfilled_at=used,
                tail_fetched_at=used,
                last_accessed_at=used,
            )
        )
        s.add_all(
            Bar(
                symbol=symbol,
                interval=interval,
                prepost=False,
                ts=1_700_000_000 + i * 60,
                open=1.0,
                high=2.0,
                low=0.5,
                close=1.5,
                adj_close=1.5,
                volume=10.0,
            )
            for i in range(bars)
        )
        s.commit()


def add_symbol(engine: Engine, symbol: str, fetched: datetime) -> None:
    with Session(engine) as s:
        s.add(SymbolMeta(symbol=symbol, data={"symbol": symbol}, fetched_at=fetched))
        s.commit()


def symbols(engine: Engine) -> set[str]:
    with Session(engine) as s:
        return set(s.scalars(select(SymbolMeta.symbol)))


def test_run_prunes_bars_and_purges_orphan_symbols(tmp_path: Path) -> None:
    engine, bars, stats = make_service(tmp_path)
    add_series(engine, "OLD", "1d", NOW - timedelta(days=400))
    add_series(engine, "KEEP", "1d", NOW - timedelta(days=2), bars=5)
    old = NOW - timedelta(days=45)
    add_symbol(engine, "OLD", old)  # its series is pruned in this run: now an orphan
    add_symbol(engine, "KEEP", old)  # still referenced by a series
    add_symbol(engine, "GONE", old)  # never had a series
    add_symbol(engine, "FRESH", NOW - timedelta(days=1))  # orphan, but recently refreshed

    report = CacheMaintenance(engine, bars, Settings(), stats).run_once(NOW)

    assert report.prune.daily_age_series == 1
    assert report.prune.rows_remaining == 5
    assert report.symbols_purged == 2
    assert symbols(engine) == {"KEEP", "FRESH"}
    assert stats.gauge("bars.rows") == 5
    assert stats.counter("maintenance.runs") == 1
    with Session(engine) as s:
        assert s.scalar(select(Bar.symbol).where(Bar.symbol == "OLD")) is None
    engine.dispose()


def test_run_calls_prune_with_settings(tmp_path: Path) -> None:
    engine, bars, stats = make_service(tmp_path)
    seen: list[tuple[Settings, datetime | None]] = []

    def fake_prune(settings: Settings, now: datetime | None = None) -> PruneReport:
        seen.append((settings, now))
        return PruneReport(rows_remaining=7)

    bars.prune_with_settings = fake_prune  # type: ignore[method-assign]
    settings = Settings(bars_max_rows=5)
    CacheMaintenance(engine, bars, settings, stats).run_once(NOW)
    assert seen == [(settings, NOW)]
    assert stats.gauge("bars.rows") == 7
    engine.dispose()


def test_should_vacuum_thresholds() -> None:
    page = 4096
    pages_64mb = VACUUM_MIN_FREE_BYTES // page
    total = pages_64mb * 10
    # Over both thresholds.
    assert should_vacuum(pages_64mb * 3, total, page)
    # Over 25% but under 64 MB.
    assert not should_vacuum(pages_64mb - 1, pages_64mb * 2, page)
    # Over 64 MB but under 25%.
    assert not should_vacuum(pages_64mb * 2, total, page)
    # Exactly at either limit does not trigger.
    assert not should_vacuum(total // 4, total, page)
    assert not should_vacuum(pages_64mb, pages_64mb * 2, page)
    # Empty or unreadable database.
    assert not should_vacuum(0, 0, page)
    assert not should_vacuum(5, 0, page)


def test_vacuum_runs_only_when_decided(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    engine, bars, stats = make_service(tmp_path)
    cm = CacheMaintenance(engine, bars, Settings(), stats)
    assert not cm.run_once(NOW).vacuumed

    monkeypatch.setattr(maintenance, "VACUUM_MIN_FREE_BYTES", 1024)
    monkeypatch.setattr(maintenance, "VACUUM_MIN_FREE_RATIO", 0.1)
    with engine.begin() as conn:
        conn.execute(text("CREATE TABLE junk (x BLOB)"))
        conn.execute(text("INSERT INTO junk VALUES (zeroblob(400000))"))
    with engine.begin() as conn:
        conn.execute(text("DROP TABLE junk"))
    with engine.connect() as conn:
        assert conn.execute(text("PRAGMA freelist_count")).scalar_one() > 0
    report = cm.run_once(NOW)
    assert report.vacuumed
    with engine.connect() as conn:
        assert conn.execute(text("PRAGMA freelist_count")).scalar_one() == 0
    engine.dispose()


def test_summary_logged_once_while_nothing_changes(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    engine, bars, stats = make_service(tmp_path)
    cm = CacheMaintenance(engine, bars, Settings(), stats)
    with caplog.at_level(logging.INFO, logger=maintenance.log.name):
        cm.run_once(NOW)
        cm.run_once(NOW)
        stats.incr("upstream.history.calls")
        cm.run_once(NOW)
    lines = [r.getMessage() for r in caplog.records if "cache maintenance" in r.getMessage()]
    assert len(lines) == 2
    assert "upstream.history.calls=1" in lines[1]
    engine.dispose()


def test_loop_survives_a_failing_run(tmp_path: Path, caplog: pytest.LogCaptureFixture) -> None:
    engine, bars, stats = make_service(tmp_path)
    calls = 0

    def flaky(settings: Settings, now: datetime | None = None) -> PruneReport:
        nonlocal calls
        calls += 1
        if calls == 1:
            raise RuntimeError("boom")
        return PruneReport()

    bars.prune_with_settings = flaky  # type: ignore[method-assign]
    cm = CacheMaintenance(engine, bars, Settings(), stats, first_delay_s=0, interval_s=0.01)

    async def scenario() -> None:
        cm.start()
        for _ in range(300):
            if stats.counter("maintenance.runs") >= 2:
                break
            await asyncio.sleep(0.01)
        await cm.stop()

    with caplog.at_level(logging.ERROR, logger=maintenance.log.name):
        asyncio.run(scenario())
    assert calls >= 3
    assert stats.counter("maintenance.runs") >= 2
    assert any("cache maintenance run failed" in r.getMessage() for r in caplog.records)
    engine.dispose()


def test_stop_before_first_run(tmp_path: Path) -> None:
    engine, bars, stats = make_service(tmp_path)
    cm = CacheMaintenance(engine, bars, Settings(), stats)  # first run in 60 s

    async def scenario() -> None:
        cm.start()
        await asyncio.sleep(0)
        await cm.stop()
        await cm.stop()  # idempotent

    asyncio.run(scenario())
    assert stats.counter("maintenance.runs") == 0
    engine.dispose()


def test_app_does_not_run_maintenance_when_disabled(tmp_path: Path) -> None:
    from fastapi.testclient import TestClient

    app = create_app(
        provider=NoProvider(),  # type: ignore[arg-type]
        database_url=f"sqlite:///{tmp_path}/a.db",
        settings_override=Settings(cache_maintenance_enabled=False),
    )
    with TestClient(app):
        assert app.state.cache_maintenance._task is None
    app = create_app(
        provider=NoProvider(),  # type: ignore[arg-type]
        database_url=f"sqlite:///{tmp_path}/b.db",
        settings_override=Settings(cache_maintenance_enabled=True),
    )
    with TestClient(app):
        assert app.state.cache_maintenance._task is not None
    assert app.state.cache_maintenance._task is None


# ------------------------------------------------------ bars WITHOUT ROWID migration

PREVIOUS = "d73d9998ea0e"


def bars_sql(engine: Engine) -> str:
    with engine.connect() as conn:
        return str(
            conn.execute(text("SELECT sql FROM sqlite_master WHERE name = 'bars'")).scalar_one()
        )


def test_bars_without_rowid_migration_up_down_up(tmp_path: Path) -> None:
    url = f"sqlite:///{tmp_path}/w.db"
    cfg = alembic_config(url)
    engine = create_engine(url)
    command.upgrade(cfg, PREVIOUS)
    assert "WITHOUT ROWID" not in bars_sql(engine)
    rows = [
        ("AAPL", "1d", 0, 1_700_000_000 + i * 86_400, 1.0 + i, 2.0, 0.5, 1.5, 1.4, 100.0 + i)
        for i in range(50)
    ] + [("MSFT", "5m", 1, 1_700_000_000, 3.0, 4.0, 2.0, 3.5, 3.5, 7.0)]
    with engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO bars (symbol, interval, prepost, ts, open, high, low, close, "
                "adj_close, volume) VALUES (:a, :b, :c, :d, :e, :f, :g, :h, :i, :j)"
            ),
            [dict(zip("abcdefghij", r, strict=True)) for r in rows],
        )

    def contents() -> list[tuple[object, ...]]:
        with engine.connect() as conn:
            result = conn.execute(
                text(f"SELECT {', '.join(BARS_COLUMNS)} FROM bars ORDER BY symbol, ts")
            )
            return [tuple(r) for r in result]

    before = contents()
    assert len(before) == 51

    command.upgrade(cfg, "head")
    assert "WITHOUT ROWID" in bars_sql(engine)
    assert contents() == before
    with engine.connect() as conn:
        flags = conn.execute(text("SELECT wr FROM pragma_table_list('bars')")).scalar_one()
    assert flags == 1
    assert [c["name"] for c in inspect(engine).get_columns("bars")] == list(BARS_COLUMNS)
    assert inspect(engine).get_pk_constraint("bars")["constrained_columns"] == [
        "symbol",
        "interval",
        "prepost",
        "ts",
    ]

    command.downgrade(cfg, PREVIOUS)
    assert "WITHOUT ROWID" not in bars_sql(engine)
    assert contents() == before

    command.upgrade(cfg, "head")
    assert "WITHOUT ROWID" in bars_sql(engine)
    assert contents() == before
    engine.dispose()


BARS_COLUMNS = (
    "symbol",
    "interval",
    "prepost",
    "ts",
    "open",
    "high",
    "low",
    "close",
    "adj_close",
    "volume",
)


def test_model_creates_bars_without_rowid(tmp_path: Path) -> None:
    engine = create_engine(f"sqlite:///{tmp_path}/c.db")
    Base.metadata.create_all(engine)
    assert "WITHOUT ROWID" in bars_sql(engine)
    engine.dispose()


def make_free_pages(engine: Engine) -> None:
    with engine.begin() as conn:
        conn.execute(text("CREATE TABLE junk (x BLOB)"))
        conn.execute(text("INSERT INTO junk VALUES (zeroblob(400000))"))
    with engine.begin() as conn:
        conn.execute(text("DROP TABLE junk"))


def test_vacuum_waits_until_bar_requests_go_quiet(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    engine, bars, stats = make_service(tmp_path)
    monkeypatch.setattr(maintenance, "VACUUM_MIN_FREE_BYTES", 1024)
    monkeypatch.setattr(maintenance, "VACUUM_MIN_FREE_RATIO", 0.1)
    add_series(engine, "AAPL", "1d", NOW)
    # A bar request a minute ago (served from the cache, no upstream call).
    bars.get_bars("AAPL", resolve_interval("1d"), False, now=NOW - timedelta(minutes=1))
    make_free_pages(engine)
    cm = CacheMaintenance(engine, bars, Settings(), stats)
    report = cm.run_once(NOW)
    assert not report.vacuumed and report.vacuum_deferred
    assert stats.counter("maintenance.vacuum_deferred") == 1
    report = cm.run_once(NOW + maintenance.VACUUM_IDLE)
    assert report.vacuumed
    engine.dispose()


def test_sqlite_writers_wait_for_a_busy_database(tmp_path: Path) -> None:
    engine = make_engine(f"sqlite:///{tmp_path}/b.db")
    with engine.connect() as conn:
        assert conn.execute(text("PRAGMA busy_timeout")).scalar_one() >= 30_000
    engine.dispose()


def test_bars_without_rowid_migration_survives_a_leftover_table(tmp_path: Path) -> None:
    url = f"sqlite:///{tmp_path}/l.db"
    cfg = alembic_config(url)
    engine = create_engine(url)
    command.upgrade(cfg, PREVIOUS)
    # An earlier upgrade crashed after creating the copy.
    with engine.begin() as conn:
        conn.execute(text("CREATE TABLE bars_new (x INTEGER)"))
    command.upgrade(cfg, "head")
    assert "WITHOUT ROWID" in bars_sql(engine)
    engine.dispose()
