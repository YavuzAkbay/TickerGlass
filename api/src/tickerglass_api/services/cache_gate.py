"""Fences market-data cache writes of a retired provider stack.

Switching the provider at runtime wipes the cache (`ensure_cache_source`) while requests of
the old stack may still be fetching. A service built for generation N commits its bars and
metadata through `CacheGate.writing(N)`; once `advance` has made a newer generation current,
those commits are rolled back and refused with `CacheRetired`, so nothing the old provider
fetched lands in the new provider's cache.

The gate's lock is held only while one commit or rollback runs, never across a fetch, and the
wipe does not take it: `advance` first, then wipe. A writer holding the database's write lock
reaches its commit, sees it is retired and rolls back, which lets the wipe proceed.

Only commits that add or change rows are gated. Delete-only paths (`BarService._evict` and
the maintenance purges) are intentionally ungated: a retired stack can only remove rows, and
a row it removes is either its own or already wiped, so nothing of the old provider can
survive in the new one's cache.
"""

import threading
from collections.abc import Iterator
from contextlib import contextmanager


class CacheRetired(Exception):
    """A cache write by a stack that is no longer current (the provider was switched).
    Not a `ProviderError`: the app answers it with a retryable 503."""


class CacheGate:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._generation = 0

    @property
    def generation(self) -> int:
        return self._generation

    def advance(self) -> int:
        """Make a new generation current (waits for a commit in progress); returns it."""
        with self._lock:
            self._generation += 1
            return self._generation

    @contextmanager
    def writing(self, generation: int) -> Iterator[bool]:
        """Hold the gate while writing; yields whether `generation` is still current."""
        with self._lock:
            yield generation == self._generation
