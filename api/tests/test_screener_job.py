"""The screener job (services/screener/job.py): queue, pacing, budgets, lease, lifecycle.

Fake clock and sleep (sleeping advances the clock), a throwaway SQLite file per job (worker
threads and the test use separate connections), the demo provider's offline bars behind a
scripted fake. No network.
"""

import asyncio
import threading
from collections.abc import Callable, Coroutine
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import pandas as pd
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, func, select, update
from sqlalchemy.orm import Session

from tickerglass_api.app import create_app
from tickerglass_api.db import Base, make_engine
from tickerglass_api.models import ScreenerRun, ScreenerSnapshot, ScreenerSymbol
from tickerglass_api.providers.base import RateLimited, SymbolNotFound
from tickerglass_api.providers.demo import DemoProvider
from tickerglass_api.providers.guard import GuardedProvider, UpstreamGuard
from tickerglass_api.services.bars import BarService
from tickerglass_api.services.cache_gate import CacheGate
from tickerglass_api.services.cache_source import ensure_cache_source
from tickerglass_api.services.screener import alerts as screen_alerts
from tickerglass_api.services.screener.job import RunInProgress, ScreenerJob
from tickerglass_api.services.screener.lease import LEASE_TTL, Lease
from tickerglass_api.services.stats import CacheStats
from tickerglass_api.settings import Settings

NY = ZoneInfo("America/New_York")
#: Friday after the close: the target session is that Friday.
START = datetime(2026, 11, 6, 18, 0, tzinfo=NY)
TARGET = date(2026, 11, 6)
EPOCH = datetime(2026, 1, 1, tzinfo=UTC)


class Clock:
    """Job clock; `sleep` records the delay and moves the clock on. With `hold_after` set,
    the sleep after that many sleeps waits for `release`."""

    def __init__(self, start: datetime = START) -> None:
        self.t = start.astimezone(UTC)
        self.sleeps: list[float] = []
        self.hold_after: int | None = None
        self.release = asyncio.Event()
        self.held = asyncio.Event()
        self.on_sleep: Callable[[], None] | None = None

    def now(self) -> datetime:
        return self.t

    def mono(self) -> float:
        return (self.t - EPOCH).total_seconds()

    async def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.t += timedelta(seconds=seconds)
        if self.on_sleep is not None:
            self.on_sleep()
        if self.hold_after is not None and len(self.sleeps) > self.hold_after:
            self.held.set()
            await self.release.wait()
        await asyncio.sleep(0)


class FakeProvider:
    """Demo bars, with scripted failures; records every history call."""

    def __init__(self, clock: Clock) -> None:
        self.demo = DemoProvider(clock=clock.now)
        self.calls: list[str] = []
        self.not_found: set[str] = set()
        #: The next this many history calls are refused upstream.
        self.rate_limited = 0

    def history(
        self,
        symbol: str,
        interval: str,
        start: datetime | None,
        end: datetime | None,
        prepost: bool,
    ) -> pd.DataFrame:
        self.calls.append(symbol)
        if symbol in self.not_found:
            raise SymbolNotFound(symbol)
        if self.rate_limited:
            self.rate_limited -= 1
            raise RateLimited("slow down", retry_after=5)
        return self.demo.history(symbol, interval, start, end, prepost)

    def __getattr__(self, name: str) -> Any:
        return getattr(self.demo, name)


