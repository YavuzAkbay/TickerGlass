"""The crypto live source over a fake WebSocket network (`ws_fake`), for each exchange's stream:
what is subscribed on connect and reconnect, how ticker frames become hub ticks (frames of the
live captures in tests/fixtures/crypto/), unsubscribing, fatal errors and reuse after `close`. No
network."""

import asyncio
import logging
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import pytest
from crypto_fake import fixture
from ws_fake import FakeConn, FakeNet, until

from tickerglass_api.live import normalize_message
from tickerglass_api.providers import crypto
from tickerglass_api.providers.base import ProviderError
from tickerglass_api.providers.crypto.base import Stream
from tickerglass_api.providers.crypto.binance import BinanceStream
from tickerglass_api.providers.crypto.coinbase import CoinbaseStream
from tickerglass_api.providers.crypto.kraken import KrakenStream
from tickerglass_api.providers.stream import Backoff, StreamFatal

URL = "wss://stream.test/ws"


def source(stream: Stream, net: FakeNet) -> crypto.CryptoLiveSource:
    return crypto.CryptoLiveSource(
        stream,
        url=URL,
        connect=net,
        backoff_factory=lambda: Backoff(initial_s=0.001, max_s=0.002, jitter=0),
    )


class Ticks:
    def __init__(self) -> None:
        self.items: list[dict[str, Any]] = []

    async def __call__(self, tick: dict[str, Any]) -> None:
        self.items.append(tick)


@dataclass
class Case:
    name: str
    stream: Callable[[], Stream]
    #: Canonical symbols and their names on the stream.
    ids: dict[str, str]
    subscribe: Callable[[list[str]], dict[str, Any]]
    unsubscribe: Callable[[list[str]], dict[str, Any]]
    #: A ticker frame for a stream symbol and a price.
    tick: Callable[[str, float], Any]


def _kraken_tick(sid: str, price: float) -> Any:
    return {
        "channel": "ticker",
        "type": "update",
        "data": [
            {
                "symbol": sid,
                "last": price,
                "volume": 12.5,
                "high": price + 1,
                "low": price - 1,
                "change": 2.0,
                "change_pct": 0.5,
                "timestamp": "2026-11-17T18:24:12.500000Z",
            }
        ],
    }


def _coinbase_tick(sid: str, price: float) -> Any:
    return {
        "channel": "ticker",
        "timestamp": "2026-11-17T18:25:02.5Z",
        "events": [
            {
                "type": "update",
                "tickers": [
                    {
                        "product_id": sid,
                        "price": str(price),
                        "volume_24_h": "12.5",
                        "low_24_h": str(price - 1),
                        "high_24_h": str(price + 1),
                        "price_percent_chg_24_h": "1.0",
                    }
                ],
            }
        ],
    }


def _binance_tick(sid: str, price: float) -> Any:
    return {
        "e": "24hrMiniTicker",
        "E": 1794939925017,
        "s": sid.upper(),
        "c": str(price),
        "o": str(price - 2),
        "h": str(price + 1),
        "l": str(price - 1),
        "v": "12.5",
    }


CASES = [
    Case(
        "kraken",
        KrakenStream,
        {"BTC-USD": "BTC/USD", "ETH-BTC": "ETH/BTC"},
        lambda ids: {"method": "subscribe", "params": {"channel": "ticker", "symbol": ids}},
        lambda ids: {"method": "unsubscribe", "params": {"channel": "ticker", "symbol": ids}},
        _kraken_tick,
    ),
    Case(
        "coinbase",
        CoinbaseStream,
        {"BTC-USD": "BTC-USD", "ETH-BTC": "ETH-BTC"},
        lambda ids: {"type": "subscribe", "product_ids": ids, "channel": "ticker"},
        lambda ids: {"type": "unsubscribe", "product_ids": ids, "channel": "ticker"},
        _coinbase_tick,
    ),
    Case(
        "binance",
        BinanceStream,
        {"BTC-USD": "btcusd", "ETH-BTC": "ethbtc"},
        lambda ids: {"method": "SUBSCRIBE", "params": [f"{i}@miniTicker" for i in ids]},
        lambda ids: {"method": "UNSUBSCRIBE", "params": [f"{i}@miniTicker" for i in ids]},
        _binance_tick,
    ),
]


@pytest.fixture(params=CASES, ids=[c.name for c in CASES])
def case(request: pytest.FixtureRequest) -> Case:
    return request.param  # type: ignore[no-any-return]


