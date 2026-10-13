import asyncio
import json
import re
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from ..live import LiveClient, LiveHub

router = APIRouter(tags=["live"])

SYMBOL_RE = re.compile(r"^[A-Za-z0-9.\-=^]{1,32}$")
MAX_FRAME_CHARS = 64 * 1024


def _parse_symbols(value: Any) -> list[str]:
    if not isinstance(value, list) or not value:
        raise ValueError("'symbols' must be a non-empty list of strings")
    bad = [s for s in value if not isinstance(s, str) or not SYMBOL_RE.match(s)]
    if bad:
        shown = ", ".join(repr(s) for s in bad[:5])
        raise ValueError(f"invalid symbol(s): {shown}")
    return [s.upper() for s in value]


async def _handle(hub: LiveHub, client: LiveClient, text: str) -> None:
    if len(text) > MAX_FRAME_CHARS:
        raise ValueError("frame too large")
    try:
        msg = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ValueError("invalid JSON") from exc
    if not isinstance(msg, dict):
        raise ValueError("frame must be a JSON object")
    op = msg.get("op")
    if op == "ping":
        client.send({"type": "pong"})
    elif op == "subscribe":
        symbols = _parse_symbols(msg.get("symbols"))
        await hub.subscribe(client, symbols)
        client.send({"type": "subscribed", "symbols": sorted(client.symbols)})
    elif op == "unsubscribe":
        symbols = _parse_symbols(msg.get("symbols"))
        await hub.unsubscribe(client, symbols)
        client.send({"type": "subscribed", "symbols": sorted(client.symbols)})
    else:
        raise ValueError(f"unknown op: {op!r}")


async def _reader(ws: WebSocket, hub: LiveHub, client: LiveClient) -> None:
    while True:
        text = await ws.receive_text()
        try:
            await _handle(hub, client, text)
        except ValueError as exc:
            client.send({"type": "error", "message": str(exc)})


async def _writer(ws: WebSocket, client: LiveClient) -> None:
    while True:
        frame = await client.queue.get()
        await ws.send_json(frame)


@router.websocket("/ws")
async def live_ws(ws: WebSocket) -> None:
    hub: LiveHub = ws.app.state.live_hub
    await ws.accept()
    client = hub.register()
    try:
        # The reader ends with WebSocketDisconnect; the group then cancels the writer.
        async with asyncio.TaskGroup() as tg:
            tg.create_task(_reader(ws, hub, client))
            tg.create_task(_writer(ws, client))
    except* WebSocketDisconnect:
        pass
    finally:
        await hub.unregister(client)
