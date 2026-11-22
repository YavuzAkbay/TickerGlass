"""Reconnecting WebSocket client shared by the streaming providers (Alpaca, Tiingo and the crypto
exchanges), built on the `websockets` package that `uvicorn[standard]` already installs
(imported only when the default connection factory runs).

A provider builds one `StreamClient` per upstream connection and awaits `run()`:

    client = StreamClient(
        "wss://stream.example.com/v2/iex",
        headers={"Authorization": "..."},
        on_open=authenticate_and_subscribe,   # runs after every (re)connect
        on_message=handle,                    # one decoded JSON value per frame
        max_failures=6,                       # give up (StreamUnavailable) after an outage
    )
    await client.run()        # returns after `close()`; raises `StreamFatal` to give up

- `on_open(client)` runs on every connection, first connect and each reconnect alike, before
  messages are delivered: it sends the auth and subscribe frames (`client.send`). The provider
  keeps the set of wanted symbols and sends all of it here, which is what re-subscribes after
  a reconnect; to change the set while connected it calls `client.send` itself.
- `on_message(message)` gets each frame JSON-decoded (`decode=` replaces the decoder; an
  undecodable frame is logged without its content and skipped). It is awaited inline, so a slow
  handler back-pressures the socket instead of growing a queue: keep it quick (the live sources
  only hand the tick on to the hub, which fans out without waiting). An exception from it is
  logged and the stream goes on; raise `StreamFatal` to stop for good (rejected credentials, a
  connection limit): `run()` closes the socket and re-raises it, the caller decides what next.
- A lost connection, a failed connect or a failing `on_open` is retried with exponential
  backoff and jitter (`Backoff`). Dead peers are found by the websocket-level ping of the
  default factory.
- A connection counts as healthy once it handled a message without an error and stayed up for
  `stable_after_s` (30 s): only then the delay starts over and the failure count is cleared. A
  server that accepts, answers an error frame and hangs up therefore keeps backing off.
- `max_failures=N` (off by default): after N consecutive unhealthy connections or failed
  connects `run()` raises `StreamUnavailable`, so the caller can say the upstream is down (the
  hub then shows "reconnecting" and polls) instead of looking connected while retrying.
- `close()` is idempotent, wakes a pending backoff and closes the socket; `run()` then returns.
  A closed client is final: build a new one to connect again.
- `connect=` is the factory `(url, headers) -> Connection` (tests pass a fake). Credentials go
  in `headers` or frames, never in the URL; the client logs only the host, never headers or
  frames. Frames can carry the credentials (Alpaca's auth, Tiingo's token), so the URL must be
  `wss://` (`ws://` only for a loopback host) and the default factory refuses HTTP redirects
  instead of sending the credentials on to wherever the server points.
"""

import asyncio
import contextlib
import functools
import json
import logging
import random
import time
import urllib.parse
from collections.abc import Awaitable, Callable, Mapping
from typing import Any, Protocol

from .. import __version__
from .http import LOCAL_HOSTS

log = logging.getLogger(__name__)

#: Seconds a connect attempt (TCP, TLS, WebSocket handshake) may take.
CONNECT_TIMEOUT_S = 10.0
#: Seconds between websocket pings of the default factory; a peer that does not answer within
#: `PING_TIMEOUT_S` counts as lost.
PING_INTERVAL_S = 20.0
PING_TIMEOUT_S = 20.0
#: Largest frame accepted from the upstream.
MAX_FRAME_BYTES = 2 * 1024 * 1024
#: Seconds a connection that handled a message must stay up to count as healthy (it ends the
#: backoff and the failure count).
STABLE_AFTER_S = 30.0
#: Consecutive unhealthy connections after which the live sources report the stream as down
#: (with the default backoff that is about half a minute of retrying).
MAX_FAILURES = 6


class StreamError(Exception):
    """Base of the errors of this module."""


class StreamFatal(StreamError):
    """Raised by `on_open` / `on_message` to stop the client: reconnecting would not help (the
    upstream rejected the credentials or the connection). `run()` re-raises it."""


class StreamUnavailable(StreamError):
    """`StreamClient.run` gave up after `max_failures` consecutive failed connections: the
    upstream is down or unreachable (a later attempt may work, unlike `StreamFatal`)."""


class NotConnected(StreamError):
    """`StreamClient.send` while no connection is open (it is being re-established)."""


class Connection(Protocol):
    """The part of a websocket connection the client uses; `websockets`' `ClientConnection`
    satisfies it. `recv` raises (any exception) when the connection is lost or closed."""

    async def send(self, message: str) -> None: ...

    async def recv(self) -> str | bytes: ...

    async def close(self) -> None: ...