def sent(conn: FakeConn) -> list[Any]:
    """What the client sent, without Binance's request ids."""
    return [{k: v for k, v in frame.items() if k != "id"} for frame in conn.sent_json()]


# -- the stream parsers on the live captures ---------------------------------------------


def test_kraken_ticker_frames_are_ticks_and_the_rest_is_ignored() -> None:
    frames = fixture("kraken_ws")
    stream = KrakenStream()
    for name in ("status", "subscribed", "refused", "heartbeat"):
        assert stream.parse(frames[name]) == []
    expected = {
        "id": "BTC/USD",
        "price": 63789.2,
        "change": -1073.2,
        "change_percent": -1.65,
        "day_volume": 4492.24624645,
        "day_high": 65471.3,
        "day_low": 63272.3,
        "market_hours": 1,
        "time": 1794939851745,  # 2026-11-17T18:24:11.745Z
    }
    assert stream.parse(frames["snapshot"]) == [expected]
    assert stream.parse(frames["update"])[0]["price"] == 63790.2
    assert stream.parse("junk") == [] and stream.parse({"channel": "ticker", "data": 5}) == []
    assert stream.parse({"channel": "ticker", "data": [{"symbol": "X/Y"}, "no"]}) == []


def test_kraken_stream_names_follow_the_v2_spelling() -> None:
    stream = KrakenStream()
    assert stream.symbol("BTC-USD") == "BTC/USD" and stream.symbol("DOGE-USD") == "DOGE/USD"
    many = [f"A{i}/USD" for i in range(250)]
    frames = stream.subscribe(many)
    assert [len(f["params"]["symbol"]) for f in frames] == [100, 100, 50]


def test_coinbase_ticker_frames_are_ticks_with_a_derived_change() -> None:
    frames = fixture("coinbase_ws")
    stream = CoinbaseStream()
    assert stream.parse(frames["subscriptions"]) == []
    (tick,) = stream.parse(frames["snapshot"])
    assert tick["id"] == "BTC-USD" and tick["price"] == 63951.36
    assert tick["change_percent"] == pytest.approx(-1.37816267491896)
    assert tick["change"] == pytest.approx(63951.36 - 63951.36 / (1 - 0.0137816267491896))
    assert (tick["day_volume"], tick["day_high"], tick["day_low"]) == (
        12615.78967941,
        65476.38,
        63256.75,
    )
    assert tick["time"] == 1794939902749 and tick["market_hours"] == 1  # 18:25:02.749Z
    assert stream.parse(frames["update"])[0]["price"] == 63950.28
    assert stream.parse({"channel": "ticker", "events": [{"tickers": [{"product_id": "X"}]}]}) == []
    assert stream.subscribe([]) == [] and stream.unsubscribe([]) == []


def test_coinbase_error_frames_are_logged_not_ticks(caplog: pytest.LogCaptureFixture) -> None:
    with caplog.at_level(logging.WARNING, logger="tickerglass_api.providers.crypto.coinbase"):
        assert CoinbaseStream().parse({"type": "error", "message": "bad subscription"}) == []
    assert "bad subscription" in caplog.text


def test_binance_mini_ticker_frames_are_ticks() -> None:
    frames = fixture("binance_ws")
    stream = BinanceStream()
    assert stream.parse(frames["ack"]) == [] and stream.parse([1, 2]) == []
    (tick,) = stream.parse(frames["mini"])
    assert tick["id"] == "btcusdt" and tick["price"] == 64044.04
    assert tick["change"] == pytest.approx(64044.04 - 64910.51)
    assert tick["change_percent"] == pytest.approx((64044.04 - 64910.51) / 64910.51 * 100)
    assert (tick["day_volume"], tick["day_high"], tick["day_low"]) == (
        28671.67157,
        65534.94,
        63336.0,
    )
    assert tick["time"] == 1794939924017 and tick["market_hours"] == 1
    assert stream.symbol("ETH-BTC") == "ethbtc"


def test_binance_requests_carry_increasing_ids_and_chunk_big_lists() -> None:
    stream = BinanceStream()
    first = stream.subscribe(["btcusdt"])
    second = stream.unsubscribe(["btcusdt"])
    assert (first[0]["id"], second[0]["id"]) == (1, 2)
    assert first[0] == {"method": "SUBSCRIBE", "params": ["btcusdt@miniTicker"], "id": 1}
    chunks = stream.subscribe([f"a{i}usdt" for i in range(150)])
    assert [len(f["params"]) for f in chunks] == [100, 50] and chunks[1]["id"] == 4


