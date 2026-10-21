import threading
import time
from collections.abc import Callable, Iterator
from concurrent.futures import Executor, Future
from contextlib import contextmanager
from typing import Any, ParamSpec, TypeVar

import pytest

from tickerglass_api.providers.base import ProviderError, RateLimited, SymbolNotFound
from tickerglass_api.services.cache import BatchResult, SmartCache
from tickerglass_api.services.stats import CacheStats

P = ParamSpec("P")
T = TypeVar("T")


class FakeClock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


class InlineExecutor(Executor):
    """Runs each job at submit time, on the calling thread."""

    def submit(self, fn: Callable[P, T], /, *args: P.args, **kwargs: P.kwargs) -> Future[T]:
        fut: Future[T] = Future()
        fut.set_result(fn(*args, **kwargs))
        return fut


class QueueExecutor(Executor):
    """Holds jobs until `run_all`."""

    def __init__(self) -> None:
        self.jobs: list[Callable[[], None]] = []

    def submit(self, fn: Callable[P, T], /, *args: P.args, **kwargs: P.kwargs) -> Future[T]:
        fut: Future[T] = Future()

        def job() -> None:
            fut.set_result(fn(*args, **kwargs))

        self.jobs.append(job)
        return fut

    def run_all(self) -> None:
        jobs, self.jobs = self.jobs, []
        for job in jobs:
            job()


def make(
    clock: FakeClock | None = None,
    *,
    ttl: float = 10,
    stale_ttl: float = 100,
    max_entries: int = 100,
    negative_ttl: float = 50,
    refresher: Executor | None = None,
    stats: CacheStats | None = None,
    background: Callable[[], Any] | None = None,
) -> SmartCache[str, Any]:
    return SmartCache(
        "t",
        ttl=ttl,
        stale_ttl=stale_ttl,
        max_entries=max_entries,
        negative_ttl=negative_ttl,
        stats=stats,
        clock=clock if clock is not None else FakeClock(),
        refresher=refresher,
        background=background,
    )


class Loader:
    """Counts calls; returns `value-<n>` or raises the queued error."""

    def __init__(self, prefix: str = "v") -> None:
        self.calls = 0
        self.prefix = prefix
        self.error: BaseException | None = None

    def __call__(self) -> str:
        self.calls += 1
        if self.error is not None:
            raise self.error
        return f"{self.prefix}{self.calls}"


def wait_for(cond: Callable[[], bool], timeout: float = 5.0) -> None:
    deadline = time.monotonic() + timeout
    while not cond():
        assert time.monotonic() < deadline, "timed out"
        time.sleep(0.001)


def test_single_flight_ten_threads_one_load() -> None:
    stats = CacheStats()
    cache = make(stats=stats)
    release = threading.Event()
    calls = 0

    def load() -> str:
        nonlocal calls
        calls += 1
        assert release.wait(5)
        return "v"

    results: list[str] = []
    threads = [
        threading.Thread(target=lambda: results.append(cache.get("k", load))) for _ in range(10)
    ]
    for t in threads:
        t.start()
    wait_for(lambda: stats.counter("cache.t.coalesced") == 9)
    release.set()
    for t in threads:
        t.join(5)
    assert calls == 1
    assert results == ["v"] * 10
    assert stats.counter("cache.t.miss") == 1


def test_waiters_get_the_leaders_error() -> None:
    stats = CacheStats()
    cache = make(stats=stats)
    release = threading.Event()

    def load() -> str:
        assert release.wait(5)
        raise ProviderError("down")

    errors: list[BaseException] = []

    def call() -> None:
        try:
            cache.get("k", load)
        except ProviderError as exc:
            errors.append(exc)

    threads = [threading.Thread(target=call) for _ in range(3)]
    for t in threads:
        t.start()
    wait_for(lambda: stats.counter("cache.t.coalesced") == 2)
    release.set()
    for t in threads:
        t.join(5)
    assert [str(e) for e in errors] == ["down"] * 3


def test_hit_within_ttl_and_reload_after() -> None:
    clock = FakeClock()
    cache = make(clock)
    load = Loader()
    assert cache.get("k", load) == "v1"
    clock.now += 9
    assert cache.get("k", load) == "v1"
    clock.now += 2
    # Stale, but no refresher: loaded in the foreground.
    assert cache.get("k", load) == "v2"
    assert load.calls == 2


def test_max_age_tightens_freshness() -> None:
    clock = FakeClock()
    cache = make(clock)
    load = Loader()
    cache.get("k", load)
    clock.now += 5
    assert cache.get("k", load, max_age=10) == "v1"
    assert cache.get("k", load, max_age=4) == "v2"


def test_lru_evicts_least_recently_used() -> None:
    stats = CacheStats()
    cache = make(max_entries=2, stats=stats)
    loads = {k: Loader(k) for k in "abc"}
    cache.get("a", loads["a"])
    cache.get("b", loads["b"])
    cache.get("a", loads["a"])  # a is now the most recently used
    cache.get("c", loads["c"])  # evicts b
    assert len(cache) == 2
    assert stats.counter("cache.t.evicted") == 1
    assert stats.gauge("cache.t.size") == 2
    cache.get("a", loads["a"])
    cache.get("b", loads["b"])
    assert (loads["a"].calls, loads["b"].calls) == (1, 2)


