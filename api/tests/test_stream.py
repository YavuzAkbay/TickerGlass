"""The reconnecting WebSocket client (`providers/stream.py`) over a fake connection factory:
delivery, auth/subscribe hook on every (re)connect, backoff, fatal errors, idempotent close.
One test runs the default factory against a loopback `websockets` server. No external
network."""

import asyncio
import json
import logging
from collections.abc import Awaitable, Callable
from typing import Any

import pytest
from ws_fake import FakeConn, FakeNet, until

from tickerglass_api.providers.stream import (
    Backoff,
    NotConnected,
    StreamClient,
    StreamFatal,
    StreamUnavailable,
    websockets_connect,
)

URL = "wss://stream.example.com/v2/test?token=never-logged"
FAST = Backoff(initial_s=0.001, max_s=0.002, jitter=0)


def client_for(
    net: FakeNet,
    on_message: Callable[[Any], Awaitable[None]],
    on_open: Callable[[StreamClient], Awaitable[None]] | None = None,
    **kwargs: Any,
) -> StreamClient:
    return StreamClient(
        URL,
        on_message=on_message,
        on_open=on_open,
        connect=net,
        backoff=kwargs.pop("backoff", FAST),
        **kwargs,
    )


def test_delivers_decoded_messages_after_on_open_and_close_ends_run() -> None:
    async def scenario() -> None:
        got: list[Any] = []

        async def on_message(msg: Any) -> None:
            got.append(msg)

        async def on_open(client: StreamClient) -> None:
            await client.send({"action": "auth", "key": "k"})
            await client.send("raw text")

        conn = FakeConn()
        conn.feed([{"T": "success"}], b'{"a": 1}')
        net = FakeNet(conn)
        client = client_for(net, on_message, on_open, headers={"X-Key": "secret"})
        run = asyncio.create_task(client.run())
        await until(lambda: len(got) == 2)
        assert got == [[{"T": "success"}], {"a": 1}]
        assert conn.sent == ['{"action":"auth","key":"k"}', "raw text"]
        assert net.calls == [(URL, {"X-Key": "secret"})]
        assert client.connected and not client.closed
        await client.close()
        await asyncio.wait_for(run, 1)
        assert conn.closed and not client.connected and client.closed

    asyncio.run(scenario())


def test_reconnects_after_a_lost_connection_and_runs_on_open_again() -> None:
    async def scenario() -> None:
        opened: list[int] = []
        got: list[Any] = []

        async def on_open(client: StreamClient) -> None:
            opened.append(client.connections)
            await client.send({"action": "subscribe", "trades": ["AAPL"]})

        async def on_message(msg: Any) -> None:
            got.append(msg)

        first, second = FakeConn(), FakeConn()
        first.feed({"n": 1})
        net = FakeNet(first, second)
        client = client_for(net, on_message, on_open)
        run = asyncio.create_task(client.run())
        await until(lambda: got == [{"n": 1}])
        first.drop()
        await until(lambda: len(net.conns) == 2)
        second.feed({"n": 2})
        await until(lambda: got == [{"n": 1}, {"n": 2}])
        assert opened == [1, 2]
        # The subscription went out again on the new connection.
        assert second.sent == ['{"action":"subscribe","trades":["AAPL"]}']
        assert first.closed
        await client.close()
        await asyncio.wait_for(run, 1)

    asyncio.run(scenario())


def test_failed_connects_and_a_failing_on_open_are_retried() -> None:
    async def scenario() -> None:
        attempts: list[int] = []

        async def on_open(client: StreamClient) -> None:
            attempts.append(client.connections)
            if len(attempts) == 1:
                raise ConnectionResetError("send failed")

        async def on_message(msg: Any) -> None:
            pass

        good = FakeConn()
        net = FakeNet(OSError("refused"), TimeoutError(), FakeConn(), good)
        client = client_for(net, on_message, on_open)
        run = asyncio.create_task(client.run())
        await until(lambda: len(attempts) == 2)
        assert (
            len(net.calls) == 4
        )  # two failed connects, the connection whose on_open failed, one more
        assert client.connections == 2
        await client.close()
        await asyncio.wait_for(run, 1)

    asyncio.run(scenario())