class Ctx:
    #: Where `Ctx` databases go (set per test by `_db_dir`).
    db_dir: Path
    _count = 0

    def __init__(
        self,
        clock: Clock,
        symbols: list[tuple[str, str]],
        *,
        guard: dict[str, Any] | None = None,
        settings: dict[str, Any] | None = None,
        provider_id: str = "demo",
        gate: CacheGate | None = None,
        provider: Any = None,
    ) -> None:
        self.clock = clock
        Ctx._count += 1
        self.engine: Engine = make_engine(f"sqlite:///{Ctx.db_dir}/job{Ctx._count}.db")
        Base.metadata.create_all(self.engine)
        with Session(self.engine) as s:
            for rank, (sym, cls) in enumerate(symbols, start=1):
                s.add(
                    ScreenerSymbol(
                        symbol=sym,
                        cls=cls,
                        name=sym,
                        grp="Test",
                        exchange=None,
                        rank=rank,
                        cap_static=None,
                        source="bundled",
                        fail_count=0,
                        updated_at=clock.now(),
                    )
                )
            s.commit()
        self.stats = CacheStats()
        self.guard = UpstreamGuard(
            **{
                "rate_per_min": 600,
                "burst": 100,
                "cooldown_max_s": 0,
                "unavailable_cooldown_s": 0,
                **(guard or {}),
            },
            clock=clock.mono,
            sleep=lambda s: None,
            utcnow=clock.now,
        )
        self.provider = provider if provider is not None else FakeProvider(clock)
        self.guarded = GuardedProvider(self.provider, self.guard, self.stats)
        self.bars = BarService(self.engine, self.guarded, stats=self.stats)
        self.settings = Settings(_env_file=None, **(settings or {}))  # type: ignore[call-arg]
        self.job = ScreenerJob(
            self.engine,
            self.bars,
            self.guarded,
            self.guard,
            self.stats,
            self.settings,
            provider_id=provider_id,
            gate=gate,
            clock=clock.now,
            sleep=clock.sleep,
            first_delay_s=0,
        )

    async def run(self, kind: str = "snapshot") -> ScreenerRun:
        run_id = self.job.trigger(kind)  # type: ignore[arg-type]
        await self.job.wait()
        return self.run_row(run_id)

    def run_row(self, run_id: int) -> ScreenerRun:
        with Session(self.engine) as s:
            row = s.get(ScreenerRun, run_id)
            assert row is not None
            s.expunge(row)
            return row

    def snapshots(self) -> dict[str, ScreenerSnapshot]:
        with Session(self.engine) as s:
            rows = list(s.scalars(select(ScreenerSnapshot)))
            for r in rows:
                s.expunge(r)
            return {r.symbol: r for r in rows}

    def symbol(self, sym: str) -> ScreenerSymbol:
        with Session(self.engine) as s:
            row = s.get(ScreenerSymbol, sym)
            assert row is not None
            s.expunge(row)
            return row


@pytest.fixture(autouse=True)
def _db_dir(tmp_path: Path) -> None:
    Ctx.db_dir = tmp_path


def run_async(fn: Callable[[], Coroutine[Any, Any, None]]) -> None:
    asyncio.run(fn())


STOCKS = [("AAA", "stocks"), ("BBB", "stocks"), ("CCC", "stocks")]


# ------------------------------------------------------------------ runs


def test_snapshot_run_paces_by_upstream_requests() -> None:
    async def scenario() -> None:
        clock = Clock()
        ctx = Ctx(clock, STOCKS)
        run = await ctx.run()
        assert (run.status, run.total, run.done, run.failed, run.tokens) == ("done", 3, 3, 0, 3)
        assert run.target_date == TARGET
        assert run.finished_at is not None
        # One backfill request each at min(24, 600 / 3) per minute.
        assert clock.sleeps == [2.5, 2.5, 2.5]
        snaps = ctx.snapshots()
        assert set(snaps) == {"AAA", "BBB", "CCC"}
        snap = snaps["AAA"]
        assert snap.as_of_date == TARGET
        assert snap.provider == "demo"
        assert snap.bars_count == 450
        assert snap.sma200 is not None and snap.rsi14 is not None and snap.hi52 is not None
        # Again with the snapshots gone: the bars are cache hits, no request, no wait.
        with Session(ctx.engine) as s:
            s.query(ScreenerSnapshot).delete()
            s.commit()
        clock.sleeps.clear()
        run = await ctx.run()
        assert (run.status, run.done, run.tokens) == ("done", 3, 0)
        assert clock.sleeps == []
        # Nothing stale left: a manual run is refused for 10 min, then an empty run.
        with pytest.raises(RunInProgress, match="snapshots already done for 2026-11-06"):
            ctx.job.trigger("snapshot")
        clock.t += timedelta(minutes=10)
        run = await ctx.run()
        assert (run.status, run.total) == ("done", 0)

    run_async(scenario)


