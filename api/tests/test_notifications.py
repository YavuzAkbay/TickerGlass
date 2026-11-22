"""Alert delivery: transports (stdlib urllib/smtplib, faked), the outbox dispatcher's
retry schedule and restart behavior, and the channel test endpoint (docs/alerts.md §4)."""

import asyncio
import base64
import hashlib
import hmac
import http.client
import http.server
import io
import json
import logging
import smtplib
import socket
import threading
import time
import urllib.error
import urllib.request
from collections.abc import Callable, Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi.testclient import TestClient
from multiuser import owner_id, system_maker
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker
from test_alerts import body, create, fire

from tickerglass_api import models as m
from tickerglass_api.db import make_engine, run_migrations
from tickerglass_api.notifications import DeliveryError, mask_url, ntfy, webhook
from tickerglass_api.notifications.dispatcher import MAX_ATTEMPTS, Dispatcher
from tickerglass_api.settings import Settings
from tickerglass_api.userdata.alerts import utc

T0 = datetime(2026, 10, 15, 14, 30, tzinfo=UTC)


# ------------------------------------------------------------------- fakes


class FakeResponse:
    def read(self) -> bytes:
        return b"ok"

    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, *exc: object) -> None:
        return None


def http_error(
    code: int, body: dict[str, Any] | None = None, headers: dict[str, str] | None = None
) -> urllib.error.HTTPError:
    data = json.dumps(body or {}).encode()
    return urllib.error.HTTPError("http://x", code, "err", headers or {}, io.BytesIO(data))  # type: ignore[arg-type]


class FakeNet:
    """Replaces `urllib.request.urlopen`; `script` entries are raised or ignored in order."""

    def __init__(self) -> None:
        self.requests: list[urllib.request.Request] = []
        self.timeouts: list[float | None] = []
        self.script: list[Exception | None] = []

    def __call__(self, req: urllib.request.Request, timeout: float | None = None) -> FakeResponse:
        self.requests.append(req)
        self.timeouts.append(timeout)
        outcome = self.script.pop(0) if self.script else None
        if outcome is not None:
            raise outcome
        return FakeResponse()

    @property
    def last(self) -> urllib.request.Request:
        return self.requests[-1]

    def body(self) -> Any:
        data = self.last.data
        assert isinstance(data, bytes)
        return json.loads(data)


class FakeSMTP:
    instances: list["FakeSMTP"] = []
    error: Exception | None = None

    def __init__(self, host: str, port: int, timeout: float | None = None, **kw: Any) -> None:
        self.host, self.port, self.timeout, self.kw = host, port, timeout, kw
        self.calls: list[str] = []
        self.sent: list[Any] = []
        FakeSMTP.instances.append(self)

    def __enter__(self) -> "FakeSMTP":
        return self

    def __exit__(self, *exc: object) -> None:
        return None

    def starttls(self, **kw: Any) -> None:
        self.calls.append("starttls")

    def login(self, user: str, password: str) -> None:
        self.calls.append(f"login:{user}:{password}")

    def send_message(self, msg: Any) -> None:
        if FakeSMTP.error is not None:
            raise FakeSMTP.error
        self.calls.append("send")
        self.sent.append(msg)


@pytest.fixture
def net(monkeypatch: pytest.MonkeyPatch) -> FakeNet:
    fake = FakeNet()
    monkeypatch.setattr(urllib.request, "urlopen", fake)  # telegram
    monkeypatch.setattr(webhook, "_build_opener", lambda allow_private: SimpleNamespace(open=fake))
    return fake


@pytest.fixture
def smtp(monkeypatch: pytest.MonkeyPatch) -> type[FakeSMTP]:
    FakeSMTP.instances, FakeSMTP.error = [], None
    monkeypatch.setattr(smtplib, "SMTP", FakeSMTP)
    monkeypatch.setattr(smtplib, "SMTP_SSL", FakeSMTP)
    return FakeSMTP


@pytest.fixture
def maker(tmp_path: Path) -> Iterator[sessionmaker[Session]]:
    """A migrated database without an app, so no background dispatcher competes."""
    url = f"sqlite:///{tmp_path}/n.db"
    run_migrations(url)
    engine = make_engine(url)
    yield system_maker(engine)
    engine.dispose()


def settings(**kw: Any) -> Settings:
    return Settings(_env_file=None, **kw)  # type: ignore[call-arg]


def seed(
    maker: sessionmaker[Session],
    channels: list[tuple[str, str | None]],
    message: str = "AAPL Crossing 190.00",
    raw: bool = False,
    alert: bool = True,
) -> int:
    """One log entry with a pending delivery per channel, all due at T0. Returns the log id."""
    with maker() as session:
        if alert:
            session.add(
                m.Alert(
                    owner_id=owner_id(session.get_bind()),  # type: ignore[arg-type]
                    id="a1",
                    name="Mine",
                    symbol="AAPL",
                    interval="1D",
                    prepost=False,
                    spec={},
                    schema_version=1,
                    message="",
                    notify={"webhookRaw": raw},
                    status="active",
                    revision=1,
                    fire_count=0,
                    created_at=T0,
                    updated_at=T0,
                )
            )
        log = m.AlertLog(
            owner_id=owner_id(session.get_bind()),  # type: ignore[arg-type]
            fire_id="fid",
            alert_id="a1" if alert else None,
            alert_name="Mine",
            symbol="AAPL",
            interval="1D",
            kind="fired",
            fired_at=T0,
            bar_time=1_791_000_000,
            message=message,
            values={"x": 1.5},
            delayed=False,
            final=False,
            read=False,
        )
        session.add(log)
        session.flush()
        for channel, target in channels:
            session.add(
                m.AlertDelivery(
                    log_id=log.id,
                    channel=channel,
                    target=target,
                    status="pending",
                    attempts=0,
                    next_attempt_at=T0,
                )
            )
        session.commit()
        return log.id