def test_stream_fatal_from_the_handler_stops_run_and_closes_the_socket() -> None:
    async def scenario() -> None:
        async def on_message(msg: Any) -> None:
            raise StreamFatal("credentials rejected")

        conn = FakeConn()
        conn.feed({"T": "error"})
        net = FakeNet(conn)
        client = client_for(net, on_message)
        with pytest.raises(StreamFatal, match="credentials rejected"):
            await asyncio.wait_for(client.run(), 2)
        assert conn.closed and client.closed and len(net.conns) == 1  # no reconnect

    asyncio.run(scenario())


def test_stream_fatal_from_on_open_stops_run() -> None:
    async def scenario() -> None:
        async def on_open(client: StreamClient) -> None:
            raise StreamFatal("no")

        async def on_message(msg: Any) -> None:
            pass

        client = client_for(FakeNet(), on_message, on_open)
        with pytest.raises(StreamFatal):
            await asyncio.wait_for(client.run(), 2)

    asyncio.run(scenario())


def test_handler_errors_and_undecodable_frames_do_not_end_the_stream(
    caplog: pytest.LogCaptureFixture,
) -> None:
    async def scenario() -> None:
        got: list[Any] = []

        async def on_message(msg: Any) -> None:
            if msg == {"boom": True}:
                raise RuntimeError("handler bug")
            got.append(msg)

        conn = FakeConn()
        conn.feed({"boom": True}, "not json {", {"ok": 1})
        net = FakeNet(conn)
        client = client_for(net, on_message)
        run = asyncio.create_task(client.run())
        await until(lambda: got == [{"ok": 1}])
        assert len(net.conns) == 1  # no reconnect
        await client.close()
        await asyncio.wait_for(run, 1)

    with caplog.at_level(logging.WARNING, logger="tickerglass_api.providers.stream"):
        asyncio.run(scenario())
    text = caplog.text
    assert "message handler failed" in text and "undecodable frame" in text
    # Only the host is ever logged: never the URL's query, headers or frame content.
    assert "never-logged" not in text and "not json" not in text


def test_a_custom_decoder_receives_raw_frames() -> None:
    async def scenario() -> None:
        got: list[Any] = []

        async def on_message(msg: Any) -> None:
            got.append(msg)

        conn = FakeConn()
        conn.feed("ping")
        client = client_for(FakeNet(conn), on_message, decode=lambda raw: raw)
        run = asyncio.create_task(client.run())
        await until(lambda: got == ["ping"])
        await client.close()
        await asyncio.wait_for(run, 1)

    asyncio.run(scenario())


def test_close_is_idempotent_works_before_run_and_wakes_a_backoff_wait() -> None:
    async def scenario() -> None:
        async def on_message(msg: Any) -> None:
            pass

        # Closed before run: run returns at once and never connects.
        net = FakeNet()
        early = client_for(net, on_message)
        await early.close()
        await early.close()
        await asyncio.wait_for(early.run(), 1)
        assert net.calls == []

        # Closed while waiting out a long backoff.
        slow = Backoff(initial_s=30, max_s=30, jitter=0)
        waiting_net = FakeNet(OSError("refused"))
        waiting = client_for(waiting_net, on_message, backoff=slow)
        run = asyncio.create_task(waiting.run())
        await until(lambda: len(waiting_net.calls) == 1)
        await asyncio.sleep(0.01)
        await waiting.close()
        await waiting.close()
        await asyncio.wait_for(run, 1)

    asyncio.run(scenario())


def test_cancelling_run_closes_the_socket() -> None:
    async def scenario() -> None:
        async def on_message(msg: Any) -> None:
            pass

        conn = FakeConn()
        net = FakeNet(conn)
        client = client_for(net, on_message)
        run = asyncio.create_task(client.run())
        await until(lambda: client.connected)
        run.cancel()
        with pytest.raises(asyncio.CancelledError):
            await run
        assert conn.closed and client.closed

    asyncio.run(scenario())