def test_swr_serves_stale_and_refreshes_once_in_background() -> None:
    clock = FakeClock()
    stats = CacheStats()
    executor = QueueExecutor()
    entered: list[bool] = []

    @contextmanager
    def background() -> Iterator[None]:
        entered.append(True)
        yield

    cache = make(clock, refresher=executor, stats=stats, background=background)
    load = Loader()
    assert cache.get("k", load) == "v1"
    clock.now += 20
    assert [cache.get("k", load) for _ in range(3)] == ["v1"] * 3
    assert len(executor.jobs) == 1 and load.calls == 1
    executor.run_all()
    assert load.calls == 2 and entered == [True]
    assert cache.get("k", load) == "v2"
    assert stats.counter("cache.t.stale") == 3
    assert stats.counter("cache.t.refresh") == 1


def test_swr_refresh_failure_is_counted_not_raised() -> None:
    clock = FakeClock()
    stats = CacheStats()
    cache = make(clock, refresher=InlineExecutor(), stats=stats)
    load = Loader()
    cache.get("k", load)
    clock.now += 20
    load.error = RateLimited("budget", retry_after=5)
    assert cache.get("k", load) == "v1"
    load.error = RuntimeError("bug")
    assert cache.get("k", load) == "v1"
    assert stats.counter("cache.t.refresh_error") == 2
    load.error = None
    assert cache.get("k", load) == "v1"  # stale served, refresh succeeds inline
    assert cache.get("k", load) == "v4"


def test_swr_off_or_too_old_loads_in_foreground() -> None:
    clock = FakeClock()
    executor = QueueExecutor()
    cache = make(clock, refresher=executor)
    load = Loader()
    cache.get("k", load)
    clock.now += 20
    assert cache.get("k", load, swr=False) == "v2"
    clock.now += 101
    assert cache.get("k", load) == "v3"
    assert executor.jobs == []


def test_stale_if_error() -> None:
    clock = FakeClock()
    stats = CacheStats()
    cache = make(clock, stats=stats)
    load = Loader()
    cache.get("k", load)
    clock.now += 50
    load.error = ProviderError("down")
    assert cache.get("k", load) == "v1"
    assert stats.counter("cache.t.stale_on_error") == 1
    clock.now += 51  # past stale_ttl: nothing left to serve
    with pytest.raises(ProviderError, match="down"):
        cache.get("k", load)
    with pytest.raises(ProviderError, match="down"):
        cache.get("other", load)


def test_non_provider_errors_are_not_masked() -> None:
    clock = FakeClock()
    cache = make(clock)
    load = Loader()
    cache.get("k", load)
    clock.now += 20
    load.error = KeyError("bug")
    with pytest.raises(KeyError):
        cache.get("k", load)


def test_negative_ttl() -> None:
    clock = FakeClock()
    cache = make(clock, negative_ttl=50)
    load = Loader()
    load.error = SymbolNotFound("NOPE")
    with pytest.raises(SymbolNotFound):
        cache.get("NOPE", load)
    load.error = None
    clock.now += 49
    with pytest.raises(SymbolNotFound):
        cache.get("NOPE", load)
    assert load.calls == 1
    clock.now += 2
    assert cache.get("NOPE", load) == "v2"


def test_accept_rejects_entry() -> None:
    cache = make()
    load = Loader()
    cache.get("k", load)
    assert cache.get("k", load, accept=lambda v: v == "v1") == "v1"
    assert cache.get("k", load, accept=lambda v: v == "v2") == "v2"
    assert load.calls == 2


class BatchLoader:
    def __init__(self, known: set[str], *, complete: bool = True) -> None:
        self.known = known
        self.complete = complete
        self.calls: list[list[str]] = []
        self.error: ProviderError | None = None
        self.failed: set[str] = set()
        self.gate: threading.Event | None = None

    def __call__(self, keys: list[str]) -> BatchResult[str, str]:
        self.calls.append(list(keys))
        if self.gate is not None:
            assert self.gate.wait(5)
        if self.error is not None:
            raise self.error
        ok = [k for k in keys if k in self.known and k not in self.failed]
        failed = [k for k in keys if k in self.failed]
        error = ProviderError("chunk failed") if failed else None
        return BatchResult(
            {k: f"{k}{len(self.calls)}" for k in ok},
            complete=self.complete,
            failed=failed,
            error=error,
        )


def test_get_many_loads_only_missing_or_stale() -> None:
    clock = FakeClock()
    cache = make(clock, ttl=10)
    load = BatchLoader({"A", "B", "C"})
    assert cache.get_many(["A", "B"], load) == {"A": "A1", "B": "B1"}
    clock.now += 5
    assert cache.get_many(["A", "B", "C", "A"], load) == {"A": "A1", "B": "B1", "C": "C2"}
    clock.now += 6  # A and B stale now, C fresh
    assert cache.get_many(["A", "B", "C"], load) == {"C": "C2", "A": "A3", "B": "B3"}
    assert load.calls == [["A", "B"], ["C"], ["A", "B"]]