def deliveries(maker: sessionmaker[Session]) -> list[m.AlertDelivery]:
    with maker() as session:
        return list(session.scalars(select(m.AlertDelivery).order_by(m.AlertDelivery.id)))


def run(d: Dispatcher, now: datetime) -> int:
    return asyncio.run(d.process_due(now))


# ----------------------------------------------------------------- webhook


def test_webhook_envelope_and_signature(maker: sessionmaker[Session], net: FakeNet) -> None:
    seed(maker, [("webhook", None)])
    d = Dispatcher(
        maker, settings(alerts_webhook_url="https://hook.example/x", alerts_webhook_secret="k")
    )
    assert run(d, T0) == 1
    [row] = deliveries(maker)
    assert row.status == "sent" and row.attempts == 1 and row.last_error is None

    req = net.last
    assert req.full_url == "https://hook.example/x" and req.get_method() == "POST"
    assert net.timeouts == [10.0]
    assert req.get_header("Content-type") == "application/json"
    assert net.body() == {
        "alert": {"id": "a1", "name": "Mine", "symbol": "AAPL", "interval": "1D"},
        "message": "AAPL Crossing 190.00",
        "firedAt": "2026-10-15T14:30:00Z",
        "barTime": 1_791_000_000,
        "values": {"x": 1.5},
        "delayed": False,
    }
    assert isinstance(req.data, bytes)
    want = hmac.new(b"k", req.data, hashlib.sha256).hexdigest()
    assert req.get_header("X-tickerglass-signature") == f"sha256={want}"
    assert run(d, T0 + timedelta(hours=1)) == 0  # sent rows are never retried


def test_webhook_per_alert_target_overrides_default_and_no_secret(
    maker: sessionmaker[Session], net: FakeNet
) -> None:
    seed(maker, [("webhook", "https://mine.example/h")])
    run(Dispatcher(maker, settings(alerts_webhook_url="https://default.example/")), T0)
    assert net.last.full_url == "https://mine.example/h"
    assert net.last.get_header("X-tickerglass-signature") is None


@pytest.mark.parametrize(
    ("message", "content_type"),
    [('{"a": 1}', "application/json"), ("buy AAPL now", "text/plain; charset=utf-8")],
)
def test_webhook_raw_body(
    maker: sessionmaker[Session], net: FakeNet, message: str, content_type: str
) -> None:
    seed(maker, [("webhook", None)], message=message, raw=True)
    run(Dispatcher(maker, settings(alerts_webhook_url="https://hook.example/")), T0)
    assert net.last.data == message.encode()
    assert net.last.get_header("Content-type") == content_type


# ---------------------------------------------------------------- telegram


def test_telegram_message(maker: sessionmaker[Session], net: FakeNet) -> None:
    seed(maker, [("telegram", None)], message="x" * 5000)
    d = Dispatcher(maker, settings(telegram_bot_token="123:tok", telegram_chat_id="-42"))
    run(d, T0)
    assert net.last.full_url == "https://api.telegram.org/bot123:tok/sendMessage"
    body = net.body()
    assert body["chat_id"] == "-42" and body["disable_web_page_preview"] is True
    assert body["text"] == "x" * 4096 and "parse_mode" not in body
    assert deliveries(maker)[0].status == "sent"


def test_telegram_429_honors_retry_after(maker: sessionmaker[Session], net: FakeNet) -> None:
    seed(maker, [("telegram", None)])
    net.script = [http_error(429, {"ok": False, "parameters": {"retry_after": 120}})]
    d = Dispatcher(maker, settings(telegram_bot_token="t", telegram_chat_id="1"))
    run(d, T0)
    [row] = deliveries(maker)
    assert row.status == "pending" and row.attempts == 1
    assert row.last_error == "Telegram HTTP 429"
    assert utc(row.next_attempt_at) == T0 + timedelta(seconds=120)  # not the usual +10 s
    assert "t" not in (row.last_error or "").replace("Telegram", "").replace("HTTP", "")


def test_telegram_4xx_fails_at_once_without_leaking_the_token(
    maker: sessionmaker[Session], net: FakeNet
) -> None:
    seed(maker, [("telegram", None)])
    net.script = [http_error(400, {"description": "chat not found"})]
    run(Dispatcher(maker, settings(telegram_bot_token="SECRETTOKEN", telegram_chat_id="1")), T0)
    [row] = deliveries(maker)
    assert row.status == "failed" and row.attempts == 1
    assert row.last_error == "Telegram HTTP 400: chat not found"
    assert "SECRETTOKEN" not in (row.last_error or "")


# ------------------------------------------------------------------- email


def test_email_starttls(maker: sessionmaker[Session], smtp: type[FakeSMTP]) -> None:
    seed(maker, [("email", None)])
    s = settings(
        smtp_host="mail.example",
        smtp_from="alerts@example.com",
        smtp_to="me@example.com, you@example.org",
        smtp_user="u",
        smtp_password="p",
    )
    run(Dispatcher(maker, s), T0)
    [conn] = smtp.instances
    assert (conn.host, conn.port, conn.timeout) == ("mail.example", 587, 10.0)
    assert conn.calls == ["starttls", "login:u:p", "send"]
    [msg] = conn.sent
    assert msg["Subject"] == "TickerGlass alert: Mine"
    assert msg["From"] == "alerts@example.com" and msg["To"] == "me@example.com, you@example.org"
    text = msg.get_content()
    assert text.startswith("AAPL Crossing 190.00\n")
    for part in ("Symbol: AAPL", "Interval: 1D", "Bar time: ", "Fired at: 2026-10-15T14:30:00Z"):
        assert part in text
    assert deliveries(maker)[0].status == "sent"


