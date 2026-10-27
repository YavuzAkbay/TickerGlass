"""Single choke point for upstream requests: budget, cooldowns and counting.

`GuardedProvider` wraps any `MarketDataProvider` (the real one or a test fake); every
call first takes tokens from the `UpstreamGuard`. Caching stays in the services.

The guard is per process: with several API workers each one has its own budget.
"""

import logging
import math
import threading
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import datetime
from typing import Any, TypeVar

import pandas as pd

from ..services.stats import CacheStats
from .base import (
    MarketDataProvider,
    PartialQuotes,
    ProviderError,
    RateLimited,
    SymbolNotFound,
    UpstreamDegraded,
    UpstreamUnavailable,
    metering,
)

log = logging.getLogger(__name__)
T = TypeVar("T")

# Calls made inside `UpstreamGuard.background()` (refreshes nobody is waiting for).
_BACKGROUND: ContextVar[bool] = ContextVar("upstream_background", default=False)
# Share of the burst kept for foreground calls: background calls are refused below it.
BACKGROUND_RESERVE = 0.25
# Longest a foreground call waits for tokens before failing locally.
FOREGROUND_MAX_WAIT_S = 2.0
# Symbols per Yahoo v7 quote request (`yahoo._V7_CHUNK`; not imported to keep yfinance out).
V7_CHUNK = 50
# Upstream requests per `fundamentals` call (`yahoo._FUNDAMENTALS_REQUESTS`): the summary
# info plus six statements (annual and quarterly income, balance, cash flow).
FUNDAMENTALS_REQUESTS = 7