def test_get_many_negative_only_when_complete() -> None:
    cache = make()
    load = BatchLoader({"A"}, complete=True)
    assert cache.get_many(["A", "NOPE"], load) == {"A": "A1"}
    assert cache.get_many(["A", "NOPE"], load) == {"A": "A1"}
    assert load.calls == [["A", "NOPE"]]

    cache = make()
    unsure = BatchLoader({"A"}, complete=False)
    cache.get_many(["A", "NOPE"], unsure)
    cache.get_many(["A", "NOPE"], unsure)
    assert unsure.calls == [["A", "NOPE"], ["NOPE"]]


def test_get_many_overlapping_batches_share_inflight_keys() -> None:
    stats = CacheStats()
    cache = make(stats=stats)
    first = BatchLoader({"A", "B", "C"})
    first.gate = threading.Event()
    second = BatchLoader({"A", "B", "C"})
    out: dict[str, dict[str, str]] = {}
    t1 = threading.Thread(target=lambda: out.update(one=cache.get_many(["A", "B"], first)))
    t1.start()
    wait_for(lambda: len(first.calls) == 1)
    t2 = threading.Thread(target=lambda: out.update(two=cache.get_many(["B", "C"], second)))
    t2.start()
    wait_for(lambda: stats.counter("cache.t.coalesced") == 1)
    first.gate.set()
    t1.join(5)
    t2.join(5)
    assert first.calls == [["A", "B"]] and second.calls == [["C"]]
    assert out == {"one": {"A": "A1", "B": "B1"}, "two": {"C": "C1", "B": "B1"}}


def test_get_many_error_uses_stale_only_when_every_key_has_one() -> None:
    clock = FakeClock()
    stats = CacheStats()
    cache = make(clock, stats=stats)
    load = BatchLoader({"A", "B", "C"})
    cache.get_many(["A", "B"], load)
    clock.now += 20
    load.error = ProviderError("down")
    assert cache.get_many(["A", "B"], load) == {"A": "A1", "B": "B1"}
    assert stats.counter("cache.t.stale_on_error") == 2
    with pytest.raises(ProviderError, match="down"):
        cache.get_many(["A", "C"], load)


def test_get_many_partial_failure() -> None:
    cache = make()
    load = BatchLoader({"A", "B"})
    load.failed = {"B"}
    # B's chunk failed: omitted, and not cached as missing.
    assert cache.get_many(["A", "B"], load) == {"A": "A1"}
    load.failed = set()
    assert cache.get_many(["A", "B"], load) == {"A": "A1", "B": "B2"}
    load.failed = {"C"}
    with pytest.raises(ProviderError, match="chunk failed"):
        cache.get_many(["C"], load)


class CancellingExecutor(Executor):
    """Accepts jobs but never runs them; `cancel_all` cancels them like a shutdown."""

    def __init__(self) -> None:
        self.futures: list[Future[Any]] = []

    def submit(self, fn: Callable[P, T], /, *args: P.args, **kwargs: P.kwargs) -> Future[T]:
        fut: Future[T] = Future()
        self.futures.append(fut)
        return fut

    def cancel_all(self) -> None:
        for fut in self.futures:
            fut.cancel()


def _join_refresh(cache: SmartCache[str, Any], stats: CacheStats, load: Loader) -> list[Any]:
    """Start a foreground `get` that waits on the in-flight refresh of "k"; returns the
    list its result (or error) is appended to."""
    out: list[Any] = []

    def call() -> None:
        try:
            out.append(cache.get("k", load, swr=False))
        except BaseException as exc:
            out.append(exc)

    before = stats.counter("cache.t.coalesced")
    threading.Thread(target=call, daemon=True).start()
    wait_for(lambda: stats.counter("cache.t.coalesced") == before + 1)
    return out


def test_waiter_on_refused_background_refresh_gets_stale() -> None:
    clock = FakeClock()
    stats = CacheStats()
    executor = QueueExecutor()
    cache = make(clock, refresher=executor, stats=stats)
    load = Loader()
    cache.get("k", load)
    clock.now += 20
    assert cache.get("k", load) == "v1"  # refresh queued
    out = _join_refresh(cache, stats, load)
    load.error = RateLimited("budget reserved", retry_after=5)
    executor.run_all()
    wait_for(lambda: bool(out))
    assert out == ["v1"]


def test_cancelled_refresh_gives_waiters_stale_or_provider_error() -> None:
    clock = FakeClock()
    stats = CacheStats()
    executor = CancellingExecutor()
    cache = make(clock, refresher=executor, stats=stats)
    load = Loader()
    cache.get("k", load)
    clock.now += 20
    cache.get("k", load)
    out = _join_refresh(cache, stats, load)
    executor.cancel_all()
    wait_for(lambda: bool(out))
    assert out == ["v1"]

    clock.now += 20
    cache.get("k", load)  # stale again: a second refresh
    out = _join_refresh(cache, stats, load)
    clock.now += 100  # the stale value expires while the waiter waits
    executor.cancel_all()
    wait_for(lambda: bool(out))
    assert isinstance(out[0], ProviderError)
