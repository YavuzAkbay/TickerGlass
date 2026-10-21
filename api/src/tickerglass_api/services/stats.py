"""Process-wide cache and upstream counters, reported by `GET /api/cache/stats`.

Names are dotted paths (`upstream.history.calls`, `bars.fresh`); `snapshot` nests them
into a tree on the dots, so a name must not also be the prefix of another name.
"""

import threading
from typing import Any


class CacheStats:
    """Thread-safe monotonically increasing counters and last-value gauges."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._counters: dict[str, int] = {}
        self._gauges: dict[str, float] = {}

    def incr(self, name: str, n: int = 1) -> None:
        with self._lock:
            self._counters[name] = self._counters.get(name, 0) + n

    def set_gauge(self, name: str, value: float) -> None:
        with self._lock:
            self._gauges[name] = value

    def counter(self, name: str) -> int:
        with self._lock:
            return self._counters.get(name, 0)

    def gauge(self, name: str) -> float | None:
        with self._lock:
            return self._gauges.get(name)

    def snapshot(self) -> dict[str, Any]:
        """Counters and gauges as one tree split on dots, keys sorted."""
        with self._lock:
            flat: dict[str, float] = {**self._counters, **self._gauges}
        tree: dict[str, Any] = {}
        for name in sorted(flat):
            *parents, leaf = name.split(".")
            node = tree
            for part in parents:
                node = node.setdefault(part, {})
            node[leaf] = flat[name]
        return tree
