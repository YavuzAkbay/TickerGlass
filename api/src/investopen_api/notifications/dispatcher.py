"""Outbox dispatcher: delivers pending `alert_deliveries` rows (docs/alerts.md §4.2).

The database is the outbox, so pending deliveries survive a restart. Attempts happen at
+0 s, 10 s, 60 s, 5 min and 30 min (5 in total), then the delivery is `failed`.
"""

import asyncio
import contextlib
import json
import logging
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session, sessionmaker

from .. import models as m
from ..live import LiveHub
from ..settings import Settings
from . import DeliveryError, effective_webhook_url, email, telegram, webhook, webhook_allow_private

log = logging.getLogger(__name__)

#: Delay before attempt 2, 3, 4, 5.
RETRY_DELAYS_S = (10.0, 60.0, 300.0, 1800.0)
MAX_ATTEMPTS = len(RETRY_DELAYS_S) + 1
BATCH = 50
IDLE_S = 5.0


def iso(dt: datetime) -> str:
    aware = dt.replace(tzinfo=UTC) if dt.tzinfo is None else dt.astimezone(UTC)
    return aware.isoformat().replace("+00:00", "Z")


def _now() -> datetime:
    return datetime.now(UTC)


class Dispatcher:
    def __init__(
        self, maker: sessionmaker[Session], settings: Settings, hub: LiveHub | None = None
    ) -> None:
        self._maker = maker
        self._settings = settings
        self._hub = hub
        self._loop: asyncio.AbstractEventLoop | None = None
        self._event: asyncio.Event | None = None
        self._task: asyncio.Task[None] | None = None

    # -- lifecycle ----------------------------------------------------------

    def start(self) -> None:
        self._loop = asyncio.get_running_loop()
        self._event = asyncio.Event()
        self._task = asyncio.create_task(self._run(), name="alerts-dispatcher")

    async def stop(self) -> None:
        task, self._task = self._task, None
        if task is None:
            return
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task
        self._loop = None

    def wake(self) -> None:
        """Process due deliveries now. Safe from any thread."""
        loop, event = self._loop, self._event
        if loop is None or event is None or loop.is_closed():
            return
        with contextlib.suppress(RuntimeError):
            loop.call_soon_threadsafe(event.set)

    async def _run(self) -> None:
        assert self._event is not None
        while True:
            try:
                if await self.process_due() >= BATCH:
                    continue
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("alert dispatcher pass failed")
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self._event.wait(), IDLE_S)
            self._event.clear()

    # -- one pass -----------------------------------------------------------

    async def process_due(self, now: datetime | None = None) -> int:
        """Attempt every due pending delivery (up to `BATCH`); returns how many were tried."""
        now = now or _now()
        tried = 0
        changed: list[int] = []
        with self._maker() as session:
            rows = session.execute(
                select(m.AlertDelivery, m.AlertLog)
                .join(m.AlertLog, m.AlertLog.id == m.AlertDelivery.log_id)
                .where(m.AlertDelivery.status == "pending", m.AlertDelivery.next_attempt_at <= now)
                .order_by(m.AlertDelivery.next_attempt_at, m.AlertDelivery.id)
                .limit(BATCH)
            ).all()
            for delivery, entry in rows:
                raw = self._raw_webhook(session, entry)
                try:
                    await asyncio.to_thread(
                        self._send, delivery.channel, delivery.target, entry, raw
                    )
                except DeliveryError as exc:
                    self._record_failure(delivery, exc, now)
                except Exception as exc:  # a transport bug must not wedge the outbox
                    log.exception("unexpected %s delivery error", delivery.channel)
                    self._record_failure(
                        delivery, DeliveryError(f"{type(exc).__name__}: {exc}"), now
                    )
                else:
                    delivery.status, delivery.last_error = "sent", None
                    delivery.attempts += 1
                tried += 1
                try:
                    session.commit()
                except SQLAlchemyError:
                    # The entry was pruned or cleared while we were sending.
                    session.rollback()
                    continue
                changed.append(entry.id)
        if changed and self._hub is not None:
            self._hub.publish("alerts", {"type": "alerts.log", "ids": sorted(set(changed))})
        return tried

    @staticmethod
    def _record_failure(delivery: m.AlertDelivery, exc: DeliveryError, now: datetime) -> None:
        delivery.attempts += 1
        delivery.last_error = str(exc)[:500]
        if not exc.retryable or delivery.attempts >= MAX_ATTEMPTS:
            delivery.status = "failed"
            return
        delay = max(RETRY_DELAYS_S[delivery.attempts - 1], exc.retry_after or 0.0)
        delivery.next_attempt_at = now + timedelta(seconds=delay)

    @staticmethod
    def _raw_webhook(session: Session, entry: m.AlertLog) -> bool:
        """`notify.webhookRaw` of the (still existing) alert; JSON envelope otherwise."""
        alert = session.get(m.Alert, entry.alert_id) if entry.alert_id else None
        return bool(alert and alert.notify.get("webhookRaw"))

    # -- transports ---------------------------------------------------------

    def _send(self, channel: str, target: str | None, entry: m.AlertLog, raw: bool) -> None:
        """Blocking; runs in a worker thread."""
        s = self._settings
        if channel == "webhook":
            url = effective_webhook_url(s, target)
            if url is None:
                raise DeliveryError("not configured", retryable=False)
            body, content_type = webhook_body(entry, raw)
            webhook.send(
                url,
                body,
                content_type,
                secret=s.alerts_webhook_secret,
                allow_private=webhook_allow_private(s, target),
            )
        elif channel == "telegram":
            if not (s.telegram_bot_token and s.telegram_chat_id):
                raise DeliveryError("not configured", retryable=False)
            telegram.send(s.telegram_bot_token, s.telegram_chat_id, entry.message)
        elif channel == "email":
            subject, text = email_content(entry)
            email.send(s, subject, text)
        else:
            raise DeliveryError(f"unknown channel {channel!r}", retryable=False)


def webhook_body(entry: m.AlertLog, raw: bool) -> tuple[bytes, str]:
    """(body, content type): the rendered message (JSON if it parses, else text) or the envelope."""
    if raw:
        try:
            json.loads(entry.message)
            content_type = "application/json"
        except ValueError:
            content_type = "text/plain; charset=utf-8"
        return entry.message.encode(), content_type
    envelope: dict[str, Any] = {
        "alert": {
            "id": entry.alert_id,
            "name": entry.alert_name,
            "symbol": entry.symbol,
            "interval": entry.interval,
        },
        "message": entry.message,
        "firedAt": iso(entry.fired_at),
        "barTime": entry.bar_time,
        "values": entry.values,
        "delayed": entry.delayed,
    }
    return json.dumps(envelope).encode(), "application/json"


def email_content(entry: m.AlertLog) -> tuple[str, str]:
    subject = f"InvestOpen alert: {entry.alert_name}"
    body = (
        f"{entry.message}\n\n"
        f"Symbol: {entry.symbol}\n"
        f"Interval: {entry.interval}\n"
        f"Bar time: {iso(datetime.fromtimestamp(entry.bar_time, UTC))}\n"
        f"Fired at: {iso(entry.fired_at)}\n"
    )
    return subject, body