def test_rate_capped_by_a_third_of_the_sustainable_rate() -> None:
    async def scenario() -> None:
        clock = Clock()
        ctx = Ctx(clock, STOCKS[:1], guard={"rate_per_min": 30})
        assert ctx.job.rate_per_min() == 10
        await ctx.run()
        assert clock.sleeps == [6.0]

    run_async(scenario)


def test_guard_refusal_waits_and_is_not_a_failure() -> None:
    async def scenario() -> None:
        clock = Clock()
        ctx = Ctx(clock, STOCKS[:1], guard={"rate_per_min": 60, "burst": 4})
        ctx.guard.acquire(4)  # interactive traffic took the whole burst
        run = await ctx.run()
        assert (run.status, run.done, run.failed) == ("done", 1, 0)
        assert ctx.stats.counter("upstream.history.refused") == 1
        # Waited the refusal's retry_after (2 tokens short at 1/s), then paced (60/3 per min).
        assert clock.sleeps == [2.0, 3.0]

    run_async(scenario)


def test_three_upstream_rate_limits_abort_the_run() -> None:
    async def scenario() -> None:
        clock = Clock()
        ctx = Ctx(clock, STOCKS[:2])
        provider: FakeProvider = ctx.provider
        provider.rate_limited = 10
        called: list[Any] = []
        ctx.job.bind(hub=lambda: "hub", dispatcher=lambda: "dispatcher")
        orig = screen_alerts.evaluate_screens
        screen_alerts.evaluate_screens = lambda *a, **k: called.append(k) or 0  # type: ignore[assignment]
        try:
            run = await ctx.run()
        finally:
            screen_alerts.evaluate_screens = orig
        assert run.status == "aborted"
        assert run.error is not None and "rate limited 3" in run.error
        assert provider.calls == ["AAA"] * 3
        assert clock.sleeps == [5.0, 5.0]
        assert ctx.snapshots() == {}
        assert called == []  # no alerts after an aborted run
        assert Lease(ctx.engine, "screener").holder(clock.now()) is None

    run_async(scenario)


def test_restart_resumes_with_stale_symbols_oldest_first() -> None:
    async def scenario() -> None:
        clock = Clock()
        ctx = Ctx(clock, [*STOCKS, ("DDD", "stocks")])
        old = datetime(2026, 11, 3, 23, 0, tzinfo=UTC)
        with Session(ctx.engine) as s:
            for sym, as_of, computed in (
                ("AAA", TARGET, clock.now()),  # fresh
                ("BBB", date(2026, 11, 3), old),  # stale
                ("DDD", date(2026, 11, 5), clock.now()),  # computed after the close: no newer bar
            ):
                s.add(
                    ScreenerSnapshot(
                        symbol=sym,
                        provider="demo",
                        as_of_date=as_of,
                        bar_ts=0,
                        computed_at=computed,
                        bars_count=0,
                    )
                )
            s.commit()
        run = await ctx.run()
        assert run.total == 2
        provider: FakeProvider = ctx.provider
        assert provider.calls == ["CCC", "BBB"]  # never snapshotted first, then the oldest
        assert ctx.snapshots()["BBB"].as_of_date == TARGET

    run_async(scenario)


def test_not_found_three_times_tombstones() -> None:
    async def scenario() -> None:
        clock = Clock()
        ctx = Ctx(clock, [("AAA", "stocks"), ("ZZZ", "stocks")])
        provider: FakeProvider = ctx.provider
        provider.not_found.add("ZZZ")
        for expected in (1, 2, 3):
            run = await ctx.run()
            assert run.status == "partial"
            assert run.failed == 1
            row = ctx.symbol("ZZZ")
            assert row.fail_count == expected
            assert row.last_error == "symbol not found"
        assert ctx.symbol("ZZZ").tombstoned_at is not None
        run = await ctx.run()
        assert (run.status, run.total) == ("done", 0)

    run_async(scenario)