@pytest.mark.parametrize("mode", ["ssl", "none"])
def test_email_tls_modes(maker: sessionmaker[Session], smtp: type[FakeSMTP], mode: str) -> None:
    seed(maker, [("email", None)])
    s = settings(smtp_host="h", smtp_from="a@b.c", smtp_to="d@e.f", smtp_tls=mode, smtp_port=465)
    run(Dispatcher(maker, s), T0)
    [conn] = smtp.instances
    assert conn.calls == ["send"] and conn.port == 465  # no starttls, no login
    assert ("context" in conn.kw) == (mode == "ssl")


def test_email_failures(maker: sessionmaker[Session], smtp: type[FakeSMTP]) -> None:
    seed(maker, [("email", None)])
    s = settings(smtp_host="h", smtp_from="a@b.c", smtp_to="d@e.f")
    d = Dispatcher(maker, s)
    smtp.error = smtplib.SMTPResponseException(451, b"try later")
    run(d, T0)
    [row] = deliveries(maker)
    assert row.status == "pending" and row.last_error == "SMTP 451: try later"
    smtp.error = smtplib.SMTPResponseException(550, b"mailbox unavailable")
    run(d, T0 + timedelta(seconds=10))
    [row] = deliveries(maker)
    assert row.status == "failed" and row.attempts == 2


# --------------------------------------------------------------- schedule


def test_retry_schedule_then_failed(maker: sessionmaker[Session], net: FakeNet) -> None:
    seed(maker, [("webhook", None)])
    net.script = [http_error(503)] * 10
    d = Dispatcher(maker, settings(alerts_webhook_url="https://hook.example/"))
    now = T0
    for attempt, delay in enumerate([10, 60, 300, 1800], start=1):
        assert run(d, now) == 1
        [row] = deliveries(maker)
        assert row.status == "pending" and row.attempts == attempt
        assert row.last_error == "HTTP 503"
        assert utc(row.next_attempt_at) == now + timedelta(seconds=delay)
        assert run(d, now + timedelta(seconds=delay - 1)) == 0  # not due yet
        now += timedelta(seconds=delay)
    assert run(d, now) == 1
    [row] = deliveries(maker)
    assert row.status == "failed" and row.attempts == MAX_ATTEMPTS == 5
    assert len(net.requests) == 5
    assert run(d, now + timedelta(days=1)) == 0


@pytest.mark.parametrize(
    ("code", "retried"), [(400, False), (404, False), (408, True), (429, True), (500, True)]
)
def test_http_status_classification(
    maker: sessionmaker[Session], net: FakeNet, code: int, retried: bool
) -> None:
    seed(maker, [("webhook", None)])
    net.script = [http_error(code)]
    run(Dispatcher(maker, settings(alerts_webhook_url="https://hook.example/")), T0)
    [row] = deliveries(maker)
    assert row.status == ("pending" if retried else "failed")
    assert row.last_error == f"HTTP {code}"


def test_network_error_is_retried_and_success_clears_error(
    maker: sessionmaker[Session], net: FakeNet
) -> None:
    seed(maker, [("webhook", None)])
    net.script = [urllib.error.URLError("connection refused")]
    d = Dispatcher(maker, settings(alerts_webhook_url="https://hook.example/"))
    run(d, T0)
    [row] = deliveries(maker)
    assert row.status == "pending" and row.last_error == "delivery failed"
    run(d, T0 + timedelta(seconds=10))
    [row] = deliveries(maker)
    assert row.status == "sent" and row.attempts == 2 and row.last_error is None


def test_unconfigured_delivery_fails_without_retry(
    maker: sessionmaker[Session], net: FakeNet
) -> None:
    seed(maker, [("webhook", None), ("telegram", None), ("email", None)])
    assert run(Dispatcher(maker, settings()), T0) == 3
    rows = deliveries(maker)
    assert [r.status for r in rows] == ["failed"] * 3
    assert {r.last_error for r in rows} == {"not configured"}
    assert net.requests == []


def test_restart_resumes_pending_deliveries(maker: sessionmaker[Session], net: FakeNet) -> None:
    seed(maker, [("webhook", None)])
    net.script = [http_error(500)]
    cfg = settings(alerts_webhook_url="https://hook.example/")
    run(Dispatcher(maker, cfg), T0)
    assert deliveries(maker)[0].status == "pending"
    # "Restart": a brand-new dispatcher on the same database picks the row up when due.
    fresh = Dispatcher(maker, cfg)
    assert run(fresh, T0 + timedelta(seconds=5)) == 0
    assert run(fresh, T0 + timedelta(seconds=10)) == 1
    assert deliveries(maker)[0].status == "sent"


def test_deleted_alert_falls_back_to_the_json_envelope(
    maker: sessionmaker[Session], net: FakeNet
) -> None:
    seed(maker, [("webhook", None)], alert=False)
    run(Dispatcher(maker, settings(alerts_webhook_url="https://hook.example/")), T0)
    assert net.body()["alert"]["id"] is None


# ------------------------------------------------------- live integration


