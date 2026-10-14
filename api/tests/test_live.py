import asyncio
import threading
import time
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import pandas as pd
import pytest
from fastapi.testclient import TestClient
from starlette.testclient import WebSocketTestSession

from investopen_api.app import create_app
from investopen_api.live import LiveHub, MessageHandler, normalize_message
from investopen_api.providers.base import BAR_COLUMNS
from investopen_api.settings import get_settings


class FakeProvider:
    def history(self, *args: Any, **kwargs: Any) -> pd.DataFrame:
        return pd.DataFrame(columns=BAR_COLUMNS)

    def symbol_info(self, symbol: str) -> dict[str, Any]:
        return {"symbol": symbol}

    def search(self, query: str, limit: int) -> list[dict[str, Any]]:
        return []

    def extended_quotes(self, symbols: list[str]) -> list[dict[str, Any]]:
        return []


class FakeSource:
    """In-memory LiveSource; `emit` may be called from the test thread."""

    def __init__(self) -> None:
        self.subscribed: list[str] = []
        self.unsubscribed: list[str] = []
        self.listening = threading.Event()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._queue: asyncio.Queue[dict[str, Any]] | None = None

    async def subscribe(self, symbols: list[str]) -> None:
        self.subscribed.extend(symbols)

    async def unsubscribe(self, symbols: list[str]) -> None:
        self.unsubscribed.extend(symbols)

    async def listen(self, handler: MessageHandler) -> None:
        self._loop = asyncio.get_running_loop()
        self._queue = asyncio.Queue()
        self.listening.set()
        while True:
            await handler(await self._queue.get())

    async def close(self) -> None:
        self.listening.clear()

    def emit(self, msg: dict[str, Any]) -> None:
        assert self.listening.wait(2), "upstream never started listening"
        assert self._loop is not None and self._queue is not None
        self._loop.call_soon_threadsafe(self._queue.put_nowait, msg)


class FakePoller:
    """Batch poller; prices move on every call except for symbols in `constant`."""

    def __init__(self, constant: frozenset[str] = frozenset()) -> None:
        self.batches: list[list[str]] = []
        self.constant = constant

    @property
    def calls(self) -> int:
        return len(self.batches)

    def count(self, symbol: str) -> int:
        return sum(batch.count(symbol) for batch in self.batches)

    async def __call__(self, symbols: list[str]) -> dict[str, dict[str, Any]]:
        self.batches.append(list(symbols))
        return {
            s: {
                "price": 10.5 if s in self.constant else 10.0 + self.count(s),
                "change": 0.5,
                "changePercent": 5.0,
                "time": 1_700_000_000_000,
            }
            for s in symbols
        }


def wait_for(cond: Callable[[], bool], timeout: float = 2.0) -> None:
    deadline = time.monotonic() + timeout
    while not cond():
        assert time.monotonic() < deadline, "condition not met in time"
        time.sleep(0.005)


def recv(ws: WebSocketTestSession, type_: str) -> dict[str, Any]:
    """Next frame of the given type, skipping status broadcasts."""
    while True:
        frame: dict[str, Any] = ws.receive_json()
        if frame["type"] == type_:
            return frame
        assert frame["type"] == "status", frame


def quote(symbol: str, price: float) -> dict[str, Any]:
    return {
        "id": symbol,
        "price": price,
        "time": "1791882729000",
        "change": -11.74,
        "change_percent": -0.014,
        "day_volume": "30375493632",
        "day_high": 84059.52,
        "day_low": 81197.99,
        "market_hours": 1,
    }


@pytest.fixture
def live_settings(monkeypatch: pytest.MonkeyPatch) -> Callable[[float, float], None]:
    def apply(poll_after: float, poll_interval: float) -> None:
        monkeypatch.setenv("LIVE_POLL_AFTER_S", str(poll_after))
        monkeypatch.setenv("LIVE_POLL_INTERVAL_S", str(poll_interval))
        get_settings.cache_clear()

    yield apply
    get_settings.cache_clear()


@pytest.fixture
def make_client(tmp_path: Path) -> Iterator[Callable[..., TestClient]]:
    clients: list[TestClient] = []

    def make(source: FakeSource, poller: FakePoller | None = None) -> TestClient:
        app = create_app(
            provider=FakeProvider(),
            database_url=f"sqlite:///{tmp_path}/t.db",
            live_source=source,
            live_poller=poller or FakePoller(),
        )
        client = TestClient(app)
        client.__enter__()
        clients.append(client)
        return client

    yield make
    for c in clients:
        c.__exit__(None, None, None)


