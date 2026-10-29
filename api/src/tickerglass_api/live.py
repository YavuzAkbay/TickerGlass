"""Live price relay: one shared upstream stream fanned out to many WebSocket clients.

The hub ref-counts symbol interest across clients, keeps a single supervised upstream
connection (reconnect with exponential backoff, re-subscribe after reconnect) and falls
back to polling for symbols whose stream is silent or while the upstream is down. A hub
without a source (providers with no stream) only polls, and reports status "polling".
"""

import asyncio
import logging
import math
import time
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime, timedelta
from typing import Any, Literal, Protocol

from .providers.base import MarketDataProvider, ProviderError
from .providers.guard import UpstreamGuard
from .services.bars import SessionLookup
from .services.market import MarketService
from .services.sessions import METADATA_MAX_AGE, TradingHours

log = logging.getLogger(__name__)

MessageHandler = Callable[[dict[str, Any]], Awaitable[None]]
# Batch poll: symbol -> quote fields (price, change, changePercent, dayVolume, dayHigh,
# dayLow, time in unix ms; all but price optional). Symbols without data are omitted.
Poller = Callable[[list[str]], Awaitable[dict[str, dict[str, Any]]]]
UpstreamStatus = Literal["connected", "reconnecting", "polling"]
# Stream `market_hours` values meaning regular trading (0 pre, 1 regular, 2 post,
# 3 extended); anything else is treated as "market closed" for poll cadence.
OPEN_MARKET_HOURS = frozenset({1})
# Seconds a symbol's exchange hours are reused before the stored metadata is read again.
HOURS_REFRESH_S = 300.0
# Topics a client may subscribe to with `{"op": "events", "topics": [...]}`.
EVENT_TOPICS = frozenset({"alerts", "drawings"})
# Longest wait for an upstream's `close()` before giving up on it.
SOURCE_CLOSE_TIMEOUT_S = 5.0


class LiveSource(Protocol):
    """Upstream streaming connection.

    `listen` runs until the connection is lost (returning or raising). The hub then
    calls `close`, waits, and starts over with `subscribe(all symbols)` + `listen`, so
    implementations must be reusable after `close`.

    Canonical message shape: `listen` hands the handler one dict per quote tick, with
    these keys (see `normalize_message`); only `id` and `price` are required:

    - `id`: canonical symbol (Yahoo form, e.g. "BRK-B", "EURUSD=X");
    - `price`: last price (number);
    - `change`, `change_percent`: versus the previous close (numbers);
    - `day_volume`: volume of the session so far (number);
    - `day_high`, `day_low`: range of the session so far (numbers);
    - `time`: tick time in unix milliseconds (defaults to the receive time);
    - `market_hours`: 0 pre-market, 1 regular, 2 post-market, 3 extended; anything but 1
      slows polling down for the symbol.

    A provider whose upstream speaks another shape translates it before the handler.
    """

    async def subscribe(self, symbols: list[str]) -> None: ...

    async def unsubscribe(self, symbols: list[str]) -> None: ...

    async def listen(self, handler: MessageHandler) -> None: ...

    async def close(self) -> None: ...