def test_fire_wakes_dispatcher_and_publishes_log_frame(
    make_client: Callable[..., TestClient],
    net: FakeNet,
) -> None:
    client = make_client(alerts_webhook_url="https://hook.example/x")
    a = create(client, id="a1", notify={"webhook": True})
    with client.websocket_connect("/ws") as ws:
        ws.send_json({"op": "events", "topics": ["alerts"]})
        ws.receive_json()
        entry = fire(client, a).json()
        deadline = time.monotonic() + 3
        frame: dict[str, Any] = {}
        while time.monotonic() < deadline:
            frame = ws.receive_json()
            if frame["type"] == "alerts.log":
                break
        assert frame == {"type": "alerts.log", "topic": "alerts", "ids": [entry["id"]]}
    [got] = client.get("/api/alerts/log").json()["entries"]
    assert got["deliveries"] == [
        {"channel": "webhook", "status": "sent", "attempts": 1, "lastError": None}
    ]
    assert net.body()["message"] == "AAPL Crossing 190.00"


# --------------------------------------------------------- channel test


def test_channel_test_endpoint(
    make_client: Callable[..., TestClient],
    net: FakeNet,
    smtp: type[FakeSMTP],
) -> None:
    client = make_client(
        telegram_bot_token="t",
        telegram_chat_id="1",
        smtp_host="h",
        smtp_from="a@b.c",
        smtp_to="d@e.f",
    )
    post = client.post
    # Webhook: not configured, then via the request's URL.
    assert post("/api/alerts/channels/webhook/test", json={}).status_code == 400
    ok = post("/api/alerts/channels/webhook/test", json={"webhookUrl": "https://one.example/x"})
    assert ok.status_code == 200 and ok.json() == {"ok": True}
    assert net.last.full_url == "https://one.example/x" and net.timeouts[-1] == 10.0
    assert (
        post("/api/alerts/channels/webhook/test", json={"webhookUrl": "ftp://x"}).status_code == 422
    )

    assert post("/api/alerts/channels/telegram/test").status_code == 200
    assert "bot" in net.last.full_url
    assert post("/api/alerts/channels/email/test", json={}).status_code == 200
    assert smtp.instances[-1].calls[-1] == "send"

    # Transport errors surface as a generic 502 (details only in the log); no log entry is created.
    net.script = [http_error(500)]
    bad = post("/api/alerts/channels/webhook/test", json={"webhookUrl": "https://one.example/x"})
    assert bad.status_code == 502 and "HTTP 500" not in bad.json()["detail"]
    net.script = [http_error(400, {"description": "chat not found"})]
    assert "chat not found" not in post("/api/alerts/channels/telegram/test").json()["detail"]
    smtp.error = smtplib.SMTPAuthenticationError(535, b"bad credentials")
    mail = post("/api/alerts/channels/email/test", json={})
    assert mail.status_code == 502 and "535" not in mail.json()["detail"]
    assert client.get("/api/alerts/log").json()["entries"] == []


# ------------------------------------------------------------------- SSRF guard

BLOCKED_URLS = [
    "http://127.0.0.1/x",
    "http://localhost.example/x",  # mapped to 127.0.0.1 below
    "http://169.254.169.254/latest/meta-data",
    "http://10.1.2.3/x",
    "http://192.168.0.1/x",
    "http://172.16.0.1/x",
    "http://0.0.0.0/x",
    "http://224.0.0.1/x",
    "http://240.0.0.1/x",
    "http://100.64.0.1/x",
    "http://[::1]/x",
    "http://[fe80::1]/x",
    "http://[fc00::1]/x",
    "http://[::ffff:127.0.0.1]/x",
    "http://[::ffff:10.0.0.1]/x",
    "http://[::]/x",
    "http://[ff02::1]/x",
]


@pytest.mark.parametrize("url", BLOCKED_URLS)
def test_webhook_refuses_non_public_destinations(
    url: str, net: FakeNet, fake_dns: dict[str, list[str]]
) -> None:
    fake_dns["localhost.example"] = ["127.0.0.1"]
    with pytest.raises(DeliveryError) as exc:
        webhook.send(url, b"{}", "application/json")
    assert exc.value.retryable is False and net.requests == []
    webhook.check_url(url, allow_private=True)  # the opt-in lifts it


def test_webhook_refuses_mixed_dns_answers(fake_dns: dict[str, list[str]]) -> None:
    fake_dns["rebind.example"] = ["93.184.216.34", "10.0.0.5"]
    with pytest.raises(DeliveryError):
        webhook.check_url("https://rebind.example/", allow_private=False)
    webhook.check_url("https://93.184.216.34/", allow_private=False)


def test_webhook_does_not_follow_redirects() -> None:
    handler = webhook._NoRedirect()
    req = urllib.request.Request("https://hook.example/")
    assert (
        handler.redirect_request(req, io.BytesIO(), 302, "Found", {}, "http://127.0.0.1/") is None
    )


def test_ssrf_guard_on_routes_and_dispatch(
    make_client: Callable[..., TestClient], net: FakeNet, maker: sessionmaker[Session]
) -> None:
    client = make_client(alerts_webhook_url="http://127.0.0.1:9/operator")
    bad = {"webhook": True, "webhookUrl": "http://169.254.169.254/latest"}
    assert client.post("/api/alerts", json=body(notify=bad)).status_code == 422
    test = client.post("/api/alerts/channels/webhook/test", json={"webhookUrl": "http://10.0.0.1/"})
    assert test.status_code == 422 and net.requests == []
    # The operator-set global URL may be private.
    assert client.post("/api/alerts/channels/webhook/test", json={}).status_code == 200
    # Opt-in allows per-alert private targets.
    open_ = make_client(alerts_webhook_allow_private=True)
    assert open_.post("/api/alerts", json=body(notify=bad)).status_code == 201
    # A stored private per-alert URL (e.g. setting later turned off) is refused at send time.
    sent = len(net.requests)
    seed(maker, [("webhook", "http://10.0.0.1/x")])
    run(Dispatcher(maker, settings()), T0)
    [row] = deliveries(maker)
    assert row.status == "failed" and row.last_error == "destination not allowed"
    assert len(net.requests) == sent