def require_wss(url: str, setting: str) -> str:
    """`url` when it is a `wss://` URL, or a `ws://` one for a loopback host; else `ValueError`
    (meant for a config validator: frames of the stream carry the credentials). The message
    never echoes the URL."""
    parts = urllib.parse.urlsplit(url.strip())
    host = (parts.hostname or "").lower()
    if host and (parts.scheme == "wss" or (parts.scheme == "ws" and host in LOCAL_HOSTS)):
        return url
    raise ValueError(
        f"{setting} must be a wss:// URL with a host (plain ws:// is accepted only for "
        "localhost, 127.0.0.1 and ::1)"
    )


ConnectFactory = Callable[[str, Mapping[str, str]], Awaitable[Connection]]
OpenHook = Callable[["StreamClient"], Awaitable[None]]
MessageHook = Callable[[Any], Awaitable[None]]


@functools.cache
def _no_redirect_connect() -> Any:
    """`websockets`' `connect` without redirect following. It follows up to ten redirects,
    across origins too (dropping only Authorization / Cookie headers), and the credentials of
    these streams travel in frames: a redirecting server would receive them."""
    from websockets.asyncio.client import connect

    class NoRedirectConnect(connect):
        def process_redirect(self, exc: Exception) -> Exception | str:
            return exc  # not a redirect we follow: `connect` re-raises the InvalidStatus

    return NoRedirectConnect


async def websockets_connect(url: str, headers: Mapping[str, str]) -> Connection:
    """The default `ConnectFactory`: a `websockets` client connection with ping keep-alive,
    refusing HTTP redirects."""
    connect = _no_redirect_connect()
    conn: Connection = await connect(
        url,
        additional_headers=dict(headers) or None,
        user_agent_header=f"TickerGlass/{__version__}",
        open_timeout=CONNECT_TIMEOUT_S,
        ping_interval=PING_INTERVAL_S,
        ping_timeout=PING_TIMEOUT_S,
        close_timeout=5.0,
        max_size=MAX_FRAME_BYTES,
    )
    return conn


def json_decode(raw: str | bytes) -> Any:
    """The default frame decoder; raises `ValueError` for anything that is not JSON."""
    return json.loads(raw)


class Backoff:
    """Reconnect delays: `initial_s`, then doubling (`factor`) up to `max_s`, each spread by
    +-`jitter` (a fraction) so many clients do not reconnect in step. `rng` returns floats in
    [0, 1) (tests pass a fixed one)."""

    def __init__(
        self,
        initial_s: float = 1.0,
        max_s: float = 60.0,
        factor: float = 2.0,
        jitter: float = 0.25,
        rng: Callable[[], float] = random.random,
    ) -> None:
        if initial_s <= 0 or max_s < initial_s or factor < 1 or not 0 <= jitter < 1:
            raise ValueError("invalid backoff parameters")
        self._initial_s = initial_s
        self._max_s = max_s
        self._factor = factor
        self._jitter = jitter
        self._rng = rng
        self._attempt = 0

    def next_delay(self) -> float:
        """The delay before the next attempt (never above `max_s`)."""
        base = min(self._max_s, self._initial_s * self._factor**self._attempt)
        self._attempt += 1
        spread = 1 + self._jitter * (2 * self._rng() - 1)
        return min(self._max_s, base * spread)

    def reset(self) -> None:
        self._attempt = 0


async def _close_quietly(conn: Connection) -> None:
    try:
        await conn.close()
    except asyncio.CancelledError:
        raise
    except Exception:
        log.debug("closing the websocket failed", exc_info=True)