def test_normalize_message() -> None:
    tick = normalize_message(quote("btc-usd", 83451.6))
    assert tick == {
        "type": "tick",
        "symbol": "BTC-USD",
        "price": 83451.6,
        "change": -11.74,
        "changePercent": -0.014,
        "dayVolume": 30375493632,
        "dayHigh": 84059.52,
        "dayLow": 81197.99,
        "time": 1791882729000,
        "marketHours": 1,
    }
    assert normalize_message({"id": "X"}) is None


def test_subscribe_delivers_tick(
    make_client: Callable[..., TestClient], live_settings: Callable[[float, float], None]
) -> None:
    live_settings(60, 60)
    source = FakeSource()
    client = make_client(source)
    with client.websocket_connect("/ws") as ws:
        ws.send_json({"op": "subscribe", "symbols": ["btc-usd"]})
        assert recv(ws, "subscribed")["symbols"] == ["BTC-USD"]
        source.emit(quote("ETH-USD", 1.0))  # not subscribed: must not be delivered
        source.emit(quote("BTC-USD", 83451.6))
        tick = recv(ws, "tick")
        assert tick["symbol"] == "BTC-USD"
        assert tick["price"] == 83451.6
        assert tick["time"] == 1791882729000
        assert "source" not in tick
    assert source.subscribed == ["BTC-USD"]


def test_shared_upstream_subscription(
    make_client: Callable[..., TestClient], live_settings: Callable[[float, float], None]
) -> None:
    live_settings(60, 60)
    source = FakeSource()
    client = make_client(source)
    with client.websocket_connect("/ws") as a:
        a.send_json({"op": "subscribe", "symbols": ["AAPL"]})
        recv(a, "subscribed")
        wait_for(source.listening.is_set)
        with client.websocket_connect("/ws") as b:
            b.send_json({"op": "subscribe", "symbols": ["AAPL", "MSFT"]})
            assert recv(b, "subscribed")["symbols"] == ["AAPL", "MSFT"]
            source.emit(quote("AAPL", 200.0))
            assert recv(a, "tick")["price"] == 200.0
            assert recv(b, "tick")["price"] == 200.0
            assert source.subscribed == ["AAPL", "MSFT"]
        # b left: MSFT dropped upstream, AAPL still held by a.
        wait_for(lambda: source.unsubscribed == ["MSFT"])
        a.send_json({"op": "ping"})
        recv(a, "pong")
        assert source.unsubscribed == ["MSFT"]
    wait_for(lambda: source.unsubscribed == ["MSFT", "AAPL"])


def test_invalid_input_and_ping(
    make_client: Callable[..., TestClient], live_settings: Callable[[float, float], None]
) -> None:
    live_settings(60, 60)
    source = FakeSource()
    client = make_client(source)
    with client.websocket_connect("/ws") as ws:
        ws.send_json({"op": "subscribe", "symbols": ["AAPL; DROP"]})
        assert "invalid symbol" in recv(ws, "error")["message"]
        ws.send_text("not json")
        assert recv(ws, "error")["message"] == "invalid JSON"
        ws.send_json({"op": "nope"})
        assert "unknown op" in recv(ws, "error")["message"]
        ws.send_json({"op": "subscribe", "symbols": [f"S{i}" for i in range(201)]})
        assert "at most 200" in recv(ws, "error")["message"]
        ws.send_json({"op": "ping"})
        assert recv(ws, "pong") == {"type": "pong"}
    assert source.subscribed == []


def test_unsubscribe_and_disconnect_cleanup(
    make_client: Callable[..., TestClient], live_settings: Callable[[float, float], None]
) -> None:
    live_settings(60, 60)
    source = FakeSource()
    client = make_client(source)
    with client.websocket_connect("/ws") as ws:
        ws.send_json({"op": "subscribe", "symbols": ["AAPL", "TSLA"]})
        recv(ws, "subscribed")
        wait_for(source.listening.is_set)
        ws.send_json({"op": "unsubscribe", "symbols": ["TSLA"]})
        assert recv(ws, "subscribed")["symbols"] == ["AAPL"]
        assert source.unsubscribed == ["TSLA"]
    wait_for(lambda: source.unsubscribed == ["TSLA", "AAPL"])
    hub = client.app.state.live_hub  # type: ignore[attr-defined]
    assert hub._refs == {} and hub._clients == set()