def test_502_detail_is_generic(make_client: Callable[..., TestClient], net: FakeNet) -> None:
    client = make_client()
    net.script = [urllib.error.URLError("[Errno 111] Connection refused")]
    res = client.post(
        "/api/alerts/channels/webhook/test", json={"webhookUrl": "https://a.example/"}
    )
    assert res.status_code == 502
    assert "refused" not in res.text and "Errno" not in res.text


# ------------------------------------------------------ ntfy / gotify / apprise

PUSH = {
    "ntfy": {"ntfy_url": "https://ntfy.example/alerts"},
    "gotify": {"gotify_url": "https://gotify.example", "gotify_token": "GTOKEN"},
    "apprise": {"apprise_url": "http://apprise:8000/notify"},
}
TITLE = "TickerGlass alert: Mine"


def test_ntfy_request_shape(maker: sessionmaker[Session], net: FakeNet) -> None:
    seed(maker, [("ntfy", None)])
    cfg = settings(
        ntfy_url="https://ntfy.example/alerts",
        ntfy_token="tk_secret",
        ntfy_priority="high",
        ntfy_tags="warning, chart_with_upwards_trend",
    )
    run(Dispatcher(maker, cfg), T0)
    req = net.last
    assert req.full_url == "https://ntfy.example/" and req.get_method() == "POST"
    assert req.get_header("Content-type") == "application/json"
    assert req.get_header("Authorization") == "Bearer tk_secret"
    assert net.timeouts == [10.0]
    got = net.body()
    assert got["topic"] == "alerts" and got["title"] == TITLE and got["priority"] == 4
    assert got["tags"] == ["warning", "chart_with_upwards_trend"]
    assert got["message"].startswith("AAPL Crossing 190.00\n\nSymbol: AAPL\nInterval: 1D\n")
    assert deliveries(maker)[0].status == "sent"


def test_ntfy_defaults_and_no_token_header(maker: sessionmaker[Session], net: FakeNet) -> None:
    seed(maker, [("ntfy", None)])
    run(Dispatcher(maker, settings(ntfy_url="http://ntfy:80/alerts")), T0)
    assert net.last.full_url == "http://ntfy:80/"  # private/LAN hosts are allowed
    assert net.last.get_header("Authorization") is None
    assert net.body()["priority"] == 3 and net.body()["tags"] == ["chart_with_upwards_trend"]


@pytest.mark.parametrize(
    ("url", "base", "topic"),
    [
        ("https://ntfy.sh/my-alerts", "https://ntfy.sh/", "my-alerts"),
        ("https://ntfy.sh/my-alerts/", "https://ntfy.sh/", "my-alerts"),
        ("https://example.com/ntfy/team/alerts", "https://example.com/ntfy/team/", "alerts"),
        ("http://ntfy:80/alerts", "http://ntfy:80/", "alerts"),
        ("https://user:pw@ntfy.sh/a", "https://user:pw@ntfy.sh/", "a"),
    ],
)
def test_ntfy_topic_base_split(url: str, base: str, topic: str) -> None:
    assert ntfy.split_topic_url(url) == (base, topic)


@pytest.mark.parametrize("url", ["https://ntfy.sh", "https://ntfy.sh/", "ftp://h/t", "/alerts"])
def test_ntfy_rejects_url_without_topic_or_bad_scheme(url: str) -> None:
    with pytest.raises(DeliveryError) as exc:
        ntfy.split_topic_url(url)
    assert exc.value.retryable is False


def test_ntfy_path_prefix_is_posted_to(maker: sessionmaker[Session], net: FakeNet) -> None:
    seed(maker, [("ntfy", None)])
    run(Dispatcher(maker, settings(ntfy_url="https://example.com/ntfy/alerts")), T0)
    assert net.last.full_url == "https://example.com/ntfy/"
    assert net.body()["topic"] == "alerts"


def test_gotify_request_shape(maker: sessionmaker[Session], net: FakeNet) -> None:
    seed(maker, [("gotify", None)])
    cfg = settings(gotify_url="http://gotify:8080/", gotify_token="GTOKEN", gotify_priority=8)
    run(Dispatcher(maker, cfg), T0)
    req = net.last
    assert req.full_url == "http://gotify:8080/message" and req.get_method() == "POST"
    assert req.get_header("X-gotify-key") == "GTOKEN"
    assert "GTOKEN" not in req.full_url and "?" not in req.full_url
    assert req.get_header("Content-type") == "application/json"
    got = net.body()
    assert got["title"] == TITLE and got["priority"] == 8
    assert got["message"].startswith("AAPL Crossing 190.00\n\n")
    assert deliveries(maker)[0].status == "sent"


