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
from contextlib import AbstractContextManager, contextmanager
from contextvars import ContextVar
from datetime import UTC, datetime, timedelta
from functools import partial
from typing import Any, Literal, TypeVar, get_args

import pandas as pd

from ..services.stats import CacheStats
from .base import (
    Capabilities,
    CostModel,
    LocalRateLimited,
    MarketDataProvider,
    PartialQuotes,
    ProviderError,
    ProviderUnsupported,
    QuoteList,
    RateLimited,
    SymbolNotFound,
    UpstreamDegraded,
    UpstreamUnavailable,
    Usage,
    as_metered,
    as_symbol_routing,
    metering,
    usage_reporting,
)

log = logging.getLogger(__name__)
T = TypeVar("T")

# Who a call is for, most to least urgent: `interactive` (bars, symbol info, search: a user
# waits), `visible` (quotes, extended quotes, events, fundamentals of what is on screen),
# `background` (live polls, refreshes nobody waits for), `prefetch` (speculative).
Priority = Literal["interactive", "visible", "background", "prefetch"]
PRIORITIES: tuple[str, ...] = get_args(Priority)
# Priority of the calls made in this context (see `UpstreamGuard.priority`).
_PRIORITY: ContextVar[Priority] = ContextVar("upstream_priority", default="interactive")
# Share of the burst kept for more urgent calls: a call below `interactive` is refused
# (it never waits) when it would dip into the last share of its level.
BURST_RESERVES: dict[str, float] = {
    "interactive": 0.0,
    "visible": 0.10,
    "background": 0.25,
    "prefetch": 0.50,
}
BACKGROUND_RESERVE = BURST_RESERVES["background"]
# Same for the daily allowance (when there is one): refused when fewer credits would be
# left than this share of it. `interactive` may use it all.
DAILY_RESERVES: dict[str, float] = {
    "interactive": 0.0,
    "visible": 0.05,
    "background": 0.15,
    "prefetch": 0.15,
}
# Credits one usage request costs.
USAGE_COST = 1
# Longest a foreground call waits for tokens before failing locally.
FOREGROUND_MAX_WAIT_S = 2.0
#: Seconds of waiting below which the snapshot state stays "ok" (not worth a notice).
THROTTLED_AFTER_S = 5
# Yahoo's costs (`CostModel` defaults): symbols per v7 quote request, and upstream requests
# per `fundamentals` call (summary info plus six statements).
V7_CHUNK = CostModel().quote_batch
FUNDAMENTALS_REQUESTS = CostModel().fundamentals


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
    - Daily allowance (`daily_limit`, optional): credits spent since 00:00 UTC; at the
      limit every call is refused with `RateLimited` until the reset. Calls below
      `interactive` priority also leave `DAILY_RESERVES` of it untouched. Not persisted:
      a restart starts from zero unless the provider's `usage()` seeds it.
    - Calibration: `calibrate` (fed by `report_usage`) lowers the tokens to what the
      upstream says is left, and unless the user set them takes the per-minute and daily
      limits from it.
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
        daily_limit: int | None = None,
        calibrate_rate: bool = True,
        calibrate_daily: bool = True,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
        utcnow: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        if rate_per_min <= 0 or burst < 1:
            raise ValueError("rate_per_min must be > 0 and burst >= 1")
        if daily_limit is not None and daily_limit < 1:
            raise ValueError("daily_limit must be >= 1")
        self._rate_per_s = rate_per_min / 60
        self._burst = burst
        self._cooldown_initial = min(cooldown_initial_s, cooldown_max_s)
        self._cooldown_max = cooldown_max_s
        self._unavailable_cooldown = unavailable_cooldown_s
        self._max_wait = max_wait_s
        self._clock = clock
        self._sleep = sleep
        self._utcnow = utcnow
        self._daily_limit = daily_limit
        self._calibrate_rate = calibrate_rate
        self._calibrate_daily = calibrate_daily
        self._calibrated = False
        self._day = utcnow().astimezone(UTC).date()
        self._used_today = 0
        self._lock = threading.Lock()
        self._tokens = float(burst)
        self._refilled_at = clock()
        self._backoff = self._cooldown_initial
        self._epoch = 0
        self._rate_limited_until: float | None = None
        self._unavailable_until: float | None = None
        self._refused: dict[str, int] = {
            "rate_limited": 0,
            "unavailable": 0,
            "budget": 0,
            "daily": 0,
        }

    @contextmanager
    def priority(self, level: Priority) -> Iterator[None]:
        """Run the calls in this context (and in threads started via `asyncio.to_thread`)
        at `level`. Below `interactive` they never wait for tokens, and are refused when
        they would dip into the share of the burst (`BURST_RESERVES`) or of the daily
        allowance (`DAILY_RESERVES`) kept for more urgent calls."""
        if level not in PRIORITIES:
            raise ValueError(f"unknown priority {level!r}")
        token = _PRIORITY.set(level)
        try:
            yield
        finally:
            _PRIORITY.reset(token)

    def background(self) -> AbstractContextManager[None]:
        """Alias of `priority("background")`."""
        return self.priority("background")

    @property
    def burst(self) -> int:
        """Most tokens the bucket holds (what a single request may cost at most)."""
        with self._lock:
            return self._burst

    @staticmethod
    def current_priority() -> Priority:
        return _PRIORITY.get()

    @staticmethod
    def in_background() -> bool:
        return _PRIORITY.get() in ("background", "prefetch")

    def acquire(self, cost: int = 1) -> int:
        """Take `cost` tokens or raise without contacting the upstream; returns the breaker
        epoch to pass to `on_success` / `on_rate_limited` with the outcome.

        Raises `RateLimited` while the rate-limit breaker is open or when no tokens are
        available in time, `UpstreamUnavailable` while the unavailable breaker is open.
        """
        level = _PRIORITY.get()
        deadline: float | None = None
        while True:
            with self._lock:
                now = self._clock()
                self._check_breakers(now)
                if cost <= 0:
                    return self._epoch
                self._check_daily(cost, level)
                self._refill(now)
                if level != "interactive":
                    # Never wait, and leave the reserve of this level untouched (a cost
                    # too large to fit beside it needs a full bucket).
                    reserve = self._burst * BURST_RESERVES[level]
                    short = reserve + min(cost, self._burst - reserve) - self._tokens
                    if short > 0:
                        self._refused["budget"] += 1
                        raise RateLimited(
                            "upstream budget reserved for more urgent requests",
                            retry_after=max(1, math.ceil(short / self._rate_per_s)),
                        )
                    self._take(cost)
                    return self._epoch
                need = min(cost, self._burst)
                if self._tokens >= need:
                    self._take(cost)
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

    def refund(self, cost: int) -> None:
        """Give back `cost` tokens (and daily credits) of a request that was never sent."""
        if cost <= 0:
            return
        with self._lock:
            self._tokens = min(float(self._burst), self._tokens + cost)
            self._used_today = max(0, self._used_today - cost)

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

    def calibrate(
        self,
        *,
        minute_used: int | None = None,
        minute_left: int | None = None,
        daily_used: int | None = None,
        daily_limit: int | None = None,
    ) -> None:
        """Adopt what the upstream says about its credits (see `base.report_usage`).

        The tokens drop to `minute_left` but never rise to it. `minute_used + minute_left`
        becomes the per-minute limit (and caps the burst) unless the user set the rate;
        `daily_limit` replaces the daily limit (0: none) unless the user set that. The daily count
        only grows: the larger of ours and the upstream's (other clients may share the key).
        """
        with self._lock:
            now = self._clock()
            self._refill(now)
            if minute_left is not None:
                self._tokens = min(self._tokens, float(max(0, minute_left)))
            if self._calibrate_rate and minute_used is not None and minute_left is not None:
                limit = minute_used + minute_left
                if limit > 0:
                    self._rate_per_s = limit / 60
                    self._burst = max(1, min(self._burst, limit))
                    self._calibrated = True
            if self._calibrate_daily and daily_limit is not None and daily_limit >= 0:
                self._daily_limit = daily_limit or None  # 0: the upstream has no cap
                self._calibrated = True
            if daily_used is not None:
                self._roll_day(self._utcnow().astimezone(UTC))
                self._used_today = max(self._used_today, daily_used)

    def apply_usage(self, usage: Usage) -> None:
        """`calibrate` from a `Usage` answer."""
        left = (
            usage.minute_limit - usage.minute_used
            if usage.minute_limit is not None and usage.minute_used is not None
            else None
        )
        self.calibrate(
            minute_used=usage.minute_used,
            minute_left=left,
            daily_used=usage.daily_used,
            daily_limit=usage.daily_limit,
        )

    def mark_daily_exhausted(self) -> int | None:
        """The upstream refused because the daily allowance is gone: count all of it as
        used. Returns the seconds until the reset, or None without a daily limit."""
        with self._lock:
            limit = self._daily_limit
            if limit is None:
                return None
            now_utc = self._utcnow().astimezone(UTC)
            self._roll_day(now_utc)
            self._used_today = max(self._used_today, limit)
            return self._reset_in(now_utc)

    def sustainable_rate_per_min(self) -> float:
        """Credits per minute that can be spent for the rest of the day without running
        out before the reset: the per-minute rate, or less when a daily limit is nearer."""
        with self._lock:
            return self._sustainable(self._utcnow().astimezone(UTC))

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            now = self._clock()
            self._refill(now)
            now_utc = self._utcnow().astimezone(UTC)
            rate_left = _remaining(self._rate_limited_until, now)
            down_left = _remaining(self._unavailable_until, now)
            daily: dict[str, Any] | None = None
            exhausted = False
            reset_in = self._reset_in(now_utc)
            if self._daily_limit is not None:
                self._roll_day(now_utc)
                left = max(0, self._daily_limit - self._used_today)
                exhausted = left <= 0
                daily = {
                    "limit": self._daily_limit,
                    "used": self._used_today,
                    "left": left,
                    "resetInS": reset_in,
                    "resetAt": (now_utc + timedelta(seconds=reset_in))
                    .replace(microsecond=0)
                    .isoformat()
                    .replace("+00:00", "Z"),
                }
            retry_after = 0
            if exhausted:
                retry_after = reset_in
            elif rate_left > 0:
                retry_after = math.ceil(rate_left)
            elif self._tokens < 1:
                retry_after = max(1, math.ceil((1 - self._tokens) / self._rate_per_s))
            # A wait of a few seconds is ordinary pacing, not something to tell the user.
            state = (
                "exhausted"
                if exhausted
                else "throttled"
                if retry_after > THROTTLED_AFTER_S
                else "ok"
            )
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
                "daily": daily,
                "calibrated": self._calibrated,
                "sustainablePerMin": self._sustainable(now_utc),
                "state": state,
                "retryAfterS": retry_after,
            }

    def _take(self, cost: int) -> None:
        # Caller holds the lock.
        self._tokens -= cost
        self._used_today += cost

    def _roll_day(self, now_utc: datetime) -> None:
        # Caller holds the lock. The allowance resets at 00:00 UTC.
        today = now_utc.date()
        if today != self._day:
            self._day = today
            self._used_today = 0

    @staticmethod
    def _reset_in(now_utc: datetime) -> int:
        """Whole seconds until the next 00:00 UTC (at least 1)."""
        midnight = datetime(now_utc.year, now_utc.month, now_utc.day, tzinfo=UTC) + timedelta(
            days=1
        )
        return max(1, math.ceil((midnight - now_utc).total_seconds()))

    def _sustainable(self, now_utc: datetime) -> float:
        # Caller holds the lock.
        rate = self._rate_per_s * 60
        if self._daily_limit is None:
            return rate
        self._roll_day(now_utc)
        left = max(0, self._daily_limit - self._used_today)
        minutes = self._reset_in(now_utc) / 60
        return min(rate, left / max(1.0, minutes))

    def _check_daily(self, cost: int, level: str) -> None:
        # Caller holds the lock. Raises when `cost` would use credits kept back for more
        # urgent calls, or more than are left.
        limit = self._daily_limit
        if limit is None:
            return
        now_utc = self._utcnow().astimezone(UTC)
        self._roll_day(now_utc)
        left_after = limit - self._used_today - cost
        if left_after >= 0 and left_after >= limit * DAILY_RESERVES[level]:
            return
        self._refused["daily"] += 1
        raise RateLimited(
            "daily upstream credits used up; resets at 00:00 UTC"
            if left_after < 0
            else "daily upstream credits reserved for more urgent requests",
            retry_after=self._reset_in(now_utc),
        )

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
    it in `CacheStats` under `upstream.<op>.*`. A call the provider's `capabilities` rule
    out raises `ProviderUnsupported` before it takes any tokens; `costs` price the rest."""

    def __init__(
        self,
        inner: MarketDataProvider,
        guard: UpstreamGuard,
        stats: CacheStats | None = None,
        *,
        costs: CostModel | None = None,
        capabilities: Capabilities | None = None,
    ) -> None:
        self._inner = inner
        self._guard = guard
        self._stats = stats if stats is not None else CacheStats()
        self._costs = costs if costs is not None else CostModel()
        self._caps = capabilities if capabilities is not None else Capabilities.full()

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
            with metering(charge), usage_reporting(self._guard.calibrate):
                result = fn()
        except SymbolNotFound:
            # A definite answer from a healthy upstream.
            self._stats.incr(f"{prefix}.not_found")
            self._guard.on_success(epoch)
            raise
        except ProviderUnsupported:
            # Likewise: a definite answer, not a failure of the upstream.
            self._stats.incr(f"{prefix}.unsupported")
            self._guard.on_success(epoch)
            raise
        except LocalRateLimited as exc:
            # The provider held the request back (it would be refused upstream, and
            # charged): not an upstream refusal, so no breaker, and the credits come back.
            self._stats.incr(f"{prefix}.refused")
            self._guard.refund(exc.credits)
            raise
        except RateLimited as exc:
            if any(exc is r for r in refusals):
                raise  # refused locally by `charge`: the upstream did not refuse
            self._stats.incr(f"{prefix}.rate_limited")
            if exc.daily:
                # The allowance is gone: the guard refuses everything until the reset,
                # no cooldown needed. Without a daily limit it is an ordinary refusal.
                reset_in = self._guard.mark_daily_exhausted()
                if reset_in is not None:
                    exc.retry_after = reset_in
                    raise
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

    def seed_usage(self) -> bool:
        """Ask a `MeteredProvider` for its credit usage and calibrate the guard with it
        (one upstream request, in the background). False when the provider is not metered.
        Raises the provider's error."""
        metered = as_metered(self._inner)
        if metered is None:
            return False
        with self._guard.priority("background"):
            usage = self._run("usage", USAGE_COST, metered.usage)
        self._guard.apply_usage(usage)
        return True

    def history(
        self,
        symbol: str,
        interval: str,
        start: datetime | None,
        end: datetime | None,
        prepost: bool,
    ) -> pd.DataFrame:
        if interval not in self._caps.intervals:
            raise ProviderUnsupported(f"{interval} bars")
        return self._run_for(
            "history",
            symbol,
            self._costs.history,
            lambda: self._inner.history(symbol, interval, start, end, prepost),
        )

    def symbol_info(self, symbol: str) -> dict[str, Any]:
        return self._run_for(
            "symbol_info", symbol, self._costs.symbol_info, lambda: self._inner.symbol_info(symbol)
        )

    def _run_for(self, op: str, symbol: str, cost: int, fn: Callable[[], T]) -> T:
        """`_run` for a call about one symbol. When the provider answers it locally (an
        unsupported symbol, an empty result) nothing is taken from the budget."""
        routing = as_symbol_routing(self._inner)
        if routing is not None and routing.answers_locally(op, symbol):
            self._stats.incr(f"upstream.{op}.local")
            return fn()
        return self._run(op, cost, fn)

    def search(self, query: str, limit: int) -> list[dict[str, Any]]:
        if not self._caps.search:
            raise ProviderUnsupported("symbol search")
        return self._run("search", self._costs.search, lambda: self._inner.search(query, limit))

    def _billable(self, symbols: list[str]) -> list[str]:
        """`symbols` as far as they cost anything: duplicates and what the provider
        answers locally are dropped (a provider that knows nothing of them keeps all)."""
        routing = as_symbol_routing(self._inner)
        return routing.billable(symbols) if routing is not None else symbols

    def quotes(self, symbols: list[str]) -> list[dict[str, Any]]:
        # A fallback charges its own cost on top.
        asked = symbols
        symbols = self._billable(symbols)
        if asked and not symbols:
            # All answered locally: the provider's own answer (ProviderUnsupported, with no
            # request sent), at no cost.
            return self._inner.quotes(asked)
        chunks = self._quote_chunks(symbols)
        if len(chunks) == 1:
            return self._run(
                "quotes", self._costs.quotes(len(symbols)), lambda: self._inner.quotes(symbols)
            )
        rows, confirmed, error, rest = self._run_chunks("quotes", chunks, self._inner.quotes)
        if error is not None and len(rest) == len(symbols):
            raise error  # not even the first chunk was served
        # Later chunks refused or failed: serve what came (the rest is unknown, not absent).
        return QuoteList(rows, confirmed=confirmed and error is None)

    def extended_quotes(self, symbols: list[str]) -> list[dict[str, Any]]:
        if not self._caps.extended_quotes:
            raise ProviderUnsupported("extended-hours quotes")
        asked = symbols
        symbols = self._billable(symbols)
        if asked and not symbols:
            return self._inner.extended_quotes(asked)  # answered locally, at no cost
        chunks = self._quote_chunks(symbols)
        if len(chunks) == 1:
            return self._run(
                "extended_quotes",
                self._costs.quotes(len(symbols)),
                lambda: self._inner.extended_quotes(symbols),
            )
        rows, _, error, rest = self._run_chunks(
            "extended_quotes", chunks, self._inner.extended_quotes
        )
        if error is not None:
            if len(rest) < len(symbols):
                raise PartialQuotes(str(error), rows, rest)
            raise error
        return rows

    def _quote_chunks(self, symbols: list[str]) -> list[list[str]]:
        """Split `symbols` so that no request costs more than the guard's burst: a refused
        request may still be charged in full upstream, and the guard could never grant it
        at once. Only upstreams that charge per symbol need it (Yahoo's cost is one per 50
        symbols and stays one call, as before)."""
        costs = self._costs
        if costs.quote_per_symbol <= 0 or len(symbols) <= 1:
            return [symbols]
        burst = self._guard.burst
        if costs.quotes(len(symbols)) <= burst:
            return [symbols]
        lo, hi = 1, len(symbols)  # largest size whose cost fits (at least one symbol)
        while lo < hi:
            mid = (lo + hi + 1) // 2
            if costs.quotes(mid) <= burst:
                lo = mid
            else:
                hi = mid - 1
        return [symbols[i : i + lo] for i in range(0, len(symbols), lo)]

    def _run_chunks(
        self,
        op: str,
        chunks: list[list[str]],
        call: Callable[[list[str]], list[dict[str, Any]]],
    ) -> tuple[list[dict[str, Any]], bool, ProviderError | None, list[str]]:
        """Run `call` for each chunk, each charged and gated on its own (a chunk of a call
        below `interactive` priority is refused when the budget is short, and is skipped).
        Stops at the first refusal or failure. Returns the rows found, whether every chunk
        answered with a confirmed list, the error that stopped the run (None: all done) and
        the symbols not asked for or that failed."""
        rows: list[dict[str, Any]] = []
        confirmed = True
        for i, chunk in enumerate(chunks):
            try:
                got = self._run(op, self._costs.quotes(len(chunk)), partial(call, chunk))
            except ProviderUnsupported:
                continue  # a definite answer for the whole chunk: none of it is served
            except ProviderError as exc:
                log.info("%s: chunk %d of %d not served: %s", op, i + 1, len(chunks), exc)
                return rows, False, exc, [s for rest in chunks[i:] for s in rest]
            rows.extend(got)
            confirmed = confirmed and isinstance(got, QuoteList) and got.confirmed
        return rows, confirmed, None, []

    def events(self, symbol: str) -> dict[str, Any]:
        if not self._caps.events:
            raise ProviderUnsupported("events")
        return self._run_for(
            "events", symbol, self._costs.events, lambda: self._inner.events(symbol)
        )

    def news(self, symbol: str, limit: int) -> list[dict[str, Any]]:
        if not self._caps.news:
            raise ProviderUnsupported("news")
        return self._run("news", self._costs.news, lambda: self._inner.news(symbol, limit))

    def fundamentals(self, symbol: str) -> dict[str, Any]:
        if not (self._caps.fundamentals_info or self._caps.fundamentals_statements):
            raise ProviderUnsupported("fundamentals")
        return self._run_for(
            "fundamentals",
            symbol,
            self._costs.fundamentals,
            lambda: self._inner.fundamentals(symbol),
        )