def test_success_resets_fail_count() -> None:
    async def scenario() -> None:
        clock = Clock()
        ctx = Ctx(clock, [("ZZZ", "stocks")])
        provider: FakeProvider = ctx.provider
        provider.not_found.add("ZZZ")
        await ctx.run()
        assert ctx.symbol("ZZZ").fail_count == 1
        provider.not_found.clear()
        clock.t += timedelta(hours=2)  # past the bar cache's memory of the unknown symbol
        run = await ctx.run()
        assert run.status == "done"
        row = ctx.symbol("ZZZ")
        assert (row.fail_count, row.last_error, row.tombstoned_at) == (0, None, None)

    run_async(scenario)


def test_second_lease_holder_gets_nothing() -> None:
    async def scenario() -> None:
        clock = Clock()
        ctx = Ctx(clock, STOCKS)
        assert Lease(ctx.engine, "screener", owner="other-worker").acquire(clock.now())
        with pytest.raises(RunInProgress):
            ctx.job.trigger("snapshot")
        with Session(ctx.engine) as s:
            assert s.scalar(select(func.count()).select_from(ScreenerRun)) == 0
        provider: FakeProvider = ctx.provider
        assert provider.calls == []

    run_async(scenario)


def test_losing_the_lease_aborts() -> None:
    async def scenario() -> None:
        clock = Clock()
        ctx = Ctx(clock, STOCKS)
        other = Lease(ctx.engine, "screener", owner="other-worker")

        def steal() -> None:
            clock.t += LEASE_TTL + timedelta(seconds=1)
            other.acquire(clock.now())
            clock.on_sleep = None

        clock.on_sleep = steal
        run = await ctx.run()
        assert run.status == "aborted"
        assert run.error is not None and "lease" in run.error
        assert other.holder(clock.now()) == "other-worker"

    run_async(scenario)


def test_trigger_while_running_and_runtime_shape() -> None:
    async def scenario() -> None:
        clock = Clock()
        ctx = Ctx(clock, STOCKS)
        job = ctx.job
        rt = job.runtime()
        assert rt == {
            "enabled": True,
            "supported": True,
            "reason": "first_run",
            "running": None,
            "nextRunAt": "2026-11-09T22:15:00Z",  # Monday 17:15 New York
            "ratePerMin": 24,
        }
        clock.hold_after = 0
        run_id = job.trigger("snapshot")
        await clock.held.wait()
        with pytest.raises(RunInProgress):
            job.trigger("fundamentals")
        with pytest.raises(RunInProgress):
            job.trigger("snapshot")
        running = job.runtime()["running"]
        assert running is not None
        assert set(running) == {"runId", "kind", "done", "total", "startedAt", "etaS"}
        assert running["runId"] == run_id
        assert running["kind"] == "snapshot"
        assert (running["done"], running["total"]) == (0, 3)
        assert running["startedAt"] == "2026-11-06T23:00:00Z"
        assert running["etaS"] is not None
        clock.release.set()
        await job.wait()
        rt = job.runtime()
        assert rt["running"] is None
        assert rt["reason"] is None

    run_async(scenario)


def test_enabled_by_provider() -> None:
    clock = Clock()
    td = Ctx(clock, [], provider_id="twelvedata").job.runtime()
    assert (td["enabled"], td["reason"], td["nextRunAt"]) == (False, "disabled", None)
    forced = Ctx(clock, [], provider_id="twelvedata", settings={"screener_enabled": True})
    assert forced.job.enabled
    off = Ctx(clock, [], provider_id="yahoo", settings={"screener_enabled": False})
    assert not off.job.enabled
    assert Ctx(clock, [], provider_id="yahoo").job.enabled