def test_polling_fallback_and_resume(
    make_client: Callable[..., TestClient], live_settings: Callable[[float, float], None]
) -> None:
    live_settings(0.2, 0.02)
    source = FakeSource()
    poller = FakePoller()
    client = make_client(source, poller)
    with client.websocket_connect("/ws") as ws:
        ws.send_json({"op": "subscribe", "symbols": ["AAPL"]})
        recv(ws, "subscribed")
        # Upstream is connected but silent, so after poll_after the poller takes over.
        statuses: list[str] = []
        frame = ws.receive_json()
        while frame["type"] != "tick":
            if frame["type"] == "status":
                statuses.append(frame["upstream"])
            frame = ws.receive_json()
        assert frame["source"] == "poll"
        assert frame["symbol"] == "AAPL"
        assert frame["price"] == 11.0
        assert frame["change"] == 0.5 and frame["changePercent"] == 5.0
        # Slow-polling while connected is not reported as "polling".
        assert statuses == ["connected"]
        # Streaming resumes: polling stops.
        source.emit(quote("AAPL", 201.0))
        frame = ws.receive_json()
        while not (frame["type"] == "tick" and "source" not in frame):
            assert frame["type"] == "tick", frame
            frame = ws.receive_json()
        assert frame["price"] == 201.0
        calls = poller.calls
        time.sleep(0.1)
        assert poller.calls == calls


def test_poll_batches_due_symbols() -> None:
    async def scenario() -> None:
        poller = FakePoller()
        hub = LiveHub(FakeSource(), poller, poll_after_s=0.01, poll_interval_s=10)
        client = hub.register()
        symbols = [f"S{i}" for i in range(120)]
        await hub.subscribe(client, symbols)
        for _ in range(200):
            if poller.calls >= 3:
                break
            await asyncio.sleep(0.005)
        await asyncio.sleep(0.05)
        assert [len(b) for b in poller.batches] == [50, 50, 20]
        assert sorted(s for b in poller.batches for s in b) == sorted(symbols)
        frames = []
        while not client.queue.empty():
            frames.append(client.queue.get_nowait())
        assert sum(1 for f in frames if f.get("source") == "poll") == 120
        assert [f["upstream"] for f in frames if f["type"] == "status"] == ["connected"]
        await hub.close()

    asyncio.run(scenario())


def test_closed_market_and_unchanged_symbols_slow_down() -> None:
    async def scenario() -> None:
        poller = FakePoller(constant=frozenset({"FLAT"}))
        hub = LiveHub(
            FakeSource(),
            poller,
            poll_after_s=0.01,
            poll_interval_s=0.02,
            poll_closed_interval_s=10,
            poll_unchanged_cycles=3,
        )
        client = hub.register()
        await hub.subscribe(client, ["AAPL", "FLAT", "MOVING"])
        # Last streamed tick for AAPL was in post-market (market_hours=2).
        await hub._on_message({**quote("AAPL", 200.0), "market_hours": 2})
        await asyncio.sleep(0.3)
        assert poller.count("AAPL") == 1  # closed: first poll, then the 10s cadence
        assert poller.count("FLAT") == 4  # slowed after 3 unchanged polls
        assert poller.count("MOVING") >= 6  # live but silent: fast cadence
        assert hub.status == "connected"
        await hub.close()

    asyncio.run(scenario())


def test_reconnect_resubscribes_active_symbols() -> None:
    class FlakySource(FakeSource):
        def __init__(self) -> None:
            super().__init__()
            self.listens = 0

        async def listen(self, handler: MessageHandler) -> None:
            self.listens += 1
            if self.listens == 1:
                raise ConnectionError("dropped")
            await super().listen(handler)

    async def scenario() -> None:
        source = FlakySource()
        hub = LiveHub(
            source, FakePoller(), poll_after_s=60, poll_interval_s=60, backoff_initial_s=0.01
        )
        client = hub.register()
        await hub.subscribe(client, ["AAPL"])
        for _ in range(200):
            if source.listens >= 2 and hub.status == "connected":
                break
            await asyncio.sleep(0.005)
        assert source.subscribed == ["AAPL", "AAPL"]
        assert hub.status == "connected"
        frames = []
        while not client.queue.empty():
            frames.append(client.queue.get_nowait())
        statuses = [f["upstream"] for f in frames if f["type"] == "status"]
        # While the upstream was down the symbol was polled immediately.
        assert statuses == ["connected", "reconnecting", "polling", "connected"]
        assert any(f.get("source") == "poll" for f in frames)
        await hub.close()

    asyncio.run(scenario())


def test_slow_client_queue_drops_oldest() -> None:
    async def scenario() -> None:
        hub = LiveHub(FakeSource(), FakePoller(), queue_size=2)
        client = hub.register()
        for i in range(5):
            client.send({"type": "tick", "n": i})
        assert [client.queue.get_nowait()["n"] for _ in range(2)] == [3, 4]
        assert client.dropped == 3

    asyncio.run(scenario())