def test_a_binance_error_frame_gives_no_tick(caplog: pytest.LogCaptureFixture) -> None:
    with caplog.at_level(logging.WARNING, logger="tickerglass_api.providers.crypto.binance"):
        assert BinanceStream().parse({"code": 2, "msg": "Invalid request"}) == []
    assert "Invalid request" in caplog.text


def test_the_defaults_are_the_documented_public_hosts() -> None:
    assert KrakenStream.url == "wss://ws.kraken.com/v2"
    assert CoinbaseStream.url == "wss://advanced-trade-ws.coinbase.com"
    assert BinanceStream.url == "wss://data-stream.binance.vision/ws"

    async def scenario() -> None:
        net = FakeNet()
        live = crypto.CryptoLiveSource(KrakenStream(), connect=net)
        await live.subscribe(["BTC-USD"])
        task = asyncio.create_task(live.listen(Ticks()))
        await until(lambda: len(net.conns) == 1)
        assert net.urls() == [KrakenStream.url]
        await live.close()
        await asyncio.wait_for(task, 2)

    asyncio.run(scenario())


def test_the_registry_passes_the_configured_stream_url() -> None:
    config = crypto.CryptoConfig(
        exchange="coinbase",
        stream_url="wss://proxy.test/ws",
        _env_file=None,  # type: ignore[call-arg]
    )
    provider = crypto.CryptoProvider(config)
    made = crypto.make_live(provider, config)
    assert isinstance(made, crypto.CryptoLiveSource) and made._url == "wss://proxy.test/ws"
    plain = crypto.CryptoConfig(exchange="binance", _env_file=None)  # type: ignore[call-arg]
    made = crypto.make_live(crypto.CryptoProvider(plain), plain)
    assert isinstance(made, crypto.CryptoLiveSource) and made._url == BinanceStream.url


# -- the source over a fake network ------------------------------------------------------


def test_subscribes_on_connect_and_emits_hub_ticks(case: Case) -> None:
    async def scenario() -> None:
        net = FakeNet()
        live = source(case.stream(), net)
        # An index and a stock are not streamable; the two spellings of BTC share a stream.
        await live.subscribe(["BTC-USD", "ETH-BTC", "^GSPC", "AAPL"])
        ticks = Ticks()
        task = asyncio.create_task(live.listen(ticks))
        await until(lambda: len(net.conns) == 1)
        conn = net.conns[0]
        assert net.urls() == [URL]
        await until(lambda: len(conn.sent) == 1)
        assert sent(conn) == [case.subscribe([case.ids["BTC-USD"], case.ids["ETH-BTC"]])]
        conn.feed(
            case.tick(case.ids["BTC-USD"], 100.5),
            case.tick("ZZZ/USD" if case.name == "kraken" else "zzzusd", 1.0),  # not asked for
            case.tick(case.ids["ETH-BTC"], 0.05),
            {"channel": "heartbeat"},
        )
        await until(lambda: len(ticks.items) == 2)
        assert [(t["id"], t["price"]) for t in ticks.items] == [
            ("BTC-USD", 100.5),
            ("ETH-BTC", 0.05),
        ]
        assert ticks.items[0]["market_hours"] == 1 and ticks.items[0]["time"] > 0
        assert ticks.items[0]["day_volume"] == 12.5
        assert ticks.items[0]["day_high"] == 101.5 and ticks.items[0]["day_low"] == 99.5
        for tick in ticks.items:  # the hub's own normalizer accepts them
            assert normalize_message(tick) is not None
        await live.close()
        await asyncio.wait_for(task, 2)
        assert conn.closed

    asyncio.run(scenario())


def test_two_spellings_of_one_pair_each_get_the_tick() -> None:
    async def scenario() -> None:
        net = FakeNet()
        live = source(KrakenStream(), net)
        await live.subscribe(["XBT-USD", "BTC-USD", "xbt-usd"])
        ticks = Ticks()
        task = asyncio.create_task(live.listen(ticks))
        await until(lambda: len(net.conns) == 1)
        await until(lambda: len(net.conns[0].sent) == 1)
        # One stream symbol, subscribed once.
        assert net.conns[0].sent_json()[0]["params"]["symbol"] == ["BTC/USD"]
        net.conns[0].feed(_kraken_tick("BTC/USD", 7.0))
        await until(lambda: len(ticks.items) == 2)
        assert [t["id"] for t in ticks.items] == ["XBT-USD", "BTC-USD"]
        await live.unsubscribe(["XBT-USD"])
        assert len(net.conns[0].sent) == 1  # BTC-USD still wants the stream
        net.conns[0].feed(_kraken_tick("BTC/USD", 8.0))
        await until(lambda: len(ticks.items) == 3)
        assert ticks.items[2]["id"] == "BTC-USD"
        await live.close()
        await asyncio.wait_for(task, 2)

    asyncio.run(scenario())


