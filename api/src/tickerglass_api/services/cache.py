"""In-memory read-through cache for upstream data that has no table of its own.

`SmartCache` keeps the last value per key, in LRU order, and decides per read:

- fresh (younger than its TTL): served as is;
- stale (older, but younger than `stale_ttl`): with `swr=True` served as is while one
  background refresh runs on the shared refresher executor; otherwise reloaded, and
  served only when that reload fails with a `ProviderError` (stale-if-error);
- missing: loaded. Concurrent readers of one key share a single load (single-flight).

`SymbolNotFound` is remembered as a negative entry for `negative_ttl`.

Loads run without the lock held. Every load registers a `Future` in `_inflight` first
and resolves it on every exit path (errors included), so no waiter is left behind.
"""

import logging
import threading
import time
from collections import OrderedDict
from collections.abc import Callable, Collection, Iterable, Mapping
from concurrent.futures import Executor, Future
from contextlib import AbstractContextManager, nullcontext
from dataclasses import dataclass
from typing import Generic, TypeVar, cast

from ..providers.base import ProviderError, SymbolNotFound
from .stats import CacheStats

log = logging.getLogger(__name__)

K = TypeVar("K")
V = TypeVar("V")


@dataclass(frozen=True)
class BatchResult(Generic[K, V]):
    """What a `SmartCache.get_many` loader returns for the keys it was given.

    - `values`: the rows found. Keys may be any of the requested keys.
    - `complete`: True when the upstream answered for every requested key outside
      `failed`, so a key absent from `values` is confirmed missing and cached as a
      negative entry. False: absent keys resolve to None for this call only.
    - `failed`: keys whose part of the request failed (`error` says why). They fall back
      to stale values; without one they are omitted, and `get_many` raises `error` only
      when it has nothing at all to return.
    """

    values: Mapping[K, V]
    complete: bool = False
    failed: Collection[K] = ()
    error: ProviderError | None = None


@dataclass(frozen=True)
class _Entry(Generic[V]):
    value: V | None  # None only for negative entries
    fetched_at: float
    fresh_until: float
    negative: bool


@dataclass(frozen=True)
class _Outcome(Generic[V]):
    """How an in-flight load ended for one key, as seen by the callers waiting on it."""

    value: V | None = None  # None with no error: no such key (or not in the batch answer)
    error: BaseException | None = None
    partial: bool = False  # error came from `BatchResult.failed`, not a failed load