def test_send_without_a_connection_raises_not_connected() -> None:
    async def scenario() -> None:
        async def on_message(msg: Any) -> None:
            pass

        client = client_for(FakeNet(), on_message)
        with pytest.raises(NotConnected):
            await client.send({"a": 1})

    asyncio.run(scenario())


def test_url_must_be_a_websocket_url() -> None:
    async def on_message(msg: Any) -> None:
        pass

    for bad in ("https://x.example/ws", "stream.example.com", "wss://"):
        with pytest.raises(ValueError):
            StreamClient(bad, on_message=on_message)


def test_plain_ws_is_accepted_only_for_loopback_hosts() -> None:
    async def on_message(msg: Any) -> None:
        pass

    for local in (
        "ws://127.0.0.1:8080/x",
        "ws://localhost/x",
        "ws://[::1]:9/x",
        "wss://a.example/",
    ):
        StreamClient(local, on_message=on_message)
    for remote in ("ws://stream.example.com/v2", "ws://10.0.0.5/x", "ws://localhost.evil.test/"):
        with pytest.raises(ValueError, match="wss://"):
            StreamClient(remote, on_message=on_message)


# -- backoff -----------------------------------------------------------------------------


def test_backoff_doubles_up_to_the_cap_and_resets() -> None:
    backoff = Backoff(initial_s=1, max_s=10, factor=2, jitter=0, rng=lambda: 0.5)
    assert [backoff.next_delay() for _ in range(6)] == [1, 2, 4, 8, 10, 10]
    backoff.reset()
    assert backoff.next_delay() == 1


def test_backoff_jitter_spreads_the_delay_within_bounds() -> None:
    low = Backoff(initial_s=4, max_s=100, jitter=0.25, rng=lambda: 0.0)
    high = Backoff(initial_s=4, max_s=100, jitter=0.25, rng=lambda: 0.999999)
    assert low.next_delay() == pytest.approx(3.0)
    assert high.next_delay() == pytest.approx(5.0, abs=0.001)
    # Never above the maximum, jitter included.
    capped = Backoff(initial_s=10, max_s=10, jitter=0.5, rng=lambda: 0.999)
    assert capped.next_delay() == 10


def test_backoff_rejects_nonsense() -> None:
    for kwargs in (
        {"initial_s": 0},
        {"initial_s": 5, "max_s": 1},
        {"jitter": 1.0},
        {"factor": 0.5},
    ):
        with pytest.raises(ValueError):
            Backoff(**kwargs)


class RecordingBackoff(Backoff):
    def __init__(self) -> None:
        super().__init__(initial_s=0.001, max_s=0.008, factor=2, jitter=0)
        self.events: list[str] = []

    def next_delay(self) -> float:
        delay = super().next_delay()
        self.events.append(f"{delay * 1000:.0f}ms")
        return delay

    def reset(self) -> None:
        super().reset()
        self.events.append("reset")


def test_the_delay_starts_over_after_a_healthy_connection() -> None:
    async def scenario() -> RecordingBackoff:
        got: list[Any] = []

        async def on_message(msg: Any) -> None:
            got.append(msg)

        first = FakeConn()
        first.feed({"n": 1})
        net = FakeNet(OSError("a"), OSError("b"), first, FakeConn())
        backoff = RecordingBackoff()
        client = client_for(net, on_message, backoff=backoff, stable_after_s=0)
        run = asyncio.create_task(client.run())
        await until(lambda: got == [{"n": 1}])
        first.drop()
        await until(lambda: len(net.conns) == 2)
        await client.close()
        await asyncio.wait_for(run, 1)
        return backoff

    events = asyncio.run(scenario()).events
    # Two failed connects back off 1ms, 2ms; the healthy connection resets the delay, so the
    # reconnect after it waits 1ms again.
    assert events[:4] == ["1ms", "2ms", "reset", "1ms"]