def test_the_connection_waits_for_a_wanted_symbol(case: Case) -> None:
    async def scenario() -> None:
        net = FakeNet()
        live = source(case.stream(), net)
        task = asyncio.create_task(live.listen(Ticks()))
        await asyncio.sleep(0.02)
        assert net.conns == []
        await live.subscribe(["AAPL", "^GSPC", "EURUSD=X"])  # nothing streamable
        await asyncio.sleep(0.02)
        assert net.conns == []
        await live.subscribe(["BTC-USD"])
        await until(lambda: len(net.conns) == 1)
        await until(lambda: len(net.conns[0].sent) == 1)
        assert sent(net.conns[0]) == [case.subscribe([case.ids["BTC-USD"]])]
        await live.close()
        await asyncio.wait_for(task, 2)

    asyncio.run(scenario())


def test_subscribing_while_connected_and_unsubscribing_send_frames(case: Case) -> None:
    async def scenario() -> None:
        net = FakeNet()
        live = source(case.stream(), net)
        await live.subscribe(["BTC-USD"])
        ticks = Ticks()
        task = asyncio.create_task(live.listen(ticks))
        await until(lambda: len(net.conns) == 1 and len(net.conns[0].sent) == 1)
        conn = net.conns[0]
        await live.subscribe(["ETH-BTC", "BTC-USD"])  # only the new one is sent
        assert sent(conn)[-1] == case.subscribe([case.ids["ETH-BTC"]]) and len(conn.sent) == 2
        await live.subscribe(["ETH-BTC"])
        assert len(conn.sent) == 2
        await live.unsubscribe(["BTC-USD", "AAPL"])
        assert sent(conn)[-1] == case.unsubscribe([case.ids["BTC-USD"]]) and len(conn.sent) == 3
        conn.feed(case.tick(case.ids["BTC-USD"], 1.0), case.tick(case.ids["ETH-BTC"], 2.0))
        await until(lambda: len(ticks.items) == 1)
        assert ticks.items[0]["id"] == "ETH-BTC"  # the unsubscribed pair is ignored
        await live.close()
        await asyncio.wait_for(task, 2)

    asyncio.run(scenario())


def test_a_lost_connection_is_reestablished_and_resubscribed(case: Case) -> None:
    async def scenario() -> None:
        net = FakeNet()
        live = source(case.stream(), net)
        await live.subscribe(["BTC-USD", "ETH-BTC"])
        ticks = Ticks()
        task = asyncio.create_task(live.listen(ticks))
        await until(lambda: len(net.conns) == 1 and len(net.conns[0].sent) == 1)
        first = net.conns[0]
        first.drop()
        await until(lambda: len(net.conns) == 2 and len(net.conns[1].sent) == 1)
        second = net.conns[1]
        assert sent(second) == sent(first)  # the whole subscription again
        second.feed(case.tick(case.ids["BTC-USD"], 9.0))
        await until(lambda: len(ticks.items) == 1)
        # A symbol added after the reconnect is sent once, on top of it.
        await live.subscribe(["ETH-BTC", "BTC-USD"])
        assert len(second.sent) == 1
        await live.close()
        await asyncio.wait_for(task, 2)

    asyncio.run(scenario())


def test_a_symbol_subscribed_while_down_is_sent_on_the_next_connect(case: Case) -> None:
    async def scenario() -> None:
        net = FakeNet()
        live = source(case.stream(), net)
        await live.subscribe(["BTC-USD"])
        task = asyncio.create_task(live.listen(Ticks()))
        await until(lambda: len(net.conns) == 1 and len(net.conns[0].sent) == 1)
        net.conns[0].drop()
        await live.subscribe(["ETH-BTC"])  # the connection may be gone: no error either way
        await until(lambda: len(net.conns) == 2 and net.conns[1].sent != [])
        last = sent(net.conns[1])[-1]
        assert case.ids["ETH-BTC"] in str(last)
        await live.close()
        await asyncio.wait_for(task, 2)

    asyncio.run(scenario())