def test_apprise_request_shape_stateless(maker: sessionmaker[Session], net: FakeNet) -> None:
    seed(maker, [("apprise", None)])
    cfg = settings(
        apprise_url="http://apprise:8000/notify",
        apprise_urls="tgram://bot/chat, mailto://u:p@example.com  json://hook",
        apprise_tag="alerts",
    )
    run(Dispatcher(maker, cfg), T0)
    assert net.last.full_url == "http://apprise:8000/notify"
    assert net.last.get_header("Content-type") == "application/json"
    got = net.body()
    assert got["title"] == TITLE and got["type"] == "info"
    assert got["urls"] == "tgram://bot/chat,mailto://u:p@example.com,json://hook"
    assert got["tag"] == "alerts"
    assert got["body"].startswith("AAPL Crossing 190.00\n\n")


def test_apprise_stateful_has_no_urls_or_tag(maker: sessionmaker[Session], net: FakeNet) -> None:
    seed(maker, [("apprise", None)])
    run(Dispatcher(maker, settings(apprise_url="http://apprise:8000/notify/main")), T0)
    assert net.last.full_url == "http://apprise:8000/notify/main"
    assert set(net.body()) == {"title", "body", "type"}


@pytest.mark.parametrize("channel", ["ntfy", "gotify", "apprise"])
def test_push_429_honors_retry_after(
    maker: sessionmaker[Session], net: FakeNet, channel: str
) -> None:
    seed(maker, [(channel, None)])
    net.script = [http_error(429, headers={"Retry-After": "120"})]
    run(Dispatcher(maker, settings(**PUSH[channel])), T0)
    [row] = deliveries(maker)
    assert row.status == "pending" and row.attempts == 1 and row.last_error == "HTTP 429"
    assert utc(row.next_attempt_at) == T0 + timedelta(seconds=120)  # not the usual +10 s


def test_retry_after_parsing(net: FakeNet) -> None:
    def retry_after(code: int, header: str | None) -> float | None:
        net.script = [http_error(code, headers={"Retry-After": header} if header else None)]
        with pytest.raises(DeliveryError) as exc:
            webhook.post("https://h.example/x", b"{}", "application/json")
        return exc.value.retry_after

    assert retry_after(503, "45") == 45.0
    assert retry_after(429, "0") == 0.0
    assert retry_after(503, "Wed, 21 Oct 2026 07:28:00 GMT") is None  # HTTP-date form ignored
    assert retry_after(503, "-5") is None and retry_after(503, "nan") is None
    assert retry_after(429, "999999") == webhook.MAX_RETRY_AFTER_S
    assert retry_after(500, "30") is None and retry_after(429, None) is None


@pytest.mark.parametrize("channel", ["ntfy", "gotify", "apprise"])
def test_push_4xx_is_permanent_and_never_leaks_secrets(
    maker: sessionmaker[Session], net: FakeNet, channel: str
) -> None:
    seed(maker, [(channel, None)])
    net.script = [http_error(401, {"error": "bad token tk_secret GTOKEN"})]
    cfg = settings(**PUSH[channel], ntfy_token="tk_secret", apprise_urls="tgram://SECRETBOT/chat")
    run(Dispatcher(maker, cfg), T0)
    [row] = deliveries(maker)
    assert row.status == "failed" and row.attempts == 1 and row.last_error == "HTTP 401"
    for secret in ("tk_secret", "GTOKEN", "SECRETBOT"):
        assert secret not in (row.last_error or "")


@pytest.mark.parametrize("channel", ["ntfy", "gotify", "apprise"])
def test_push_5xx_and_network_errors_are_retried(
    maker: sessionmaker[Session], net: FakeNet, channel: str
) -> None:
    seed(maker, [(channel, None)])
    net.script = [http_error(500), urllib.error.URLError("refused")]
    d = Dispatcher(maker, settings(**PUSH[channel]))
    run(d, T0)
    [row] = deliveries(maker)
    assert row.status == "pending" and row.last_error == "HTTP 500"
    run(d, T0 + timedelta(seconds=10))
    [row] = deliveries(maker)
    assert row.status == "pending" and row.attempts == 2 and row.last_error == "delivery failed"


def test_unconfigured_push_channels_fail_without_retry(
    maker: sessionmaker[Session], net: FakeNet
) -> None:
    seed(maker, [("ntfy", None), ("gotify", None), ("apprise", None)])
    # Gotify needs both URL and token.
    cfg = settings(gotify_url="https://gotify.example")
    assert run(Dispatcher(maker, cfg), T0) == 3
    rows = deliveries(maker)
    assert [r.status for r in rows] == ["failed"] * 3
    assert {r.last_error for r in rows} == {"not configured"}
    assert net.requests == []


def test_push_transports_refuse_non_http_schemes(
    maker: sessionmaker[Session], net: FakeNet
) -> None:
    seed(maker, [("gotify", None), ("apprise", None)])
    cfg = settings(gotify_url="http://gotify", gotify_token="t", apprise_url="http://apprise")
    # Settings validation rejects these; the transports must still refuse them on their own.
    cfg.gotify_url, cfg.apprise_url = "ftp://gotify", "file:///etc/passwd"
    run(Dispatcher(maker, cfg), T0)
    rows = deliveries(maker)
    assert [r.status for r in rows] == ["failed", "failed"]
    assert {r.last_error for r in rows} == {"invalid URL"}
    assert net.requests == []


def test_webhook_post_extra_headers_and_send_unchanged(net: FakeNet) -> None:
    webhook.post("https://h.example/x", b"{}", "application/json", headers={"X-A": "1"})
    assert net.last.get_header("X-a") == "1" and net.last.get_header("User-agent")
    webhook.send("https://h.example/x", b"{}", "application/json", secret="k")
    assert net.last.get_header("X-tickerglass-signature", "").startswith("sha256=")
    assert net.last.get_header("User-agent") == "TickerGlass-Alerts"


# ----------------------------------------------------------- settings