class Clock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now


def test_a_connection_that_handles_a_message_but_hangs_up_at_once_keeps_the_backoff() -> None:
    """An error frame then a hang-up, over and over, must not look like a recovery."""

    async def scenario() -> RecordingBackoff:
        got: list[Any] = []

        async def on_message(msg: Any) -> None:
            got.append(msg)

        conns = [FakeConn() for _ in range(3)]
        for conn in conns:
            conn.feed({"T": "error", "code": 400}, ConnectionResetError("hung up"))
        net = FakeNet(*conns)
        backoff = RecordingBackoff()
        client = client_for(net, on_message, backoff=backoff, clock=Clock())
        run = asyncio.create_task(client.run())
        await until(lambda: len(net.conns) == 3 and len(got) == 3)
        await client.close()
        await asyncio.wait_for(run, 1)
        return backoff

    events = asyncio.run(scenario()).events
    assert "reset" not in events and events[:2] == ["1ms", "2ms"]


def test_the_delay_starts_over_only_when_the_connection_also_stayed_up() -> None:
    async def scenario() -> RecordingBackoff:
        got: list[Any] = []

        async def on_message(msg: Any) -> None:
            got.append(msg)

        first, second = FakeConn(), FakeConn()
        first.feed({"n": 1})
        net = FakeNet(OSError("a"), first, second, FakeConn())
        backoff = RecordingBackoff()
        clock = Clock()
        client = client_for(net, on_message, backoff=backoff, clock=clock, stable_after_s=30)
        run = asyncio.create_task(client.run())
        await until(lambda: got == [{"n": 1}])
        clock.now = 31  # the connection has been up for 31 s when it drops
        first.drop()
        await until(lambda: len(net.conns) == 2)
        await client.close()
        await asyncio.wait_for(run, 1)
        return backoff

    assert asyncio.run(scenario()).events[:3] == ["1ms", "reset", "1ms"]


def test_a_message_handler_that_fails_does_not_make_a_connection_healthy() -> None:
    async def scenario() -> RecordingBackoff:
        async def on_message(msg: Any) -> None:
            raise RuntimeError("handler bug")

        first = FakeConn()
        first.feed({"n": 1}, ConnectionResetError("hung up"))
        net = FakeNet(first, FakeConn())
        backoff = RecordingBackoff()
        client = client_for(net, on_message, backoff=backoff, stable_after_s=0)
        run = asyncio.create_task(client.run())
        await until(lambda: len(net.conns) == 2)
        await client.close()
        await asyncio.wait_for(run, 1)
        return backoff

    assert "reset" not in asyncio.run(scenario()).events


# -- giving up ---------------------------------------------------------------------------


def test_run_raises_stream_unavailable_after_max_failed_connects() -> None:
    async def scenario() -> FakeNet:
        async def on_message(msg: Any) -> None:
            pass

        net = FakeNet(*[OSError("refused") for _ in range(5)])
        client = client_for(net, on_message, max_failures=3)
        with pytest.raises(StreamUnavailable, match="3 failed connections"):
            await asyncio.wait_for(client.run(), 2)
        assert client.closed
        return net

    assert len(asyncio.run(scenario()).calls) == 3  # no attempt after giving up


def test_sessions_that_end_unhealthy_count_as_failures_and_a_healthy_one_clears_them() -> None:
    async def scenario() -> None:
        got: list[Any] = []

        async def on_message(msg: Any) -> None:
            got.append(msg)

        clock = Clock()
        flaky = [FakeConn(), FakeConn()]
        for conn in flaky:
            conn.feed({"n": 1}, ConnectionResetError("hung up"))
        healthy = FakeConn()
        healthy.feed({"n": 2})
        net = FakeNet(*flaky, healthy, OSError("x"), FakeConn())
        client = client_for(net, on_message, max_failures=3, clock=clock, stable_after_s=30)
        run = asyncio.create_task(client.run())
        await until(lambda: len(got) == 3)  # two flaky sessions, then the healthy one
        # Two failures so far; staying up 31 s clears them, so the next failures start from 0.
        clock.now = 31
        healthy.drop()
        await until(lambda: len(net.calls) == 5)
        assert not run.done()  # 1 failed connect since the healthy session: not 3
        await client.close()
        await asyncio.wait_for(run, 1)

    asyncio.run(scenario())


