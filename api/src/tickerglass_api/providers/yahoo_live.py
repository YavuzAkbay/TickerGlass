"""Yahoo implementation of the live relay's upstream (`LiveSource`)."""

import json
import logging
from typing import Any

import yfinance as yf

from ..live import MessageHandler

log = logging.getLogger(__name__)


class YahooLiveSource:
    """Wraps `yf.AsyncWebSocket`; a fresh socket is created after every `close`.

    `AsyncWebSocket.listen` never returns when the connection drops (it retries on the
    same dead socket), so the receive loop is implemented here and simply ends/raises on
    disconnect, leaving reconnect policy to the hub's supervisor.
    """

    def __init__(self) -> None:
        self._ws: Any = None

    def _socket(self) -> Any:
        if self._ws is None:
            self._ws = yf.AsyncWebSocket(verbose=False)
        return self._ws

    async def subscribe(self, symbols: list[str]) -> None:
        await self._socket().subscribe(symbols)

    async def unsubscribe(self, symbols: list[str]) -> None:
        if self._ws is not None:
            await self._ws.unsubscribe(symbols)

    async def listen(self, handler: MessageHandler) -> None:
        ws = self._socket()
        await ws._connect()
        conn = ws._ws
        async for raw in conn:
            try:
                payload = json.loads(raw)
                decoded = ws._decode_message(payload.get("message", ""))
            except Exception:
                log.warning("undecodable upstream frame", exc_info=True)
                continue
            if isinstance(decoded, dict) and "error" not in decoded:
                await handler(decoded)

    async def close(self) -> None:
        ws, self._ws = self._ws, None
        if ws is not None:
            await ws.close()