def test_target_date() -> None:
    job = Ctx(Clock(), []).job
    assert job.target_date(datetime(2026, 11, 6, 16, 10, tzinfo=NY)) == date(2026, 11, 5)
    assert job.target_date(datetime(2026, 11, 6, 16, 20, tzinfo=NY)) == TARGET  # settled
    assert job.target_date(datetime(2026, 11, 8, 12, 0, tzinfo=NY)) == TARGET  # Sunday
    assert job.next_run_at(datetime(2026, 11, 9, 9, 0, tzinfo=NY)) == datetime(
        2026, 11, 9, 17, 15, tzinfo=NY
    )


def test_target_date_and_schedule_skip_holidays() -> None:
    job = Ctx(Clock(), []).job
    # Thanksgiving 2026-11-26 (Thursday) and the early close the day after.
    assert job.target_date(datetime(2026, 11, 26, 18, 0, tzinfo=NY)) == date(2026, 11, 25)
    assert job.target_date(datetime(2026, 11, 27, 12, 0, tzinfo=NY)) == date(2026, 11, 25)
    assert job.target_date(datetime(2026, 11, 27, 13, 10, tzinfo=NY)) == date(2026, 11, 25)
    assert job.target_date(datetime(2026, 11, 27, 13, 20, tzinfo=NY)) == date(2026, 11, 27)
    assert job.target_date(datetime(2026, 11, 30, 9, 0, tzinfo=NY)) == date(2026, 11, 27)
    # Good Friday 2026-04-03: the Monday's target is Thursday.
    assert job.target_date(datetime(2026, 4, 6, 9, 0, tzinfo=NY)) == date(2026, 4, 2)
    assert job.next_run_at(datetime(2026, 11, 25, 18, 0, tzinfo=NY)) == datetime(
        2026, 11, 27, 17, 15, tzinfo=NY
    )
    assert job.next_run_at(datetime(2026, 4, 2, 18, 0, tzinfo=NY)) == datetime(
        2026, 4, 6, 17, 15, tzinfo=NY
    )
    assert job.next_run_at(datetime(2026, 12, 24, 18, 0, tzinfo=NY)) == datetime(
        2026, 12, 28, 17, 15, tzinfo=NY
    )


def test_extra_holidays_setting_moves_target_and_schedule() -> None:
    ctx = Ctx(Clock(), [], settings={"market_extra_holidays": [date(2026, 11, 9)]})
    assert ctx.job.target_date(datetime(2026, 11, 10, 9, 0, tzinfo=NY)) == TARGET
    assert ctx.job.next_run_at(datetime(2026, 11, 6, 18, 0, tzinfo=NY)) == datetime(
        2026, 11, 10, 17, 15, tzinfo=NY
    )


def test_stop_mid_run_aborts_and_switch_wipes() -> None:
    async def scenario() -> None:
        clock = Clock()
        gate = CacheGate()
        ctx = Ctx(clock, STOCKS, gate=gate)
        ensure_cache_source(ctx.engine, "demo")
        clock.hold_after = 1  # the pacing sleep of the second symbol blocks
        run_id = ctx.job.trigger("snapshot")
        await clock.held.wait()
        assert set(ctx.snapshots()) == {"AAA"}
        # A provider switch: new generation, cache wiped, old stack retired.
        gate.advance()
        assert ensure_cache_source(ctx.engine, "yahoo")
        await ctx.job.stop()
        run = ctx.run_row(run_id)
        assert (run.status, run.error) == ("aborted", "stopped")
        assert run.finished_at is not None
        assert ctx.snapshots() == {}
        assert Lease(ctx.engine, "screener").holder(clock.now()) is None
        with pytest.raises(RunInProgress):
            ctx.job.trigger("snapshot")

    run_async(scenario)


def test_write_after_switch_aborts() -> None:
    async def scenario() -> None:
        clock = Clock()
        gate = CacheGate()
        ctx = Ctx(clock, STOCKS, gate=gate)
        gate.advance()  # the job's generation (0) is retired
        run = await ctx.run()
        assert run.status == "aborted"
        assert run.error == "the provider was switched"
        assert ctx.snapshots() == {}

    run_async(scenario)