def _num(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    return out if math.isfinite(out) else None


def _int(value: Any) -> int | None:
    out = _num(value)
    return int(out) if out is not None else None


def normalize_message(msg: dict[str, Any]) -> dict[str, Any] | None:
    """Map a decoded upstream message to a tick frame; None if it is not a usable quote."""
    symbol = msg.get("id")
    price = _num(msg.get("price"))
    if not isinstance(symbol, str) or not symbol or price is None:
        return None
    ts = _int(msg.get("time"))
    return {
        "type": "tick",
        "symbol": symbol.upper(),
        "price": price,
        "change": _num(msg.get("change")),
        "changePercent": _num(msg.get("change_percent")),
        "dayVolume": _int(msg.get("day_volume")),
        "dayHigh": _num(msg.get("day_high")),
        "dayLow": _num(msg.get("day_low")),
        "time": ts if ts is not None else int(time.time() * 1000),
        "marketHours": _int(msg.get("market_hours")),
    }


def _poll_result(rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    return {
        str(row["symbol"]): {
            "price": row.get("last"),
            "change": row.get("change"),
            "changePercent": row.get("changePercent"),
            "dayVolume": row.get("volume"),
        }
        for row in rows
        if row.get("symbol")
    }


def provider_poller(provider: MarketDataProvider) -> Poller:
    """Poll via the provider's batch quotes (one upstream call, shared rate limiter)."""

    async def poll(symbols: list[str]) -> dict[str, dict[str, Any]]:
        return _poll_result(await asyncio.to_thread(provider.quotes, symbols))

    return poll


def market_poller(market: MarketService, guard: UpstreamGuard) -> Poller:
    """Poll through the quote cache, so polls and `/api/quotes` share upstream requests
    while a quote is fresh (its TTL follows the market state: a closed market is not
    polled upstream every round). Only fresh values are returned: a stale one served
    after a failed load would be broadcast as a live tick. Polls run in background mode:
    they yield to interactive requests when the upstream budget runs low, and a refusal
    or failure just skips the round."""

    def fetch(symbols: list[str]) -> list[dict[str, Any]]:
        with guard.background():
            return market.quotes(symbols, stale_ok=False)

    async def poll(symbols: list[str]) -> dict[str, dict[str, Any]]:
        try:
            rows = await asyncio.to_thread(fetch, symbols)
        except ProviderError as exc:
            log.debug("poll skipped for %d symbol(s): %s", len(symbols), exc)
            return {}
        return _poll_result(rows)

    return poll


class LiveClient:
    """One downstream connection: its symbol set and a bounded outbound queue."""

    def __init__(self, maxsize: int) -> None:
        self.symbols: set[str] = set()
        #: Event topics (`op: events`); they do not count toward the symbol cap.
        self.topics: set[str] = set()
        self.queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=maxsize)
        self.dropped = 0

    def send(self, frame: dict[str, Any]) -> None:
        """Enqueue without blocking; on overflow the oldest frame is dropped."""
        while True:
            try:
                self.queue.put_nowait(frame)
                return
            except asyncio.QueueFull:
                try:
                    self.queue.get_nowait()
                    self.dropped += 1
                except asyncio.QueueEmpty:
                    pass


class LiveHub:
    def __init__(
        self,
        source: LiveSource | None,
        poller: Poller,
        *,
        max_symbols_per_client: int = 200,
        queue_size: int = 256,
        poll_after_s: float = 20.0,
        poll_interval_s: float = 15.0,
        poll_closed_interval_s: float = 120.0,
        poll_unchanged_cycles: int = 3,
        poll_batch_size: int = 50,
        backoff_initial_s: float = 1.0,
        backoff_max_s: float = 60.0,
        poll_pacer: Callable[[int], float] | None = None,
        closed_cap_s: float | None = None,
        session_lookup: SessionLookup | None = None,
        metadata_max_age: timedelta = METADATA_MAX_AGE,
        utcnow: Callable[[], datetime] = lambda: datetime.now(UTC),
        close_timeout_s: float = SOURCE_CLOSE_TIMEOUT_S,
    ) -> None:
        # Longest wait for an upstream's `close()` (a hung one must not stall a switch or
        # the shutdown).
        self._close_timeout_s = close_timeout_s
        # `poll_pacer(n)`: fewest seconds between polls of a symbol while `n` symbols are
        # polled at the live cadence, so polling stays within the upstream's credits.
        self._poll_pacer = poll_pacer
        # Metered upstreams: a symbol whose stored hours say the exchange is closed is not
        # polled again before it opens (at most `closed_cap_s` later, at least the closed
        # interval). None: the closed interval alone.
        self._closed_cap_s = closed_cap_s
        self._hold_until: dict[str, float] = {}
        # Stored symbol metadata (never an upstream call): symbols whose exchange is
        # closed are polled at the closed cadence only.
        self._session_lookup = session_lookup
        self._metadata_max_age = metadata_max_age
        self._utcnow = utcnow
        self._hours: dict[str, tuple[float, TradingHours | None]] = {}
        # None: the provider has no stream; every symbol is polled right away.
        self._source = source
        self._poller = poller
        self.max_symbols_per_client = max_symbols_per_client
        self._queue_size = queue_size
        self._poll_after_s = poll_after_s
        self._poll_interval_s = poll_interval_s
        self._poll_closed_interval_s = poll_closed_interval_s
        self._poll_unchanged_cycles = poll_unchanged_cycles
        self._poll_batch_size = max(1, poll_batch_size)
        self._backoff_initial_s = backoff_initial_s
        self._backoff_max_s = backoff_max_s

        self._clients: set[LiveClient] = set()
        self._refs: dict[str, int] = {}
        # Symbols currently subscribed on the live upstream connection.
        self._upstream_subs: set[str] = set()
        self._upstream_lock = asyncio.Lock()
        self._connected = False
        self._got_message = False
        # Monotonic time of last streamed tick (or of first interest) per symbol.
        self._last_stream: dict[str, float] = {}
        self._last_poll: dict[str, float] = {}
        # Last streamed market_hours, last polled price and consecutive unchanged polls.
        self._market_hours: dict[str, int] = {}
        self._poll_price: dict[str, float] = {}
        self._unchanged: dict[str, int] = {}
        # Symbols that received poll ticks since their last streamed tick.
        self._polling: set[str] = set()
        self._status: UpstreamStatus | None = "polling" if source is None else None
        self._tasks: list[asyncio.Task[None]] = []
        self._closed = False
        self._reconfiguring = False
        self._loop: asyncio.AbstractEventLoop | None = None

    @property
    def status(self) -> UpstreamStatus | None:
        return self._status

    # -- event topics ------------------------------------------------------

    def bind_loop(self, loop: asyncio.AbstractEventLoop | None) -> None:
        """The loop `publish_threadsafe` schedules on (captured in the app lifespan)."""
        self._loop = loop

    def set_topics(self, client: LiveClient, topics: list[str]) -> None:
        """Replace the client's topic set. Raises ValueError (set unchanged) on unknown topics."""
        for topic in topics:
            if topic not in EVENT_TOPICS:
                raise ValueError(f"unknown topic {topic!r}")
        client.topics = set(topics)

    def publish(self, topic: str, frame: dict[str, Any]) -> None:
        """Fan a frame out to the clients holding `topic`. Event-loop thread only."""
        out = {**frame, "topic": topic}
        for client in tuple(self._clients):
            if topic in client.topics:
                client.send(out)

    def publish_threadsafe(self, topic: str, frame: dict[str, Any]) -> None:
        """`publish` from any thread (sync routes run in the threadpool). Call after commit."""
        loop = self._loop
        if loop is None or loop.is_closed():
            log.debug("dropping %s frame: event loop not available", topic)
            return
        try:
            loop.call_soon_threadsafe(self.publish, topic, frame)
        except RuntimeError:
            log.debug("dropping %s frame: event loop closed", topic)

    # -- client management -------------------------------------------------

    def register(self) -> LiveClient:
        client = LiveClient(self._queue_size)
        self._clients.add(client)
        if self._status is not None:
            client.send({"type": "status", "upstream": self._status})
        return client

    async def unregister(self, client: LiveClient) -> None:
        self._clients.discard(client)
        await self.unsubscribe(client, list(client.symbols))

    async def subscribe(self, client: LiveClient, symbols: list[str]) -> list[str]:
        """Add symbols for a client. Raises ValueError when the per-client cap is exceeded."""
        wanted = [s for s in dict.fromkeys(symbols) if s not in client.symbols]
        if len(client.symbols) + len(wanted) > self.max_symbols_per_client:
            raise ValueError(f"at most {self.max_symbols_per_client} symbols per connection")
        now = time.monotonic()
        new_upstream: list[str] = []
        for sym in wanted:
            client.symbols.add(sym)
            count = self._refs.get(sym, 0)
            self._refs[sym] = count + 1
            if count == 0:
                new_upstream.append(sym)
                self._last_stream[sym] = now
        if new_upstream:
            self._ensure_started()
            async with self._upstream_lock:
                pending = [
                    s for s in new_upstream if s in self._refs and s not in self._upstream_subs
                ]
                if self._source is not None and self._connected and pending:
                    try:
                        await self._source.subscribe(pending)
                        self._upstream_subs.update(pending)
                    except Exception:
                        # The poll fallback covers these until the next reconnect re-subscribes.
                        log.warning("upstream subscribe failed for %s", pending, exc_info=True)
        return wanted

    async def unsubscribe(self, client: LiveClient, symbols: list[str]) -> None:
        gone: list[str] = []
        for sym in dict.fromkeys(symbols):
            if sym not in client.symbols:
                continue
            client.symbols.discard(sym)
            count = self._refs.get(sym, 0) - 1
            if count > 0:
                self._refs[sym] = count
            else:
                self._refs.pop(sym, None)
                self._last_stream.pop(sym, None)
                self._forget_poll_state(sym)
                self._market_hours.pop(sym, None)
                self._hours.pop(sym, None)
                gone.append(sym)
        if not gone:
            return
        async with self._upstream_lock:
            pending = [s for s in gone if s not in self._refs and s in self._upstream_subs]
            if not pending:
                return
            self._upstream_subs.difference_update(pending)
            if self._source is not None and self._connected:
                try:
                    await self._source.unsubscribe(pending)
                except Exception:
                    log.warning("upstream unsubscribe failed for %s", pending, exc_info=True)

    async def _stop_tasks(self) -> None:
        """Cancel the upstream and poller tasks and wait for them; `_ensure_started`
        starts them again."""
        tasks, self._tasks = self._tasks, []
        for task in tasks:
            task.cancel()
        for task in tasks:
            try:
                await task
            except asyncio.CancelledError:
                pass
            except Exception:
                log.exception("live task failed during shutdown")
        self._connected = False

    async def close(self) -> None:
        self._closed = True
        self._loop = None
        await self._stop_tasks()
        if self._source is not None:
            await self._close_source(self._source)

    async def _close_source(self, source: LiveSource) -> None:
        """Close an upstream, giving up (and logging) after `close_timeout_s`."""
        try:
            await asyncio.wait_for(source.close(), self._close_timeout_s)
        except TimeoutError:
            log.warning("closing the upstream timed out after %.1fs", self._close_timeout_s)
        except Exception:
            log.warning("closing the upstream failed", exc_info=True)

    def set_poller(self, poller: Poller, session_lookup: SessionLookup | None) -> None:
        """Give the hub another poller and session lookup (the services of a rebuilt stack
        on the same upstream) without resetting anything: the stream, the tasks and every
        symbol's poll state carry on, so nothing is polled again early."""
        self._poller = poller
        self._session_lookup = session_lookup

    async def reconfigure(
        self,
        source: LiveSource | None,
        poller: Poller,
        *,
        poll_after_s: float,
        poll_interval_s: float,
        poll_closed_interval_s: float,
        poll_pacer: Callable[[int], float] | None,
        closed_cap_s: float | None,
        session_lookup: SessionLookup | None,
        metadata_max_age: timedelta,
        notice: dict[str, Any] | None = None,
    ) -> None:
        """Move the hub to another upstream (provider switch) without touching its clients:
        their symbol subscriptions stay and are re-subscribed on `source` (or polled, when
        it is None). Everything learnt about the old upstream per symbol is dropped. `notice`
        is sent to every client, whatever its topics, once the hub runs on the new upstream.

        The hub owns `source` from the call on: if the hub is (or gets) closed meanwhile, it
        closes `source` instead of running on it."""
        if self._closed:
            if source is not None:
                await self._close_source(source)
            return
        # Keeps a subscribe arriving meanwhile from starting tasks on the old upstream.
        self._reconfiguring = True
        try:
            async with self._upstream_lock:
                await self._stop_tasks()
                old = self._source
                if old is not None:
                    await self._close_source(old)
                self._source = source
                self._poller = poller
                self._poll_after_s = poll_after_s
                self._poll_interval_s = poll_interval_s
                self._poll_closed_interval_s = poll_closed_interval_s
                self._poll_pacer = poll_pacer
                self._closed_cap_s = closed_cap_s
                self._session_lookup = session_lookup
                self._metadata_max_age = metadata_max_age
                self._connected = False
                self._got_message = False
                self._upstream_subs = set()
                self._polling.clear()
                self._last_poll.clear()
                self._poll_price.clear()
                self._unchanged.clear()
                self._hold_until.clear()
                self._hours.clear()
                self._market_hours.clear()
                now = time.monotonic()
                self._last_stream = dict.fromkeys(self._refs, now)
                self._status = "polling" if source is None else None
        finally:
            self._reconfiguring = False
        if self._closed:
            # `close` ran meanwhile (it does not wait for the upstream lock) and closed the
            # old upstream: the new one is ours to close.
            await self._stop_tasks()
            if source is not None:
                await self._close_source(source)
            return
        if notice is not None:
            self._broadcast(notice)
        if source is None:
            self._broadcast({"type": "status", "upstream": "polling"})
        if self._refs:
            self._ensure_started()

    # -- fan-out -------------------------------------------------------------

    def _fan_out(self, tick: dict[str, Any]) -> None:
        sym = tick["symbol"]
        for client in self._clients:
            if sym in client.symbols:
                client.send(tick)

    def _broadcast(self, frame: dict[str, Any]) -> None:
        for client in self._clients:
            client.send(frame)

    def _set_status(self) -> None:
        # "polling" only describes a down upstream; slow-polling quiet or closed-market
        # symbols while connected is normal operation.
        status: UpstreamStatus
        if self._source is None:
            status = "polling"
        elif self._connected:
            status = "connected"
        elif self._polling:
            status = "polling"
        else:
            status = "reconnecting"
        if status != self._status:
            self._status = status
            self._broadcast({"type": "status", "upstream": status})

    async def _on_message(self, msg: dict[str, Any]) -> None:
        tick = normalize_message(msg)
        if tick is None:
            return
        self._got_message = True
        sym = tick["symbol"]
        if sym not in self._refs:
            return
        self._last_stream[sym] = time.monotonic()
        if tick["marketHours"] is not None:
            self._market_hours[sym] = tick["marketHours"]
        if sym in self._polling:
            self._forget_poll_state(sym)
            self._set_status()
        self._fan_out(tick)

    def _forget_poll_state(self, sym: str) -> None:
        self._polling.discard(sym)
        self._last_poll.pop(sym, None)
        self._poll_price.pop(sym, None)
        self._unchanged.pop(sym, None)
        self._hold_until.pop(sym, None)

    # -- background tasks ----------------------------------------------------

    def _ensure_started(self) -> None:
        if self._tasks or self._closed or self._reconfiguring:
            return
        self._tasks = []
        if self._source is not None:
            self._tasks.append(asyncio.create_task(self._run_upstream(), name="live-upstream"))
        self._tasks.append(asyncio.create_task(self._run_poller(), name="live-poller"))

    async def _run_upstream(self) -> None:
        source = self._source
        assert source is not None
        backoff = self._backoff_initial_s
        while True:
            self._got_message = False
            try:
                async with self._upstream_lock:
                    symbols = sorted(self._refs)
                    if symbols:
                        await source.subscribe(symbols)
                    self._upstream_subs = set(symbols)
                    self._connected = True
                self._set_status()
                await source.listen(self._on_message)
                log.warning("upstream stream ended; reconnecting")
            except asyncio.CancelledError:
                raise
            except Exception:
                log.warning("upstream stream failed; reconnecting", exc_info=True)
            self._connected = False
            self._upstream_subs = set()
            self._set_status()
            try:
                await source.close()
            except Exception:
                log.warning("closing upstream failed", exc_info=True)
            if self._got_message:
                backoff = self._backoff_initial_s
            log.info("upstream reconnect in %.1fs", backoff)
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, self._backoff_max_s)

    def _load_hours(self, symbols: list[str]) -> dict[str, TradingHours | None]:
        """Trading hours of `symbols` from stored metadata. Blocking (sqlite): runs on a
        worker thread. A failing lookup leaves the symbol's hours unknown."""
        lookup = self._session_lookup
        assert lookup is not None
        out: dict[str, TradingHours | None] = {}
        for sym in symbols:
            hours: TradingHours | None = None
            try:
                info = lookup(sym)
                if info is not None:
                    hours = TradingHours.from_symbol_info(
                        info, now=self._utcnow(), max_age=self._metadata_max_age
                    )
            except Exception:
                log.warning("session lookup failed for %s", sym, exc_info=True)
            out[sym] = hours
        return out

    async def _refresh_hours(self, symbols: list[str]) -> None:
        """Load the hours of the symbols whose cached ones are missing or older than
        `HOURS_REFRESH_S`, in one worker-thread call so the event loop never waits for
        the database."""
        if self._session_lookup is None:
            return
        mono = time.monotonic()
        needed = [
            sym
            for sym in symbols
            if (cached := self._hours.get(sym)) is None or mono - cached[0] >= HOURS_REFRESH_S
        ]
        if not needed:
            return
        loaded = await asyncio.to_thread(self._load_hours, needed)
        stamp = time.monotonic()
        for sym, hours in loaded.items():
            if sym in self._refs:  # not unsubscribed while the lookup ran
                self._hours[sym] = (stamp, hours)

    def _session_closed(self, sym: str) -> bool:
        """The symbol's exchange is closed for its regular session now, by the hours
        `_refresh_hours` loaded. Unknown hours and symbols that trade around the clock
        are never closed."""
        cached = self._hours.get(sym)
        hours = cached[1] if cached is not None else None
        return hours is not None and not hours.is_open(self._utcnow())

    def _slow(self, sym: str) -> bool:
        """Polled at the closed cadence: market closed (as streamed or by its hours) or
        the price has stopped moving."""
        hours = self._market_hours.get(sym)
        closed = hours is not None and hours not in OPEN_MARKET_HOURS
        return (
            closed
            or self._unchanged.get(sym, 0) >= self._poll_unchanged_cycles
            or self._session_closed(sym)
        )

    def symbol_count(self) -> int:
        """Symbols some client is subscribed to."""
        return len(self._refs)

    def _hold_after_poll(self, sym: str, started: float) -> None:
        """Remember until when a just-polled symbol of a closed exchange needs no poll."""
        self._hold_until.pop(sym, None)
        cached = self._hours.get(sym)
        hours = cached[1] if cached is not None else None
        if self._closed_cap_s is None or hours is None:
            return
        now = self._utcnow()
        if hours.is_open(now):
            return
        until_open = (hours.next_open(now) - now).total_seconds()
        hold = max(self._poll_closed_interval_s, min(until_open, self._closed_cap_s))
        self._hold_until[sym] = started + hold

    def _poll_interval(self, sym: str) -> float:
        return self._poll_closed_interval_s if self._slow(sym) else self._poll_interval_s

    async def _run_poller(self) -> None:
        tick_s = max(0.01, min(self._poll_after_s, self._poll_interval_s, 1.0) / 2)
        while True:
            now = time.monotonic()
            due: list[str] = []
            polled: list[str] = []
            for sym in list(self._refs):
                stale = (not self._connected) or (
                    now - self._last_stream.get(sym, now) >= self._poll_after_s
                )
                if not stale:
                    if sym in self._polling:
                        self._forget_poll_state(sym)
                        self._set_status()
                    continue
                polled.append(sym)
            await self._refresh_hours(polled)
            pace = 0.0
            if self._poll_pacer is not None:
                live = sum(1 for sym in polled if not self._slow(sym))
                pace = self._poll_pacer(live) if live else 0.0
            for sym in polled:
                if now < self._hold_until.get(sym, -math.inf):
                    continue
                interval = max(self._poll_interval(sym), pace)
                if now - self._last_poll.get(sym, -math.inf) >= interval:
                    due.append(sym)
            for start in range(0, len(due), self._poll_batch_size):
                await self._poll_batch(due[start : start + self._poll_batch_size])
            await asyncio.sleep(tick_s)

    async def _poll_batch(self, symbols: list[str]) -> None:
        started = time.monotonic()
        for sym in symbols:
            self._last_poll[sym] = started
            self._hold_after_poll(sym, started)
        try:
            quotes = await self._poller(symbols)
        except Exception:
            log.warning("poll failed for %d symbol(s)", len(symbols), exc_info=True)
            return
        now = time.monotonic()
        emitted = False
        for sym in symbols:
            quote = quotes.get(sym)
            price = _num(quote.get("price")) if quote else None
            if quote is None or price is None or sym not in self._refs:
                continue
            # A streamed tick may have arrived while the poll was in flight.
            if self._connected and now - self._last_stream[sym] < self._poll_after_s:
                continue
            if self._poll_price.get(sym) == price:
                self._unchanged[sym] = self._unchanged.get(sym, 0) + 1
            else:
                self._unchanged[sym] = 0
            self._poll_price[sym] = price
            self._polling.add(sym)
            emitted = True
            ts = _int(quote.get("time"))
            self._fan_out(
                {
                    "type": "tick",
                    "symbol": sym,
                    "price": price,
                    "change": _num(quote.get("change")),
                    "changePercent": _num(quote.get("changePercent")),
                    "dayVolume": _int(quote.get("dayVolume")),
                    "dayHigh": _num(quote.get("dayHigh")),
                    "dayLow": _num(quote.get("dayLow")),
                    "time": ts if ts is not None else int(time.time() * 1000),
                    "marketHours": self._market_hours.get(sym),
                    "source": "poll",
                }
            )
        if emitted:
            self._set_status()