def test_without_max_failures_the_client_retries_for_ever() -> None:
    async def scenario() -> None:
        async def on_message(msg: Any) -> None:
            pass

        net = FakeNet(*[OSError("refused") for _ in range(20)])
        client = client_for(net, on_message)
        run = asyncio.create_task(client.run())
        await until(lambda: len(net.calls) >= 20)
        assert not run.done()
        await client.close()
        await asyncio.wait_for(run, 1)

    asyncio.run(scenario())


def test_max_failures_must_be_positive() -> None:
    async def on_message(msg: Any) -> None:
        pass

    with pytest.raises(ValueError):
        StreamClient(URL, on_message=on_message, max_failures=0)


# -- the default factory -----------------------------------------------------------------


def test_the_default_factory_talks_to_a_loopback_websocket_server(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from websockets.asyncio.server import ServerConnection, serve

    for name in (
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
    ):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("NO_PROXY", "127.0.0.1,localhost")
    seen_headers: list[str] = []

    async def handler(ws: ServerConnection) -> None:
        seen_headers.append(str(ws.request.headers.get("X-Test") if ws.request else ""))
        async for frame in ws:
            await ws.send(json.dumps({"echo": json.loads(frame)}))

    async def scenario() -> list[Any]:
        got: list[Any] = []
        async with serve(handler, "127.0.0.1", 0) as server:
            port = server.sockets[0].getsockname()[1]

            async def on_open(client: StreamClient) -> None:
                await client.send({"hello": 1})

            async def on_message(msg: Any) -> None:
                got.append(msg)

            client = StreamClient(
                f"ws://127.0.0.1:{port}/",
                on_message=on_message,
                on_open=on_open,
                headers={"X-Test": "yes"},
                connect=websockets_connect,
            )
            run = asyncio.create_task(client.run())
            await until(lambda: bool(got), 5)
            await client.close()
            await asyncio.wait_for(run, 5)
        return got

    assert asyncio.run(scenario()) == [{"echo": {"hello": 1}}]
    assert seen_headers == ["yes"]


def test_the_default_factory_refuses_redirects_instead_of_following_them(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The auth / token frames would otherwise go to wherever the server points (websockets
    follows up to ten redirects, across origins)."""
    from http import HTTPStatus

    from websockets.asyncio.server import Request, ServerConnection, serve
    from websockets.exceptions import InvalidStatus
    from websockets.http11 import Response

    for name in (
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
    ):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("NO_PROXY", "127.0.0.1,localhost")
    reached: list[str] = []

    async def target(ws: ServerConnection) -> None:
        reached.append("target")

    async def scenario() -> None:
        async with serve(target, "127.0.0.1", 0) as other:
            other_port = other.sockets[0].getsockname()[1]

            def redirect(conn: ServerConnection, request: Request) -> Response | None:
                response = conn.respond(HTTPStatus.FOUND, "moved\n")
                response.headers["Location"] = f"ws://127.0.0.1:{other_port}/"
                return response

            async def unreachable(ws: ServerConnection) -> None:
                reached.append("redirector")

            async with serve(unreachable, "127.0.0.1", 0, process_request=redirect) as origin:
                port = origin.sockets[0].getsockname()[1]
                with pytest.raises(InvalidStatus) as refused:
                    await websockets_connect(f"ws://127.0.0.1:{port}/", {"X-Test": "yes"})
                assert refused.value.response.status_code == 302
                # The redirect target was never contacted: connect gave up before following.
                assert other.connections == set() and reached == []

    asyncio.run(scenario())