def test_evaluate_screens_called_after_snapshot_run(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[dict[str, Any]] = []

    def fake(session: Session, settings: Settings, **kw: Any) -> int:
        assert isinstance(session, Session) and isinstance(settings, Settings)
        calls.append(kw)
        return 2

    monkeypatch.setattr(screen_alerts, "evaluate_screens", fake)

    async def scenario() -> None:
        clock = Clock()
        ctx = Ctx(clock, [("AAA", "stocks"), ("ZZZ", "stocks")])
        provider: FakeProvider = ctx.provider
        provider.not_found.add("ZZZ")
        ctx.job.bind(hub=lambda: "hub", dispatcher=lambda: "dispatcher")
        run = await ctx.run()
        assert run.status == "partial"  # partial runs evaluate too, as incomplete
        assert calls == [
            {
                "as_of": TARGET,
                "hub": "hub",
                "dispatcher": "dispatcher",
                "now": clock.now(),
                "complete": False,
            }
        ]
        with Session(ctx.engine) as s:  # ZZZ leaves the tracked set: nothing fails any more
            s.execute(
                update(ScreenerSymbol)
                .where(ScreenerSymbol.symbol == "ZZZ")
                .values(tombstoned_at=clock.now())
            )
            s.commit()
        run = await ctx.run()
        assert run.status == "done" and calls[-1]["complete"] is True

    run_async(scenario)


def test_scheduler_skips_done_target_and_runs_next_weekday() -> None:
    async def scenario() -> None:
        clock = Clock()
        ctx = Ctx(clock, STOCKS[:1])
        with Session(ctx.engine) as s:
            s.add(
                ScreenerRun(
                    kind="snapshot",
                    trigger="manual",
                    provider="demo",
                    target_date=TARGET,
                    status="done",
                    total=0,
                    done=0,
                    failed=0,
                    tokens=0,
                    started_at=clock.now(),
                )
            )
            s.commit()
        ctx.job.start()
        for _ in range(1000):
            await asyncio.sleep(0.005)
            with Session(ctx.engine) as s:
                runs = list(s.scalars(select(ScreenerRun).order_by(ScreenerRun.id)))
            if len(runs) >= 2 and runs[1].status != "running":
                break
        await ctx.job.stop()
        assert len(runs) >= 2
        nxt = runs[1]
        assert ctx.symbol("AAA").last_error is None
        assert (nxt.trigger, nxt.target_date, nxt.status) == ("schedule", date(2026, 11, 9), "done")
        assert nxt.started_at.replace(tzinfo=UTC) >= datetime(2026, 11, 9, 22, 15, tzinfo=UTC)

    run_async(scenario)


# ----------------------------------------------------------------- stack


def test_stack_starts_and_stops_the_job(tmp_path: Path) -> None:
    app = create_app(
        database_url=f"sqlite:///{tmp_path}/app.db",
        settings_override=Settings(_env_file=None, market_provider="demo"),  # type: ignore[call-arg]
    )
    with TestClient(app):
        job: ScreenerJob = app.state.market_stack.screener
        assert isinstance(job, ScreenerJob)
        assert job.provider_id == "demo"
        assert job._schedule_task is not None  # scheduled; first check after 60 s
        assert job.runtime()["reason"] == "first_run"
    assert job.stopping
    assert job._schedule_task is None


def test_custom_provider_stack_is_not_scheduled(tmp_path: Path) -> None:
    app = create_app(
        provider=DemoProvider(),
        database_url=f"sqlite:///{tmp_path}/app.db",
        settings_override=Settings(_env_file=None),  # type: ignore[call-arg]
    )
    with TestClient(app):
        job: ScreenerJob = app.state.market_stack.screener
        assert job.provider_id == "custom"
        assert job._schedule_task is None
        assert job.runtime()["reason"] == "disabled"


# ------------------------------------------------------- review fixes


def _run_row(**kw: Any) -> ScreenerRun:
    values: dict[str, Any] = {
        "kind": "snapshot",
        "trigger": "manual",
        "provider": "demo",
        "target_date": TARGET,
        "status": "done",
        "total": 0,
        "done": 0,
        "failed": 0,
        "tokens": 0,
        "started_at": START.astimezone(UTC),
        **kw,
    }
    return ScreenerRun(**values)


def test_stale_running_rows_are_aborted_on_lease_acquire() -> None:
    async def scenario() -> None:
        clock = Clock()
        ctx = Ctx(clock, STOCKS[:1])
        with Session(ctx.engine) as s:
            s.add(_run_row(status="running", provider="yahoo"))
            s.commit()
        assert ctx.job.runtime()["running"] is None
        run = await ctx.run()
        assert run.status == "done"
        with Session(ctx.engine) as s:
            stale = s.scalars(select(ScreenerRun).where(ScreenerRun.id != run.id)).one()
        assert (stale.status, stale.error) == ("aborted", "stale (process exit)")
        assert stale.finished_at is not None

    run_async(scenario)


def test_a_lease_refusal_leaves_running_rows_alone() -> None:
    clock = Clock()
    ctx = Ctx(clock, STOCKS[:1])
    assert Lease(ctx.engine, "screener", owner="other").acquire(clock.now())
    with Session(ctx.engine) as s:
        s.add(_run_row(status="running"))
        s.commit()
    with pytest.raises(RunInProgress):
        ctx.job.trigger("snapshot")
    with Session(ctx.engine) as s:
        assert s.scalars(select(ScreenerRun.status)).all() == ["running"]


def test_trigger_async_claims_off_the_event_loop(monkeypatch: pytest.MonkeyPatch) -> None:
    async def scenario() -> None:
        clock = Clock()
        ctx = Ctx(clock, STOCKS[:1])
        loop_thread = threading.get_ident()
        threads: list[int] = []
        real = ctx.job._claim

        def claim(kind: Any, trigger: str) -> Any:
            threads.append(threading.get_ident())
            return real(kind, trigger)

        monkeypatch.setattr(ctx.job, "_claim", claim)
        run_id = await ctx.job.trigger_async("snapshot", trigger="schedule")
        await ctx.job.wait()
        assert ctx.run_row(run_id).status == "done"
        assert threads and threads[0] != loop_thread

        # The scheduler goes through it too.
        threads.clear()
        clock.t += timedelta(days=3)  # Monday after the close: a new target
        await ctx.job._cycle()
        await ctx.job.wait()
        assert threads and threads[0] != loop_thread

    run_async(scenario)


def test_manual_fundamentals_cooldown() -> None:
    async def scenario() -> None:
        clock = Clock()
        ctx = Ctx(clock, STOCKS[:1])
        with Session(ctx.engine) as s:
            s.add(_run_row(kind="fundamentals", finished_at=clock.now() - timedelta(minutes=30)))
            s.add(_run_row(kind="fundamentals", target_date=date(2026, 11, 5), status="done"))
            s.commit()
        with pytest.raises(
            RunInProgress, match="fundamentals already done for 2026-11-06; retry after 1h"
        ):
            ctx.job.trigger("fundamentals")
        clock.t += timedelta(minutes=30)
        run = await ctx.run("fundamentals")  # the cooldown is over (the demo fake has none)
        assert run.status == "failed"

    run_async(scenario)


def test_schedule_and_stale_snapshots_skip_the_cooldown() -> None:
    async def scenario() -> None:
        clock = Clock()
        ctx = Ctx(clock, STOCKS[:2])
        with Session(ctx.engine) as s:
            s.add(_run_row(finished_at=clock.now() - timedelta(minutes=1)))
            s.commit()
        run = await ctx.run()  # snapshots are due: a manual run goes ahead
        assert (run.status, run.done) == ("done", 2)
        with pytest.raises(RunInProgress):
            ctx.job.trigger("snapshot")
        run_id = ctx.job.trigger("snapshot", trigger="schedule")
        await ctx.job.wait()
        assert ctx.run_row(run_id).status == "done"

    run_async(scenario)