def test_close_is_idempotent_and_the_source_is_reusable_like_the_hub_does(case: Case) -> None:
    async def scenario() -> None:
        net = FakeNet()
        live = source(case.stream(), net)
        await live.close()  # before anything
        await live.subscribe(["BTC-USD"])
        task = asyncio.create_task(live.listen(Ticks()))
        await until(lambda: len(net.conns) == 1)
        await live.close()
        await live.close()
        await asyncio.wait_for(task, 2)
        assert net.conns[0].closed
        # The hub subscribes everything again before the next listen.
        await live.subscribe(["ETH-BTC"])
        task = asyncio.create_task(live.listen(Ticks()))
        await until(lambda: len(net.conns) == 2 and len(net.conns[1].sent) == 1)
        assert sent(net.conns[1]) == [case.subscribe([case.ids["ETH-BTC"]])]
        await live.close()
        await asyncio.wait_for(task, 2)

    asyncio.run(scenario())


def test_close_while_waiting_for_a_symbol_ends_listen() -> None:
    async def scenario() -> None:
        live = source(KrakenStream(), FakeNet())
        task = asyncio.create_task(live.listen(Ticks()))
        await asyncio.sleep(0.01)
        await live.close()
        await asyncio.wait_for(task, 2)

    asyncio.run(scenario())


class Rejecting(KrakenStream):
    """A stream whose exchange refuses the connection for good."""

    def parse(self, message: Any) -> list[dict[str, Any]]:
        raise StreamFatal("the exchange refused the connection")


def test_a_fatal_stream_error_ends_listen_with_a_provider_error() -> None:
    async def scenario() -> None:
        net = FakeNet()
        live = source(Rejecting(), net)
        await live.subscribe(["BTC-USD"])
        task = asyncio.create_task(live.listen(Ticks()))
        await until(lambda: len(net.conns) == 1 and len(net.conns[0].sent) == 1)
        net.conns[0].feed({"anything": 1})
        with pytest.raises(ProviderError, match="refused the connection"):
            await asyncio.wait_for(task, 2)
        assert net.conns[0].closed and len(net.conns) == 1  # no reconnect storm
        await live.close()  # the hub's `close` after a failed `listen`

    asyncio.run(scenario())


def test_a_failing_handler_does_not_end_the_stream() -> None:
    async def scenario() -> None:
        net = FakeNet()
        live = source(KrakenStream(), net)
        await live.subscribe(["BTC-USD"])
        seen: list[float] = []

        async def handler(tick: dict[str, Any]) -> None:
            seen.append(tick["price"])
            if len(seen) == 1:
                raise RuntimeError("boom")

        task = asyncio.create_task(live.listen(handler))
        await until(lambda: len(net.conns) == 1 and len(net.conns[0].sent) == 1)
        net.conns[0].feed(_kraken_tick("BTC/USD", 1.0), _kraken_tick("BTC/USD", 2.0))
        await until(lambda: seen == [1.0, 2.0])
        await live.close()
        await asyncio.wait_for(task, 2)

    asyncio.run(scenario())


class GatedConn(FakeConn):
    """A connection whose sends wait for `gate`: the client sits inside `on_open` meanwhile
    (`blocked` is set once the first send waits)."""

    def __init__(self) -> None:
        super().__init__()
        self.gate = asyncio.Event()
        self.blocked = asyncio.Event()

    async def send(self, message: str) -> None:
        self.blocked.set()
        await self.gate.wait()
        await super().send(message)


def test_a_symbol_subscribed_while_on_open_is_sending_is_not_lost(case: Case) -> None:
    async def scenario() -> None:
        conn = GatedConn()
        net = FakeNet(conn)
        live = source(case.stream(), net)
        await live.subscribe(["BTC-USD"])
        task = asyncio.create_task(live.listen(Ticks()))
        await asyncio.wait_for(conn.blocked.wait(), 2)  # `on_open` is sending the first frame
        await live.subscribe(["ETH-BTC"])  # the source is not ready yet: nothing is sent now
        assert conn.sent == []
        conn.gate.set()
        await until(lambda: len(conn.sent) == 2)
        # Both reached the server: the one `on_open` held, then the one that arrived meanwhile.
        assert sent(conn) == [
            case.subscribe([case.ids["BTC-USD"]]),
            case.subscribe([case.ids["ETH-BTC"]]),
        ]
        await live.close()
        await asyncio.wait_for(task, 2)

    asyncio.run(scenario())