class UpstreamGuard:
    """Token bucket plus two breakers, shared by every upstream call of the process.

    - Budget: `rate_per_min` tokens per minute, at most `burst` saved up. A call costs
      the number of upstream requests it makes; a cost above `burst` waits for a full
      bucket and leaves it in debt, which later calls pay back.
    - Rate-limit breaker: after the upstream refuses, nothing is sent for
      max(retry_after, backoff) seconds, capped at `cooldown_max_s`. The backoff starts
      at `cooldown_initial_s`, doubles on every refusal and resets on a success. Each
      opening starts a new epoch; `acquire` returns the epoch a request was sent in, and
      outcomes of requests sent before the latest opening neither escalate nor reset
      (several requests in flight when the upstream refuses count as one refusal).
    - Unavailable breaker: after a connection failure, nothing is sent for
      `unavailable_cooldown_s` seconds.
    """

    def __init__(
        self,
        *,
        rate_per_min: float = 60,
        burst: int = 20,
        cooldown_initial_s: float = 30,
        cooldown_max_s: float = 900,
        unavailable_cooldown_s: float = 10,
        max_wait_s: float = FOREGROUND_MAX_WAIT_S,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        if rate_per_min <= 0 or burst < 1:
            raise ValueError("rate_per_min must be > 0 and burst >= 1")
        self._rate_per_s = rate_per_min / 60
        self._burst = burst
        self._cooldown_initial = min(cooldown_initial_s, cooldown_max_s)
        self._cooldown_max = cooldown_max_s
        self._unavailable_cooldown = unavailable_cooldown_s
        self._max_wait = max_wait_s
        self._clock = clock
        self._sleep = sleep
        self._lock = threading.Lock()
        self._tokens = float(burst)
        self._refilled_at = clock()
        self._backoff = self._cooldown_initial
        self._epoch = 0
        self._rate_limited_until: float | None = None
        self._unavailable_until: float | None = None
        self._refused: dict[str, int] = {"rate_limited": 0, "unavailable": 0, "budget": 0}

    @contextmanager
    def background(self) -> Iterator[None]:
        """Mark calls in this context (and threads started via `asyncio.to_thread`) as
        background: they never wait, and are refused when they would dip into the last
        `BACKGROUND_RESERVE` of the burst."""
        token = _BACKGROUND.set(True)
        try:
            yield
        finally:
            _BACKGROUND.reset(token)

    @staticmethod
    def in_background() -> bool:
        return _BACKGROUND.get()

    def acquire(self, cost: int = 1) -> int:
        """Take `cost` tokens or raise without contacting the upstream; returns the breaker
        epoch to pass to `on_success` / `on_rate_limited` with the outcome.

        Raises `RateLimited` while the rate-limit breaker is open or when no tokens are
        available in time, `UpstreamUnavailable` while the unavailable breaker is open.
        """
        background = _BACKGROUND.get()
        deadline: float | None = None
        while True:
            with self._lock:
                now = self._clock()
                self._check_breakers(now)
                if cost <= 0:
                    return self._epoch
                self._refill(now)
                if background:
                    # Never wait, and leave the reserve untouched (a cost too large to
                    # fit beside it needs a full bucket).
                    reserve = self._burst * BACKGROUND_RESERVE
                    short = reserve + min(cost, self._burst - reserve) - self._tokens
                    if short > 0:
                        self._refused["budget"] += 1
                        raise RateLimited(
                            "upstream budget reserved for foreground requests",
                            retry_after=max(1, math.ceil(short / self._rate_per_s)),
                        )
                    self._tokens -= cost
                    return self._epoch
                need = min(cost, self._burst)
                if self._tokens >= need:
                    self._tokens -= cost
                    return self._epoch
                wait = (need - self._tokens) / self._rate_per_s
                if deadline is None:
                    deadline = now + self._max_wait
                if now + wait > deadline:
                    self._refused["budget"] += 1
                    raise RateLimited(
                        "upstream request budget exhausted", retry_after=max(1, math.ceil(wait))
                    )
            self._sleep(wait)

    def on_success(self, epoch: int | None = None) -> None:
        """Reset the backoff, unless the request was sent in an earlier `epoch`."""
        with self._lock:
            if epoch is None or epoch == self._epoch:
                self._backoff = self._cooldown_initial

    def on_rate_limited(self, retry_after: float | None = None, epoch: int | None = None) -> float:
        """Open the rate-limit breaker; returns how long it stays open, in seconds.

        A refusal of a request sent in an earlier `epoch` (the breaker has opened since)
        changes nothing and returns the time left."""
        with self._lock:
            now = self._clock()
            if epoch is not None and epoch != self._epoch:
                return _remaining(self._rate_limited_until, now)
            duration = min(max(retry_after or 0, self._backoff), self._cooldown_max)
            self._rate_limited_until = now + duration
            self._backoff = min(self._backoff * 2, self._cooldown_max)
            self._epoch += 1
        if duration > 0:
            log.warning("upstream rate limited; pausing upstream calls for %.0fs", duration)
        return duration

    def on_unavailable(self) -> float:
        """Open the unavailable breaker; returns how long it stays open, in seconds."""
        with self._lock:
            self._unavailable_until = self._clock() + self._unavailable_cooldown
        return self._unavailable_cooldown

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            now = self._clock()
            self._refill(now)
            rate_left = _remaining(self._rate_limited_until, now)
            down_left = _remaining(self._unavailable_until, now)
            return {
                "tokens": round(self._tokens, 2),
                "burst": self._burst,
                "ratePerMin": self._rate_per_s * 60,
                "rateLimited": rate_left > 0,
                "rateLimitedForS": math.ceil(rate_left),
                "backoffS": self._backoff,
                "unavailable": down_left > 0,
                "unavailableForS": math.ceil(down_left),
                "refused": dict(self._refused),
            }

    def _refill(self, now: float) -> None:
        elapsed = max(0.0, now - self._refilled_at)
        self._tokens = min(float(self._burst), self._tokens + elapsed * self._rate_per_s)
        self._refilled_at = now

    def _check_breakers(self, now: float) -> None:
        # Caller holds the lock.
        left = _remaining(self._rate_limited_until, now)
        if left > 0:
            self._refused["rate_limited"] += 1
            raise RateLimited("upstream rate limited; cooling down", retry_after=math.ceil(left))
        left = _remaining(self._unavailable_until, now)
        if left > 0:
            self._refused["unavailable"] += 1
            raise UpstreamUnavailable(f"upstream unavailable; retrying in {math.ceil(left)}s")


def _remaining(until: float | None, now: float) -> float:
    return 0.0 if until is None else max(0.0, until - now)


class GuardedProvider:
    """`MarketDataProvider` that sends every call through an `UpstreamGuard` and counts
    it in `CacheStats` under `upstream.<op>.*`."""

    def __init__(
        self, inner: MarketDataProvider, guard: UpstreamGuard, stats: CacheStats | None = None
    ) -> None:
        self._inner = inner
        self._guard = guard
        self._stats = stats if stats is not None else CacheStats()

    @property
    def inner(self) -> MarketDataProvider:
        return self._inner

    def _run(self, op: str, cost: int, fn: Callable[[], T]) -> T:
        prefix = f"upstream.{op}"
        try:
            epoch = self._guard.acquire(cost)
        except ProviderError:
            self._stats.incr(f"{prefix}.refused")
            raise
        self._stats.incr(f"{prefix}.calls")
        self._stats.incr(f"{prefix}.requests", cost)
        refusals: list[ProviderError] = []

        def charge(requests: int) -> None:
            # Extra requests of this call (retries, fallbacks): same budget and breakers.
            try:
                self._guard.acquire(requests)
            except ProviderError as exc:
                self._stats.incr(f"{prefix}.refused")
                refusals.append(exc)
                raise
            self._stats.incr(f"{prefix}.requests", requests)

        try:
            with metering(charge):
                result = fn()
        except SymbolNotFound:
            # A definite answer from a healthy upstream.
            self._stats.incr(f"{prefix}.not_found")
            self._guard.on_success(epoch)
            raise
        except RateLimited as exc:
            if any(exc is r for r in refusals):
                raise  # refused locally by `charge`: the upstream did not refuse
            self._stats.incr(f"{prefix}.rate_limited")
            cooldown = self._guard.on_rate_limited(exc.retry_after, epoch)
            exc.retry_after = max(exc.retry_after, math.ceil(cooldown))
            raise
        except UpstreamDegraded:
            # One endpoint failing while the upstream answers: no outage breaker.
            self._stats.incr(f"{prefix}.errors")
            raise
        except UpstreamUnavailable as exc:
            if any(exc is r for r in refusals):
                raise
            self._stats.incr(f"{prefix}.unavailable")
            self._guard.on_unavailable()
            raise
        except PartialQuotes:
            # Some chunks answered, so the upstream is reachable; no breaker change.
            self._stats.incr(f"{prefix}.partial")
            raise
        except Exception:
            self._stats.incr(f"{prefix}.errors")
            raise
        self._guard.on_success(epoch)
        return result

    def history(
        self,
        symbol: str,
        interval: str,
        start: datetime | None,
        end: datetime | None,
        prepost: bool,
    ) -> pd.DataFrame:
        return self._run(
            "history", 1, lambda: self._inner.history(symbol, interval, start, end, prepost)
        )

    def symbol_info(self, symbol: str) -> dict[str, Any]:
        return self._run("symbol_info", 1, lambda: self._inner.symbol_info(symbol))

    def search(self, query: str, limit: int) -> list[dict[str, Any]]:
        return self._run("search", 1, lambda: self._inner.search(query, limit))

    def quotes(self, symbols: list[str]) -> list[dict[str, Any]]:
        # One v7 request per 50 symbols; a fallback charges its own cost on top.
        cost = math.ceil(len(symbols) / V7_CHUNK)
        return self._run("quotes", cost, lambda: self._inner.quotes(symbols))

    def extended_quotes(self, symbols: list[str]) -> list[dict[str, Any]]:
        cost = math.ceil(len(symbols) / V7_CHUNK)
        return self._run("extended_quotes", cost, lambda: self._inner.extended_quotes(symbols))

    def events(self, symbol: str) -> dict[str, Any]:
        # Chart actions plus earnings dates.
        return self._run("events", 2, lambda: self._inner.events(symbol))

    def news(self, symbol: str, limit: int) -> list[dict[str, Any]]:
        return self._run("news", 1, lambda: self._inner.news(symbol, limit))

    def fundamentals(self, symbol: str) -> dict[str, Any]:
        return self._run("fundamentals", FUNDAMENTALS_REQUESTS, lambda: self._inner.fundamentals(symbol))
