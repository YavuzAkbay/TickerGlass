"""`LiveSource` over an exchange's public ticker WebSocket: one reconnecting connection that
subscribes to every wanted pair and hands rolling-24-hour ticks to the hub in its message shape.

The exchange-specific part (frames to send, how to read a tick) is the `Stream` of the adapter;
this module keeps the wanted symbols, re-sends them after every reconnect and maps the stream's
names back to the symbols the hub subscribed with (`XBT-USD` and `BTC-USD` may be one pair).
Symbols that are not crypto-shaped are ignored: the hub polls them. The connection opens only
once a symbol is wanted and is closed again when the last one goes (Coinbase drops a connection
that does not subscribe within seconds).
"""

import asyncio
import logging
from collections.abc import Callable
from typing import Any

from ...live import MessageHandler
from ..base import ProviderError
from ..stream import (
    MAX_FAILURES,
    Backoff,
    ConnectFactory,
    StreamClient,
    StreamError,
    websockets_connect,
)
from .base import Stream, canonical_symbol

log = logging.getLogger(__name__)


class CryptoLiveSource:
    """Streams ticks of the pairs subscribed to. `listen` ends with a `ProviderError` when the
    exchange rejects the connection for good or cannot be reached `max_failures` times in a row
    (see `StreamClient`), so the hub shows the stream down and backs off while it polls; `close`
    drops all state (the hub subscribes again before the next `listen`)."""

    def __init__(
        self,
        stream: Stream,
        *,
        url: str | None = None,
        connect: ConnectFactory = websockets_connect,
        backoff_factory: Callable[[], Backoff] | None = None,
        max_failures: int | None = MAX_FAILURES,
    ) -> None:
        self._max_failures = max_failures
        self._stream = stream
        self._url = url or stream.url
        self._connect = connect
        self._backoff_factory = backoff_factory
        #: Stream symbol -> the symbols the hub asked for it by.
        self._wanted: dict[str, list[str]] = {}
        #: Stream symbols the server was told to stream on the current connection.
        self._sent: set[str] = set()
        self._ready = False
        self._client: StreamClient | None = None
        self._handler: MessageHandler | None = None
        self._listening = False
        self._wake = asyncio.Event()
        self._lock = asyncio.Lock()

    async def subscribe(self, symbols: list[str]) -> None:
        for raw in symbols:
            canonical = canonical_symbol(raw)
            if canonical is None:
                continue
            names = self._wanted.setdefault(self._stream.symbol(canonical), [])
            name = raw.strip().upper()
            if name not in names:
                names.append(name)
        await self._sync()
        self._wake.set()

    async def unsubscribe(self, symbols: list[str]) -> None:
        for raw in symbols:
            canonical = canonical_symbol(raw)
            if canonical is None:
                continue
            sid = self._stream.symbol(canonical)
            names = self._wanted.get(sid)
            if names is None:
                continue
            if raw.strip().upper() in names:
                names.remove(raw.strip().upper())
            if not names:
                del self._wanted[sid]
        if not self._wanted:
            # Nothing left to stream: hang up (an exchange may drop an idle connection anyway)
            # and let `listen` wait until a symbol is wanted again.
            client = self._client
            if client is not None:
                await client.close()
            return
        await self._sync()

    async def _reconcile(self, client: StreamClient) -> None:
        """Send what makes the server's subscription match the wanted symbols, until it does
        (they may change while the frames are being sent). Holds `_lock`."""
        while True:
            add = [s for s in self._wanted if s not in self._sent]
            drop = [s for s in self._sent if s not in self._wanted]
            if not add and not drop:
                return
            if drop:
                for frame in self._stream.unsubscribe(drop):
                    await client.send(frame)
                self._sent.difference_update(drop)
            if add:
                for frame in self._stream.subscribe(add):
                    await client.send(frame)
                self._sent.update(add)

    async def _sync(self) -> None:
        """Make the server's subscription match the wanted symbols (when connected)."""
        client = self._client
        if client is None or not self._ready:
            return  # `_on_open` is not done yet: it sends the difference when it is
        async with self._lock:
            try:
                await self._reconcile(client)
            except StreamError:
                log.debug("crypto stream: subscription deferred to the reconnect")
            except Exception:
                log.debug("crypto stream: subscription send failed", exc_info=True)

    async def _on_open(self, client: StreamClient) -> None:
        async with self._lock:
            self._ready = False
            self._sent.clear()
            # A symbol subscribed while the frames go out finds `_ready` false and sends
            # nothing: `_reconcile` loops until nothing is left, and `_ready` is set without
            # an await after its last look, so no change can slip in between.
            await self._reconcile(client)
            self._ready = True

    async def _on_message(self, message: Any) -> None:
        handler = self._handler
        if handler is None:
            return
        for tick in self._stream.parse(message):
            for name in self._wanted.get(str(tick.get("id")), ()):
                await handler({**tick, "id": name})

    async def listen(self, handler: MessageHandler) -> None:
        self._handler = handler
        self._listening = True
        self._wake.clear()
        try:
            while self._listening:
                if not self._wanted:
                    await self._wake.wait()
                    self._wake.clear()
                    continue
                self._client = StreamClient(
                    self._url,
                    on_open=self._on_open,
                    on_message=self._on_message,
                    connect=self._connect,
                    backoff=self._backoff_factory() if self._backoff_factory else None,
                    max_failures=self._max_failures,
                )
                try:
                    # Returns when the last symbol is unsubscribed (or on `close`).
                    await self._client.run()
                except StreamError as exc:  # rejected for good, or the stream being down
                    raise ProviderError(str(exc)) from None
                finally:
                    self._client = None
                    self._ready = False
                    self._sent.clear()
        finally:
            self._listening = False
            self._ready = False
            self._client = None
            self._sent.clear()

    async def close(self) -> None:
        """Stop `listen`, close the connection and forget every subscription."""
        self._listening = False
        self._wake.set()
        client = self._client
        if client is not None:
            await client.close()
        self._wanted.clear()
        self._sent.clear()
        self._ready = False