def test_a_symbol_dropped_while_on_open_is_sending_is_unsubscribed(case: Case) -> None:
    async def scenario() -> None:
        conn = GatedConn()
        net = FakeNet(conn)
        live = source(case.stream(), net)
        await live.subscribe(["BTC-USD", "ETH-BTC"])
        task = asyncio.create_task(live.listen(Ticks()))
        await asyncio.wait_for(conn.blocked.wait(), 2)
        await live.unsubscribe(["BTC-USD"])
        conn.gate.set()
        await until(lambda: len(conn.sent) == 2)
        assert sent(conn) == [
            case.subscribe([case.ids["BTC-USD"], case.ids["ETH-BTC"]]),
            case.unsubscribe([case.ids["BTC-USD"]]),
        ]
        await live.close()
        await asyncio.wait_for(task, 2)

    asyncio.run(scenario())


def test_unsubscribing_everything_hangs_up_and_a_new_symbol_reconnects(case: Case) -> None:
    async def scenario() -> None:
        net = FakeNet()
        live = source(case.stream(), net)
        await live.subscribe(["BTC-USD", "ETH-BTC"])
        task = asyncio.create_task(live.listen(Ticks()))
        await until(lambda: len(net.conns) == 1 and len(net.conns[0].sent) == 1)
        await live.unsubscribe(["BTC-USD", "ETH-BTC"])
        first = net.conns[0]
        await until(lambda: first.closed and live._client is None)
        assert not task.done()  # still listening, with no connection open
        assert len(net.conns) == 1  # and no reconnect of an empty subscription
        await live.subscribe(["ETH-BTC"])
        await until(lambda: len(net.conns) == 2 and len(net.conns[1].sent) == 1)
        # The new connection subscribes to what is wanted now, not to the old symbols.
        assert sent(net.conns[1]) == [case.subscribe([case.ids["ETH-BTC"]])]
        await live.close()
        await asyncio.wait_for(task, 2)

    asyncio.run(scenario())


def test_an_unreachable_stream_ends_listen_after_max_failures() -> None:
    async def scenario() -> None:
        net = FakeNet(*[OSError("down") for _ in range(10)])
        live = crypto.CryptoLiveSource(
            KrakenStream(),
            url=URL,
            connect=net,
            backoff_factory=lambda: Backoff(initial_s=0.001, max_s=0.002, jitter=0),
            max_failures=3,
        )
        await live.subscribe(["BTC-USD"])
        task = asyncio.create_task(live.listen(Ticks()))
        with pytest.raises(ProviderError, match="3 failed connections"):
            await asyncio.wait_for(task, 2)
        assert len(net.calls) == 3
        await live.close()  # the hub's `close` after a failed `listen`

    asyncio.run(scenario())


def test_ticks_with_a_non_positive_price_are_dropped(case: Case) -> None:
    for sid, price in ((case.ids["BTC-USD"], 0.0), (case.ids["BTC-USD"], -1.0)):
        assert case.stream().parse(case.tick(sid, price)) == []
    assert len(case.stream().parse(case.tick(case.ids["BTC-USD"], 1.0))) == 1


def test_the_hub_shows_an_unreachable_stream_as_down_and_polls() -> None:
    """The stream client retries on its own, so without `max_failures` the hub would stay on
    "connected" for good: `listen` ending is what flips the status."""
    from tickerglass_api.live import LiveHub

    async def poller(symbols: list[str]) -> dict[str, dict[str, Any]]:
        return {s: {"price": 5.0, "change": 0.0, "changePercent": 0.0} for s in symbols}

    async def scenario() -> list[str]:
        net = FakeNet(*[OSError("down") for _ in range(50)])
        live = crypto.CryptoLiveSource(
            KrakenStream(),
            url=URL,
            connect=net,
            backoff_factory=lambda: Backoff(initial_s=0.001, max_s=0.002, jitter=0),
            max_failures=2,
        )
        hub = LiveHub(live, poller, poll_after_s=60, poll_interval_s=60, backoff_initial_s=0.01)
        client = hub.register()
        await hub.subscribe(client, ["BTC-USD"])
        await until(lambda: hub.status == "polling")
        statuses = []
        while not client.queue.empty():
            frame = client.queue.get_nowait()
            if frame["type"] == "status":
                statuses.append(frame["upstream"])
        await hub.close()
        return statuses

    statuses = asyncio.run(scenario())
    # The hub retries the stream after its own backoff, so the status may flip back meanwhile.
    assert "connected" in statuses and "polling" in statuses
