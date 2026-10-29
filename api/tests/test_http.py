import http.server
import json
import threading
from collections.abc import Iterator, Mapping
from typing import Any
from urllib.error import URLError

import pytest

from tickerglass_api.providers.base import (
    ProviderError,
    RateLimited,
    UpstreamUnavailable,
)
from tickerglass_api.providers.http import HttpRateLimited, HttpStatusError, JsonHttp, Send

Reply = tuple[int, Mapping[str, str], bytes]


class FakeSend:
    def __init__(self, *replies: Reply | Exception) -> None:
        self.replies = list(replies)
        self.calls: list[tuple[str, Mapping[str, str], float]] = []

    def __call__(self, url: str, headers: Mapping[str, str], timeout: float) -> Reply:
        self.calls.append((url, headers, timeout))
        reply = self.replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        return reply


def ok(body: Any, headers: Mapping[str, str] | None = None) -> Reply:
    return 200, headers or {}, json.dumps(body).encode()


def client(send: Send, **kw: Any) -> JsonHttp:
    return JsonHttp("https://api.example.test/", send=send, **kw)


def test_get_builds_the_url_and_sends_default_and_custom_headers() -> None:
    send = FakeSend(ok({"a": 1}))
    http = client(send, headers={"Authorization": "apikey SECRET"}, timeout_s=7)
    assert http.get("/time_series", {"symbol": "BRK.B", "interval": "1day"}) == {"a": 1}
    url, headers, timeout = send.calls[0]
    assert url == "https://api.example.test/time_series?symbol=BRK.B&interval=1day"
    assert headers["Authorization"] == "apikey SECRET"
    assert headers["Accept"] == "application/json"
    assert headers["User-Agent"].startswith("TickerGlass/")
    assert timeout == 7
    assert "SECRET" not in url


def test_no_params_means_no_query_and_path_slashes_are_normalised() -> None:
    send = FakeSend(ok([]))
    client(send).get("api_usage", {})
    assert send.calls[0][0] == "https://api.example.test/api_usage"


def test_on_headers_sees_lowercased_headers_of_every_response() -> None:
    seen: list[Mapping[str, str]] = []
    send = FakeSend(
        ok({}, {"API-Credits-Used": "3", "API-Credits-Left": "5"}),
        (500, {"X-Y": "1"}, b""),
    )
    http = client(send, on_headers=seen.append)
    http.get("/a", {})
    with pytest.raises(UpstreamUnavailable):
        http.get("/b", {})
    assert seen[0]["api-credits-used"] == "3" and seen[0]["api-credits-left"] == "5"
    assert seen[1] == {"x-y": "1"}


def test_a_failing_on_headers_callback_does_not_break_the_call() -> None:
    def boom(_: Mapping[str, str]) -> None:
        raise RuntimeError("bug")

    assert client(FakeSend(ok({"a": 1})), on_headers=boom).get("/a", {}) == {"a": 1}


@pytest.mark.parametrize("exc", [URLError("dns"), TimeoutError("slow"), ConnectionResetError()])
def test_connection_failures_are_unavailable(exc: Exception) -> None:
    with pytest.raises(UpstreamUnavailable) as err:
        client(FakeSend(exc)).get("/a", {"apikey": "SECRET"})
    assert "SECRET" not in str(err.value)


@pytest.mark.parametrize("status", [500, 502, 503])
def test_5xx_is_unavailable(status: int) -> None:
    with pytest.raises(UpstreamUnavailable, match=str(status)):
        client(FakeSend((status, {}, b"<html>"))).get("/a", {})


def test_429_is_rate_limited_with_retry_after() -> None:
    body = json.dumps({"code": 429, "message": "run out of credits for the day"}).encode()
    for headers, expect in (({"Retry-After": "17"}, 17), ({"retry-after": "2.2"}, 3), ({}, 60)):
        with pytest.raises(RateLimited) as err:
            client(FakeSend((429, headers, body))).get("/a", {})
        assert err.value.retry_after == expect
        assert isinstance(err.value, HttpRateLimited)
        assert err.value.body == {"code": 429, "message": "run out of credits for the day"}


def test_429_with_unusable_retry_after_or_body() -> None:
    with pytest.raises(HttpRateLimited) as err:
        client(FakeSend((429, {"retry-after": "soon"}, b"not json"))).get("/a", {})
    assert err.value.retry_after == 60 and err.value.body is None


def test_client_errors_carry_status_and_decoded_body() -> None:
    payload = {"code": 404, "message": "symbol not found", "status": "error"}
    with pytest.raises(HttpStatusError) as err:
        client(FakeSend((404, {}, json.dumps(payload).encode()))).get("/a", {})
    assert err.value.status == 404 and err.value.body == payload
    with pytest.raises(HttpStatusError) as err:
        client(FakeSend((401, {}, b"<html>nope</html>"))).get("/a", {})
    assert err.value.status == 401 and err.value.body is None
    with pytest.raises(HttpStatusError):  # redirects are not followed
        client(FakeSend((302, {"location": "https://elsewhere.test/"}, b""))).get("/a", {})


@pytest.mark.parametrize("body", [b"", b"<html>", b"{truncated", b"\xff\xfe"])
def test_bad_json_is_a_provider_error(body: bytes) -> None:
    with pytest.raises(ProviderError) as err:
        client(FakeSend((200, {}, body))).get("/a", {})
    assert type(err.value) is ProviderError


def test_base_url_must_be_http() -> None:
    with pytest.raises(ValueError, match="http"):
        JsonHttp("file:///etc/passwd")


def test_errors_never_carry_the_query_string(caplog: pytest.LogCaptureFixture) -> None:
    send = FakeSend((500, {}, b""), URLError("boom"))
    http = client(send)
    with caplog.at_level("DEBUG"):
        for _ in range(2):
            with pytest.raises(UpstreamUnavailable) as err:
                http.get("/quote", {"symbol": "AAPL", "apikey": "SECRET"})
            assert "SECRET" not in str(err.value) and "AAPL" not in str(err.value)
    assert "SECRET" not in caplog.text


# -- the default urllib transport, against a local server ------------------------------


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        if self.path.startswith("/redirect"):
            self.send_response(302)
            self.send_header("Location", "/ok")
            self.end_headers()
            return
        status = 429 if self.path.startswith("/limited") else 200
        body = json.dumps({"path": self.path, "auth": self.headers.get("Authorization")}).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Retry-After", "5")
        self.send_header("X-Test", "yes")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args: object) -> None:
        pass


@pytest.fixture
def server() -> Iterator[str]:
    httpd = http.server.HTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{httpd.server_port}"
    httpd.shutdown()
    httpd.server_close()


def test_default_transport_round_trip(server: str) -> None:
    seen: list[Mapping[str, str]] = []
    http = JsonHttp(server, headers={"Authorization": "apikey K"}, on_headers=seen.append)
    assert http.get("/x", {"q": "1"}) == {"path": "/x?q=1", "auth": "apikey K"}
    assert seen[0]["x-test"] == "yes"
    with pytest.raises(HttpRateLimited) as err:
        http.get("/limited", {})
    assert err.value.retry_after == 5 and err.value.body["path"] == "/limited"
    with pytest.raises(HttpStatusError) as redirect:  # not followed, so no credential leak
        http.get("/redirect", {})
    assert redirect.value.status == 302


def test_default_transport_connection_refused() -> None:
    with pytest.raises(UpstreamUnavailable):
        JsonHttp("http://127.0.0.1:9", timeout_s=2).get("/x", {})
