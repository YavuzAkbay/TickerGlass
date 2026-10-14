"""Alert delivery: transports (stdlib urllib/smtplib, faked), the outbox dispatcher's
retry schedule and restart behavior, and the channel test endpoint (docs/alerts.md §4)."""

import asyncio
import hashlib
import hmac
import io
import json
import smtplib
import time
import urllib.error
import urllib.request
from collections.abc import Callable, Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker
from test_alerts import create, fire

from investopen_api import models as m
from investopen_api.db import make_engine, run_migrations
from investopen_api.notifications.dispatcher import MAX_ATTEMPTS, Dispatcher
from investopen_api.settings import Settings
from investopen_api.userdata.alerts import utc

T0 = datetime(2026, 10, 15, 14, 30, tzinfo=UTC)


# ------------------------------------------------------------------- fakes


class FakeResponse:
    def read(self) -> bytes:
        return b"ok"

    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, *exc: object) -> None:
        return None


def http_error(code: int, body: dict[str, Any] | None = None) -> urllib.error.HTTPError:
    data = json.dumps(body or {}).encode()
    return urllib.error.HTTPError("http://x", code, "err", {}, io.BytesIO(data))  # type: ignore[arg-type]


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
    monkeypatch.setattr(urllib.request, "urlopen", fake)
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
    yield sessionmaker(engine, expire_on_commit=False)
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
    assert req.get_header("X-investopen-signature") == f"sha256={want}"
    assert run(d, T0 + timedelta(hours=1)) == 0  # sent rows are never retried


def test_webhook_per_alert_target_overrides_default_and_no_secret(
    maker: sessionmaker[Session], net: FakeNet
) -> None:
    seed(maker, [("webhook", "https://mine.example/h")])
    run(Dispatcher(maker, settings(alerts_webhook_url="https://default.example/")), T0)
    assert net.last.full_url == "https://mine.example/h"
    assert net.last.get_header("X-investopen-signature") is None


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
    assert msg["Subject"] == "InvestOpen alert: Mine"
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
    assert row.status == "pending" and "connection refused" in (row.last_error or "")
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

    # Transport errors surface as 502 with the reason; no log entry is created.
    net.script = [http_error(500)]
    bad = post("/api/alerts/channels/webhook/test", json={"webhookUrl": "https://one.example/x"})
    assert bad.status_code == 502 and bad.json()["detail"] == "HTTP 500"
    net.script = [http_error(400, {"description": "chat not found"})]
    assert post("/api/alerts/channels/telegram/test").json()["detail"].endswith("chat not found")
    smtp.error = smtplib.SMTPAuthenticationError(535, b"bad credentials")
    mail = post("/api/alerts/channels/email/test", json={})
    assert mail.status_code == 502 and "535" in mail.json()["detail"]
    assert client.get("/api/alerts/log").json()["entries"] == []