class SmartCache(Generic[K, V]):
    """Thread-safe LRU cache with single-flight loads, stale-while-revalidate,
    stale-if-error and negative entries. Counters go to `CacheStats` under
    `cache.<name>.*`; `cache.<name>.size` is the entry count."""

    def __init__(
        self,
        name: str,
        *,
        ttl: float,
        stale_ttl: float,
        max_entries: int,
        negative_ttl: float,
        stats: CacheStats | None = None,
        clock: Callable[[], float] = time.monotonic,
        refresher: Executor | None = None,
        background: Callable[[], AbstractContextManager[object]] | None = None,
        ttl_for: Callable[[V], float] | None = None,
    ) -> None:
        """`stale_ttl` is the age (since fetch) up to which a value may still be served
        stale, by SWR or after a failed reload. `ttl_for(value)` overrides `ttl` per
        entry. `background()` wraps every refresh run on `refresher`."""
        if max_entries < 1:
            raise ValueError("max_entries must be >= 1")
        self._name = name
        self._ttl = ttl
        self._stale_ttl = max(stale_ttl, ttl)
        self._max = max_entries
        self._negative_ttl = negative_ttl
        self._stats = stats if stats is not None else CacheStats()
        self._clock = clock
        self._refresher = refresher
        self._background = background
        self._ttl_for = ttl_for
        self._lock = threading.Lock()
        self._data: OrderedDict[K, _Entry[V]] = OrderedDict()
        self._inflight: dict[K, Future[_Outcome[V]]] = {}

    def __len__(self) -> int:
        with self._lock:
            return len(self._data)

    def get(
        self,
        key: K,
        load: Callable[[], V],
        *,
        max_age: float | None = None,
        swr: bool = True,
        accept: Callable[[V], bool] | None = None,
    ) -> V:
        """Value for `key`, loading it with `load()` when needed.

        `max_age` additionally treats entries fetched longer ago as stale. An entry whose
        value fails `accept` is reloaded in the foreground (it still serves stale-if-error).
        Raises `SymbolNotFound` for a negative entry; other `ProviderError`s propagate
        when no stale value is left to serve.
        """
        leader: Future[_Outcome[V]] | None = None
        refresh = False
        with self._lock:
            now = self._clock()
            entry = self._lookup(key, now)
            if entry is not None and self._fresh(entry, now, max_age, accept):
                self._incr("hit")
                return _value(key, entry)
            fut = self._inflight.get(key)
            serve_stale = (
                swr
                and self._refresher is not None
                and entry is not None
                and self._stale(entry, now)
                and (accept is None or accept(_value(key, entry)))
            )
            if serve_stale:
                self._incr("stale")
                if fut is None:
                    refresh = True
                    fut = self._register(key)
            elif fut is not None:
                self._incr("coalesced")
            else:
                self._incr("miss")
                leader = self._register(key)
        if serve_stale:
            assert entry is not None and fut is not None
            if refresh:
                self._submit_refresh(key, load, fut)
            return _value(key, entry)
        if leader is None:
            assert fut is not None
            return self._single(key, fut.result())
        try:
            value = load()
        except SymbolNotFound as exc:
            self._finish(key, leader, _Outcome(error=exc), self._negative())
            raise
        except ProviderError as exc:
            self._finish(key, leader, _Outcome(error=exc), None)
            stale = self._stale_fallback(key)
            if stale is not None:
                return _value(key, stale)
            raise
        except BaseException as exc:
            self._finish(key, leader, _Outcome(error=exc), None)
            raise
        self._finish(key, leader, _Outcome(value=value), self._positive(value))
        return value

    def get_many(
        self,
        keys: Iterable[K],
        load_many: Callable[[list[K]], BatchResult[K, V]],
        *,
        max_age: float | None = None,
    ) -> dict[K, V]:
        """Values for those of `keys` that have one (no stale-while-revalidate).

        Fresh keys are served from the cache, keys another caller is loading are waited
        for, and the rest are loaded with one `load_many(keys)` call (see `BatchResult`).
        When that call raises a `ProviderError`, its keys fall back to stale values; if
        one has none, the error is raised.
        """
        result: dict[K, V] = {}
        waits: dict[K, Future[_Outcome[V]]] = {}
        mine: dict[K, Future[_Outcome[V]]] = {}
        with self._lock:
            now = self._clock()
            for key in dict.fromkeys(keys):
                entry = self._lookup(key, now)
                if entry is not None and self._fresh(entry, now, max_age, None):
                    self._incr("hit")
                    if not entry.negative:
                        result[key] = _value(key, entry)
                elif (fut := self._inflight.get(key)) is not None:
                    self._incr("coalesced")
                    waits[key] = fut
                else:
                    self._incr("miss")
                    mine[key] = self._register(key)
        outcomes: dict[K, _Outcome[V]] = {}
        if mine:
            outcomes.update(self._load_batch(mine, load_many))
        for key, fut in waits.items():
            outcomes[key] = fut.result()

        hard: list[BaseException] = []
        partial: list[BaseException] = []
        for key, outcome in outcomes.items():
            if outcome.error is None:
                if outcome.value is not None:
                    result[key] = outcome.value
                continue
            if isinstance(outcome.error, SymbolNotFound):
                continue  # the upstream says there is no such key
            if not isinstance(outcome.error, ProviderError):
                raise outcome.error
            stale = self._stale_fallback(key)
            if stale is not None:
                result[key] = _value(key, stale)
            else:
                (partial if outcome.partial else hard).append(outcome.error)
        if hard:
            raise hard[0]
        if partial and not result:
            raise partial[0]
        return result

    # -- internals (callers of `_lookup`, `_register`, `_store` hold the lock) --

    def _incr(self, counter: str) -> None:
        self._stats.incr(f"cache.{self._name}.{counter}")

    def _lookup(self, key: K, now: float) -> _Entry[V] | None:
        """The usable entry for `key` (fresh or stale), marked recently used. Entries past
        their last use are dropped."""
        entry = self._data.get(key)
        if entry is None:
            return None
        if entry.negative and now >= entry.fresh_until:
            self._drop(key)
            return None
        if not entry.negative and now - entry.fetched_at > self._stale_ttl:
            self._drop(key)
            return None
        self._data.move_to_end(key)
        return entry

    def _fresh(
        self,
        entry: _Entry[V],
        now: float,
        max_age: float | None,
        accept: Callable[[V], bool] | None,
    ) -> bool:
        if now >= entry.fresh_until:
            return False
        if entry.negative:
            return True
        if max_age is not None and now - entry.fetched_at > max_age:
            return False
        return accept is None or accept(_value(None, entry))

    def _stale(self, entry: _Entry[V], now: float) -> bool:
        return not entry.negative and now - entry.fetched_at <= self._stale_ttl

    def _register(self, key: K) -> Future[_Outcome[V]]:
        fut: Future[_Outcome[V]] = Future()
        self._inflight[key] = fut
        return fut

    def _drop(self, key: K) -> None:
        del self._data[key]
        self._stats.set_gauge(f"cache.{self._name}.size", len(self._data))

    def _store(self, key: K, entry: _Entry[V]) -> None:
        self._data[key] = entry
        self._data.move_to_end(key)
        while len(self._data) > self._max:
            self._data.popitem(last=False)
            self._incr("evicted")
        self._stats.set_gauge(f"cache.{self._name}.size", len(self._data))

    def _positive(self, value: V) -> _Entry[V]:
        now = self._clock()
        ttl = self._ttl_for(value) if self._ttl_for is not None else self._ttl
        return _Entry(value, now, now + ttl, False)

    def _negative(self) -> _Entry[V]:
        now = self._clock()
        return _Entry(None, now, now + self._negative_ttl, True)

    def _finish(
        self,
        key: K,
        fut: Future[_Outcome[V]],
        outcome: _Outcome[V],
        entry: _Entry[V] | None,
    ) -> None:
        """Store `entry` (if any) and retire `fut` atomically, then wake its waiters."""
        with self._lock:
            if entry is not None:
                self._store(key, entry)
            if self._inflight.get(key) is fut:
                del self._inflight[key]
        if not fut.done():
            fut.set_result(outcome)

    def _stale_fallback(self, key: K) -> _Entry[V] | None:
        """The stale entry for `key` to serve after a failed load, if one is left."""
        with self._lock:
            entry = self._lookup(key, self._clock())
        if entry is None or entry.negative:
            return None
        self._incr("stale_on_error")
        return entry

    def _single(self, key: K, outcome: _Outcome[V]) -> V:
        """Result of a `get` that waited on another caller's load."""
        if outcome.error is None:
            if outcome.value is None:
                raise SymbolNotFound(str(key))
            return outcome.value
        if isinstance(outcome.error, ProviderError) and not isinstance(
            outcome.error, SymbolNotFound
        ):
            stale = self._stale_fallback(key)
            if stale is not None:
                return _value(key, stale)
        raise outcome.error

    def _load_batch(
        self,
        mine: dict[K, Future[_Outcome[V]]],
        load_many: Callable[[list[K]], BatchResult[K, V]],
    ) -> dict[K, _Outcome[V]]:
        """Run one `load_many` for the keys this caller registered; resolve their futures."""
        outcomes: dict[K, _Outcome[V]] = {}
        entries: dict[K, _Entry[V]] = {}
        try:
            batch = load_many(list(mine))
        except BaseException as exc:
            outcomes = {key: _Outcome(error=exc) for key in mine}
            self._finish_batch(mine, outcomes, entries)
            if not isinstance(exc, ProviderError):
                raise
            return outcomes
        failed = set(batch.failed)
        error = batch.error or ProviderError(f"{self._name}: batch load failed")
        for key in mine:
            value = batch.values.get(key)
            if value is not None:
                outcomes[key] = _Outcome(value=value)
                entries[key] = self._positive(value)
            elif key in failed:
                outcomes[key] = _Outcome(error=error, partial=True)
            else:
                outcomes[key] = _Outcome()
                if batch.complete:
                    entries[key] = self._negative()
        self._finish_batch(mine, outcomes, entries)
        return outcomes

    def _finish_batch(
        self,
        mine: dict[K, Future[_Outcome[V]]],
        outcomes: dict[K, _Outcome[V]],
        entries: dict[K, _Entry[V]],
    ) -> None:
        with self._lock:
            for key, entry in entries.items():
                self._store(key, entry)
            for key, fut in mine.items():
                if self._inflight.get(key) is fut:
                    del self._inflight[key]
        for key, fut in mine.items():
            if not fut.done():
                fut.set_result(outcomes[key])

    def _submit_refresh(self, key: K, load: Callable[[], V], fut: Future[_Outcome[V]]) -> None:
        assert self._refresher is not None
        self._incr("refresh")

        def run() -> None:
            ctx = self._background() if self._background is not None else nullcontext()
            with ctx:
                self._refresh(key, load, fut)

        try:
            job = self._refresher.submit(run)
        except RuntimeError as exc:  # executor shut down
            self._incr("refresh_error")
            log.warning("cache %s: refresh of %r not started: %s", self._name, key, exc)
            self._finish(key, fut, _Outcome(error=exc), None)
            return

        def cancelled(job: Future[None]) -> None:
            if job.cancelled():
                self._finish(key, fut, _Outcome(error=RuntimeError("refresh cancelled")), None)

        job.add_done_callback(cancelled)

    def _refresh(self, key: K, load: Callable[[], V], fut: Future[_Outcome[V]]) -> None:
        """Background reload of a stale entry: failures are logged and counted only."""
        outcome: _Outcome[V] = _Outcome(error=RuntimeError("refresh aborted"))
        entry: _Entry[V] | None = None
        try:
            value = load()
        except SymbolNotFound as exc:
            outcome, entry = _Outcome(error=exc), self._negative()
        except ProviderError as exc:
            self._incr("refresh_error")
            log.warning("cache %s: refresh of %r failed: %s", self._name, key, exc)
            outcome = _Outcome(error=exc)
        except Exception as exc:
            self._incr("refresh_error")
            log.exception("cache %s: refresh of %r crashed", self._name, key)
            outcome = _Outcome(error=exc)
        else:
            outcome, entry = _Outcome(value=value), self._positive(value)
        finally:
            self._finish(key, fut, outcome, entry)


def _value(key: object, entry: _Entry[V]) -> V:
    """The value of a positive entry; a negative one raises `SymbolNotFound`."""
    if entry.negative:
        raise SymbolNotFound(str(key))
    return cast(V, entry.value)
