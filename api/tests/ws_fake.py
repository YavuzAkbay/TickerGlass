"""A fake WebSocket network for tests of `providers/stream.py` and the live sources built on
it: in-memory connections and a `ConnectFactory` handing them out. No network."""

import asyncio
import json
from collections.abc import Callable, Mapping
from typing import Any

from tickerglass_api.providers.stream import Connection


class FakeConn:
    """In-memory `Connection`: `feed` queues frames (an exception is raised by `recv`),
    `drop` simulates the peer going away, `sent` holds what the client sent."""

    def __init__(self) -> None:
        self.sent: list[str] = []
        self.closed = False
        self._incoming: asyncio.Queue[str | bytes | Exception] = asyncio.Queue()

    def feed(self, *frames: Any) -> None:
        for frame in frames:
            if not isinstance(frame, str | bytes | Exception):
                frame = json.dumps(frame)
            self._incoming.put_nowait(frame)

    def drop(self) -> None:
        self._incoming.put_nowait(ConnectionResetError("peer gone"))

    def sent_json(self) -> list[Any]:
        return [json.loads(s) for s in self.sent]

    async def send(self, message: str) -> None:
        if self.closed:
            raise ConnectionResetError("closed")
        self.sent.append(message)

    async def recv(self) -> str | bytes:
        item = await self._incoming.get()
        if isinstance(item, Exception):
            raise item
        return item

    async def close(self) -> None:
        self.closed = True
        self._incoming.put_nowait(ConnectionResetError("closed"))


class FakeNet:
    """A `ConnectFactory` handing out `FakeConn`s: `plan` lists the connections or exceptions
    for successive connects (then new empty connections). `calls` holds (url, headers)."""

    def __init__(self, *plan: FakeConn | Exception) -> None:
        self.plan = list(plan)
        self.conns: list[FakeConn] = []
        self.calls: list[tuple[str, dict[str, str]]] = []

    async def __call__(self, url: str, headers: Mapping[str, str]) -> Connection:
        self.calls.append((url, dict(headers)))
        item = self.plan.pop(0) if self.plan else FakeConn()
        if isinstance(item, Exception):
            raise item
        self.conns.append(item)
        return item

    def urls(self) -> list[str]:
        return [url for url, _ in self.calls]


async def until(condition: Callable[[], bool], timeout_s: float = 2.0) -> None:
    """Wait (yielding to the loop) until `condition()` holds; `TimeoutError` otherwise."""

    async def poll() -> None:
        while not condition():  # noqa: ASYNC110 (a polled predicate, not an event)
            await asyncio.sleep(0.001)

    await asyncio.wait_for(poll(), timeout_s)
