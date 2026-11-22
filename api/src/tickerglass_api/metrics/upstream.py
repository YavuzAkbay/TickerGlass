"""Count of upstream requests by provider and outcome (docs/design/metrics.md §4.2).

The providers have no handle on the app, so they report to this module; the metrics collector
reads it at scrape time. It is process-wide state (like the guard, one worker): tests compare
before and after.
"""

import threading

OUTCOMES = ("ok", "rate_limited", "unavailable", "error")

_lock = threading.Lock()
_counts: dict[tuple[str, str], int] = {}


def record(provider: str, outcome: str) -> None:
    """Count one upstream attempt. `provider` is a fixed id from the provider code, never
    user input; an unknown outcome counts as `error`."""
    key = (provider, outcome if outcome in OUTCOMES else "error")
    with _lock:
        _counts[key] = _counts.get(key, 0) + 1


def snapshot() -> dict[tuple[str, str], int]:
    with _lock:
        return dict(_counts)