@pytest.mark.parametrize(
    ("raw", "want"),
    [
        ("min", 1), ("low", 2), ("default", 3), ("High", 4), ("max", 5), ("urgent", 5),
        ("1", 1), ("5", 5), (2, 2), ("", 3),
    ],
)  # fmt: skip
def test_ntfy_priority_valid(raw: str | int, want: int) -> None:
    assert settings(ntfy_priority=raw).ntfy_priority == want


@pytest.mark.parametrize("raw", ["0", "6", "loud", "-1", 0, 6, "3.5"])
def test_ntfy_priority_invalid(raw: str | int) -> None:
    with pytest.raises(ValidationError):
        settings(ntfy_priority=raw)


def test_gotify_priority_range() -> None:
    assert settings().gotify_priority == 5 and settings().ntfy_priority == 3
    assert settings(gotify_priority="0").gotify_priority == 0
    assert settings(gotify_priority=10).gotify_priority == 10
    for bad in (-1, 11, "x"):
        with pytest.raises(ValidationError):
            settings(gotify_priority=bad)


def test_priority_env_parsing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("NTFY_PRIORITY", "urgent")
    monkeypatch.setenv("GOTIFY_PRIORITY", "7")
    s = Settings(_env_file=None)  # type: ignore[call-arg]
    assert (s.ntfy_priority, s.gotify_priority) == (5, 7)
    monkeypatch.setenv("NTFY_PRIORITY", "9")
    with pytest.raises(ValidationError):
        Settings(_env_file=None)  # type: ignore[call-arg]


# ---------------------------------------------------- endpoints and masking


def test_mask_url_strips_userinfo_query_and_path() -> None:
    assert mask_url("https://user:pw@ntfy.example:8443/secret/topic?auth=TOKEN#x") == (
        "https://ntfy.example:8443/…"
    )
    assert mask_url(None) is None and mask_url("") is None


def test_channels_endpoint_shape_and_masking(make_client: Callable[..., TestClient]) -> None:
    client = make_client(
        ntfy_url="https://user:pw@ntfy.example/private-topic",
        ntfy_token="tk_secret",
        gotify_url="http://gotify:8080/base",
        gotify_token="GTOKEN",
        apprise_url="http://apprise:8000/notify/KEY",
        apprise_urls="tgram://SECRETBOT/chat",
        apprise_tag="t",
    )
    got = client.get("/api/alerts/channels").json()
    assert got["ntfy"] == {"configured": True, "url": "https://ntfy.example/…"}
    assert got["gotify"] == {"configured": True, "url": "http://gotify:8080/…"}
    assert got["apprise"] == {"configured": True, "url": "http://apprise:8000/…"}
    text = json.dumps(got)
    for secret in ("tk_secret", "GTOKEN", "SECRETBOT", "private-topic", "KEY", "pw"):
        assert secret not in text
    # Gotify without its token is not configured, but still shows where it points.
    half = make_client(gotify_url="http://gotify:8080").get("/api/alerts/channels").json()
    assert half["gotify"] == {"configured": False, "url": "http://gotify:8080/…"}


def test_channel_test_endpoint_push_channels(
    make_client: Callable[..., TestClient], net: FakeNet
) -> None:
    client = make_client(
        ntfy_url="https://ntfy.example/alerts",
        gotify_url="http://gotify:8080",
        gotify_token="GTOKEN",
        apprise_url="http://apprise:8000/notify",
    )
    for channel, url in [
        ("ntfy", "https://ntfy.example/"),
        ("gotify", "http://gotify:8080/message"),
        ("apprise", "http://apprise:8000/notify"),
    ]:
        res = client.post(f"/api/alerts/channels/{channel}/test")
        assert res.status_code == 200 and res.json() == {"ok": True}
        assert net.last.full_url == url
        sent = net.body()
        assert "Test alert" in sent.get("title", "") and "TickerGlass test notification" in str(
            sent.get("message") or sent.get("body")
        )
    net.script = [http_error(500)]
    bad = client.post("/api/alerts/channels/gotify/test")
    assert bad.status_code == 502 and "GTOKEN" not in bad.text and "500" not in bad.text
    other = make_client(ntfy_url="https://ntfy.example/alerts")
    assert other.post("/api/alerts/channels/gotify/test").status_code == 400
    assert client.get("/api/alerts/log").json()["entries"] == []


def test_fire_enqueues_push_deliveries_for_configured_channels(
    make_client: Callable[..., TestClient], net: FakeNet
) -> None:
    client = make_client(ntfy_url="https://ntfy.example/alerts", alerts_internal_token=None)
    notify = {"ntfy": True, "gotify": True, "apprise": False}
    a = create(client, id="a1", notify=notify)
    by = {d["channel"]: d for d in fire(client, a).json()["deliveries"]}
    assert set(by) == {"ntfy", "gotify"}
    assert by["ntfy"]["status"] in ("pending", "sent")
    assert by["gotify"]["status"] == "failed" and by["gotify"]["lastError"] == "not configured"


# ------------------------------------------------- userinfo -> Basic auth (real opener)

SECRET = "SECRETPW"


class Hook:
    """A local HTTP server (127.0.0.1) recording what the real opener sent it."""

    def __init__(self) -> None:
        self.seen: list[tuple[str, str | None, bytes]] = []
        seen = self.seen

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # noqa: N802
                n = int(self.headers.get("Content-Length", 0))
                seen.append((self.path, self.headers.get("Authorization"), self.rfile.read(n)))
                self.send_response(200)
                self.send_header("Content-Length", "0")
                self.end_headers()

            def log_message(self, *a: Any) -> None:
                return None

        self.server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture
def hook() -> Iterator[Hook]:
    h = Hook()
    yield h
    h.close()


def basic(user: str, password: str) -> str:
    return "Basic " + base64.b64encode(f"{user}:{password}".encode()).decode()


def test_userinfo_becomes_basic_auth_through_the_real_opener(
    hook: Hook, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG)
    url = f"http://us%40er:{SECRET}@127.0.0.1:{hook.port}/x"
    webhook.post(url, b"{}", "application/json", allow_private=True)
    assert hook.seen == [("/x", basic("us@er", SECRET), b"{}")]
    assert SECRET not in caplog.text


def test_userinfo_without_a_port_through_the_real_opener(
    hook: Hook,
    fake_dns: dict[str, list[str]],
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.DEBUG)
    fake_dns["hook.example"] = ["127.0.0.1"]
    real = socket.create_connection
    monkeypatch.setattr(
        socket,
        "create_connection",
        lambda addr, *a, **kw: real(("127.0.0.1", hook.port), *a, **kw),
    )
    webhook.post(f"http://u:{SECRET}@hook.example/x", b"{}", "text/plain", allow_private=True)
    assert hook.seen == [("/x", basic("u", SECRET), b"{}")]
    assert SECRET not in caplog.text


def test_explicit_authorization_header_beats_userinfo(hook: Hook) -> None:
    webhook.post(
        f"http://u:{SECRET}@127.0.0.1:{hook.port}/x",
        b"{}",
        "application/json",
        headers={"Authorization": "Bearer tk"},
        allow_private=True,
    )
    assert hook.seen[0][1] == "Bearer tk"


def test_userinfo_never_leaks_on_failure(
    maker: sessionmaker[Session], caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG)
    with socket.socket() as s:  # a port with nothing listening
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    seed(maker, [("webhook", None)])
    cfg = settings(alerts_webhook_url=f"http://u:{SECRET}@127.0.0.1:{port}/x")
    run(Dispatcher(maker, cfg), T0)
    (d,) = deliveries(maker)
    assert d.attempts == 1 and d.last_error == "delivery failed"
    assert SECRET not in caplog.text


def test_http_client_exceptions_are_a_generic_retryable_failure(
    net: FakeNet, caplog: pytest.LogCaptureFixture
) -> None:
    net.script = [http.client.InvalidURL("nonnumeric port: 'PW@host'")]
    with pytest.raises(DeliveryError) as exc:
        webhook.post("https://hook.example/x", b"{}", "application/json")
    assert str(exc.value) == "delivery failed" and exc.value.retryable is True


def test_ntfy_userinfo_becomes_basic_auth(maker: sessionmaker[Session], net: FakeNet) -> None:
    seed(maker, [("ntfy", None)])
    run(Dispatcher(maker, settings(ntfy_url=f"http://bob:{SECRET}@ntfy:80/alerts")), T0)
    assert net.last.full_url == "http://ntfy:80/"
    assert net.last.get_header("Authorization") == basic("bob", SECRET)
    assert net.body()["topic"] == "alerts"


def test_ntfy_token_overrides_userinfo(maker: sessionmaker[Session], net: FakeNet) -> None:
    seed(maker, [("ntfy", None)])
    cfg = settings(ntfy_url=f"http://bob:{SECRET}@ntfy:80/alerts", ntfy_token="tk_x")
    run(Dispatcher(maker, cfg), T0)
    assert net.last.get_header("Authorization") == "Bearer tk_x"


def test_ntfy_url_with_query_is_rejected() -> None:
    with pytest.raises(ValidationError, match="NTFY_URL must not contain a query string"):
        settings(ntfy_url="https://ntfy.sh/alerts?auth=abc")


@pytest.mark.parametrize("field", ["ntfy_url", "gotify_url", "apprise_url"])
@pytest.mark.parametrize("value", ["ntfy.sh/alerts", "ftp://h/t", "http:///x", "http://h:bad/x"])
def test_channel_urls_must_be_http_with_a_host(field: str, value: str) -> None:
    with pytest.raises(ValidationError):
        settings(**{field: value})


def test_channel_urls_empty_means_unset_and_tags_may_be_empty() -> None:
    cfg = settings(ntfy_url="", gotify_url=" ", apprise_url="", ntfy_tags="")
    assert cfg.ntfy_url is None and cfg.gotify_url is None and cfg.apprise_url is None
    assert cfg.ntfy_tags == ""


@pytest.mark.parametrize(
    ("url", "expected"),
    [
        ("https://u:pw@host:8080/a/b?k=v", "https://host:8080/…"),
        ("https://host/secret", "https://host/…"),
        ("http://[::1", "(invalid)"),
        ("host/path", "(invalid)"),
        ("", None),
        (None, None),
    ],
)
def test_mask_url_handles_invalid_input(url: str | None, expected: str | None) -> None:
    assert mask_url(url) == expected


def test_dispatcher_catch_all_stores_only_the_exception_type(
    maker: sessionmaker[Session], monkeypatch: pytest.MonkeyPatch
) -> None:
    def boom(*a: Any, **kw: Any) -> None:
        raise http.client.InvalidURL(f"nonnumeric port: 'PW@{SECRET}'")

    seed(maker, [("webhook", None)])
    d = Dispatcher(maker, settings(alerts_webhook_url="https://hook.example/x"))
    monkeypatch.setattr(d, "_send", boom)
    run(d, T0)
    (row,) = deliveries(maker)
    assert row.last_error == "unexpected error: InvalidURL"
