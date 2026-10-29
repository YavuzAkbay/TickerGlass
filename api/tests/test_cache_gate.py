"""The cache gate: a retired stack's commits are refused, and never block the wipe."""

import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Any

import pandas as pd
import pytest
from sqlalchemy import Engine, event, func, select
from sqlalchemy.orm import Session

from tickerglass_api.db import make_engine, run_migrations
from tickerglass_api.intervals import resolve_interval
from tickerglass_api.models import Bar, SeriesMeta, SymbolMeta
from tickerglass_api.providers.demo import DemoProvider
from tickerglass_api.services.bars import BarService
from tickerglass_api.services.cache_gate import CacheGate, CacheRetired
from tickerglass_api.services.cache_source import ensure_cache_source
from tickerglass_api.services.stats import CacheStats
from tickerglass_api.services.symbols import SymbolService


@pytest.fixture
def engine(tmp_path: Path) -> Engine:
    url = f"sqlite:///{tmp_path}/g.db"
    run_migrations(url)
    return make_engine(url)


def count(engine: Engine, model: Any) -> int:
    with Session(engine) as s:
        return s.scalar(select(func.count()).select_from(model)) or 0


class Hooked(DemoProvider):
    """Demo data; `on_history` / `on_info` run while a fetch is in flight."""

    def __init__(self) -> None:
        super().__init__()
        self.on_history: Any = None
        self.on_info: Any = None

    def history(
        self,
        symbol: str,
        interval: str,
        start: datetime | None,
        end: datetime | None,
        prepost: bool,
    ) -> pd.DataFrame:
        frame = super().history(symbol, interval, start, end, prepost)
        if self.on_history is not None:
            self.on_history()
        return frame

    def symbol_info(self, symbol: str) -> dict[str, Any]:
        info = super().symbol_info(symbol)
        if self.on_info is not None:
            self.on_info()
        return info


def test_gate_generations() -> None:
    gate = CacheGate()
    assert gate.generation == 0
    with gate.writing(0) as ok:
        assert ok
    assert gate.advance() == 1 and gate.generation == 1
    with gate.writing(0) as ok:
        assert not ok
    with gate.writing(1) as ok:
        assert ok


def test_retired_bar_service_is_refused_and_writes_nothing(engine: Engine) -> None:
    gate, stats, provider = CacheGate(), CacheStats(), Hooked()
    provider.on_history = gate.advance
    svc = BarService(engine, provider, stats=stats, gate=gate, generation=0)  # type: ignore[arg-type]
    with pytest.raises(CacheRetired):
        svc.get_bars("AAPL", resolve_interval("1d"), False)
    assert count(engine, Bar) == 0 and count(engine, SeriesMeta) == 0
    assert stats.counter("bars.retired_write") == 1


def test_current_bar_service_commits(engine: Engine) -> None:
    gate = CacheGate()
    gate.advance()
    svc = BarService(engine, DemoProvider(), gate=gate, generation=gate.generation)  # type: ignore[arg-type]
    assert not svc.get_bars("AAPL", resolve_interval("1d"), False).bars.empty
    assert count(engine, Bar) > 0 and count(engine, SeriesMeta) == 1


def test_retired_symbol_service_is_refused_and_writes_nothing(engine: Engine) -> None:
    gate, stats, provider = CacheGate(), CacheStats(), Hooked()
    provider.on_info = gate.advance
    svc = SymbolService(engine, provider, stats=stats, gate=gate, generation=0)  # type: ignore[arg-type]
    with pytest.raises(CacheRetired):
        svc.info("AAPL")
    assert count(engine, SymbolMeta) == 0
    assert stats.counter("symbols.retired_write") == 1


def test_services_without_a_gate_commit_as_before(engine: Engine) -> None:
    SymbolService(engine, DemoProvider()).info("AAPL")  # type: ignore[arg-type]
    assert count(engine, SymbolMeta) == 1


def test_wipe_while_an_old_writer_is_mid_transaction_neither_deadlocks_nor_leaves_rows(
    tmp_path: Path,
) -> None:
    """File SQLite: the old stack holds the database write lock (rows flushed, not yet
    committed) while the wipe, started after the gate advanced, is blocked on that lock.
    Only then does the writer reach its commit: it sees it is retired and rolls back,
    which lets the wipe through."""
    url = f"sqlite:///{tmp_path}/w.db"
    run_migrations(url)
    engine = make_engine(url)
    ensure_cache_source(engine, "demo")
    gate = CacheGate()
    in_transaction = threading.Event()
    release_writer = threading.Event()
    wiping = threading.Event()
    outcome: list[BaseException | str] = []

    class Slow(BarService):
        def _commit(self, s: Session) -> None:
            s.flush()  # the write lock is taken now
            in_transaction.set()
            assert release_writer.wait(10)
            super()._commit(s)

    svc = Slow(engine, DemoProvider(), gate=gate, generation=0)  # type: ignore[arg-type]

    @event.listens_for(engine, "before_cursor_execute")
    def _wipe_statement(*args: Any) -> None:
        # The wipe's first write: SQLite now waits for the writer's lock.
        if threading.current_thread().name == "wiper" and args[2].lstrip().startswith("DELETE"):
            wiping.set()

    def old_request() -> None:
        try:
            svc.get_bars("AAPL", resolve_interval("1d"), False)
            outcome.append("committed")
        except BaseException as exc:
            outcome.append(exc)

    wiped: list[bool] = []
    writer = threading.Thread(target=old_request)
    wiper = threading.Thread(target=lambda: wiped.append(ensure_cache_source(engine, "other")))
    wiper.name = "wiper"
    writer.start()
    assert in_transaction.wait(10)
    gate.advance()
    wiper.start()
    assert wiping.wait(10)
    time.sleep(0.2)  # the wipe is inside SQLite's busy wait, not past it
    assert wiper.is_alive() and not wiped, "the wipe got through the writer's lock"
    release_writer.set()
    wiper.join(20)
    writer.join(20)
    assert not wiper.is_alive() and not writer.is_alive(), "deadlock"
    assert wiped == [True]
    assert len(outcome) == 1 and isinstance(outcome[0], CacheRetired)
    assert count(engine, Bar) == 0 and count(engine, SeriesMeta) == 0