class StreamClient:
    """One reconnecting WebSocket connection; see the module docstring."""

    def __init__(
        self,
        url: str,
        *,
        on_message: MessageHook,
        on_open: OpenHook | None = None,
        headers: Mapping[str, str] | None = None,
        connect: ConnectFactory = websockets_connect,
        decode: Callable[[str | bytes], Any] = json_decode,
        backoff: Backoff | None = None,
        max_failures: int | None = None,
        stable_after_s: float = STABLE_AFTER_S,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        parts = urllib.parse.urlsplit(url)
        if parts.scheme not in ("ws", "wss") or not parts.netloc:
            raise ValueError(f"url must be ws(s)://host/..., got {parts.scheme!r} scheme")
        if parts.scheme == "ws" and (parts.hostname or "").lower() not in LOCAL_HOSTS:
            raise ValueError("url must be wss:// (plain ws:// only for localhost, 127.0.0.1, ::1)")
        if max_failures is not None and max_failures < 1:
            raise ValueError("max_failures must be at least 1")
        self._max_failures = max_failures
        self._stable_after_s = stable_after_s
        self._clock = clock
        self._failures = 0
        self._handled = False  # the current connection handled a message without an error
        self._url = url
        self._where = parts.netloc  # what is logged: the host, nothing else
        self._on_message = on_message
        self._on_open = on_open
        self._headers: dict[str, str] = dict(headers or {})
        self._connect = connect
        self._decode = decode
        self._backoff = backoff or Backoff()
        self._conn: Connection | None = None
        self._closed = False
        self._stop = asyncio.Event()
        self._send_lock = asyncio.Lock()
        #: Connections established so far; more than one means the client reconnected.
        self.connections = 0

    @property
    def connected(self) -> bool:
        """A connection is open (and `on_open` has run or is running)."""
        return self._conn is not None

    @property
    def closed(self) -> bool:
        return self._closed

    async def send(self, payload: str | bytes | list[Any] | Mapping[str, Any]) -> None:
        """Send one frame on the current connection (JSON-encoded unless `str`). Raises
        `NotConnected` between connections, and the connection's own error when the send
        fails (the receive loop then notices the loss and reconnects)."""
        conn = self._conn
        if conn is None:
            raise NotConnected(f"not connected to {self._where}")
        frame = payload if isinstance(payload, str) else self._encode(payload)
        async with self._send_lock:
            await conn.send(frame)

    @staticmethod
    def _encode(payload: bytes | list[Any] | Mapping[str, Any]) -> str:
        if isinstance(payload, bytes):
            return payload.decode()
        return json.dumps(payload, separators=(",", ":"))

    async def run(self) -> None:
        """Connect, deliver messages and reconnect until `close()` (then return normally).
        Raises `StreamFatal` as raised by a hook, and `StreamUnavailable` after `max_failures`
        consecutive unhealthy connections; cancellation closes the socket and propagates. A
        client that was closed returns at once."""
        try:
            while not self._closed:
                healthy = await self._session()
                if self._closed:
                    break
                if healthy:
                    self._backoff.reset()
                    self._failures = 0
                else:
                    self._failures += 1
                    if self._max_failures is not None and self._failures >= self._max_failures:
                        raise StreamUnavailable(
                            f"stream {self._where}: {self._failures} failed connections in a row"
                        )
                delay = self._backoff.next_delay()
                log.info("stream %s: reconnecting in %.1fs", self._where, delay)
                with contextlib.suppress(TimeoutError):
                    await asyncio.wait_for(self._stop.wait(), delay)
        finally:
            self._closed = True
            self._stop.set()
            conn, self._conn = self._conn, None
            if conn is not None:
                await _close_quietly(conn)

    async def _session(self) -> bool:
        """One connection from connect to loss. Returns when it ended, saying whether it was
        healthy (handled a message and lasted `stable_after_s`); the caller backs off.
        Raises `StreamFatal`."""
        try:
            conn = await self._connect(self._url, self._headers)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log.warning("stream %s: connect failed: %s", self._where, type(exc).__name__)
            return False
        if self._closed:
            await _close_quietly(conn)
            return False
        self._conn = conn
        self.connections += 1
        self._handled = False
        started = self._clock()
        try:
            if self._on_open is not None:
                await self._on_open(self)
            await self._pump(conn)
        except (StreamFatal, asyncio.CancelledError):
            raise
        except Exception as exc:
            if not self._closed:
                log.warning("stream %s: connection lost: %s", self._where, type(exc).__name__)
        finally:
            self._conn = None
            await _close_quietly(conn)
        return self._handled and self._clock() - started >= self._stable_after_s

    async def _pump(self, conn: Connection) -> None:
        while True:
            raw = await conn.recv()
            try:
                message = self._decode(raw)
            except ValueError:
                log.warning("stream %s: undecodable frame of %d bytes", self._where, len(raw))
                continue
            try:
                await self._on_message(message)
            except (StreamFatal, asyncio.CancelledError):
                raise
            except Exception:
                log.warning("stream %s: message handler failed", self._where, exc_info=True)
            else:
                self._handled = True

    async def close(self) -> None:
        """Stop `run()` and close the socket. Idempotent; safe before `run()` and from any
        task of the same event loop."""
        self._closed = True
        self._stop.set()
        conn = self._conn
        if conn is not None:
            await _close_quietly(conn)
