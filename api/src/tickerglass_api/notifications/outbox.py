"""Recording one alert-log entry: the log row, its pending deliveries, pruning and the live
`alert.fired` frame. Shared by `POST /alerts/{id}/fire` and the screener's screen alerts
(docs/alerts.md §1.5, docs/design/server-screener.md)."""

from collections.abc import Callable
from datetime import datetime
from typing import Any, NamedTuple

from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .. import models as m
from ..live import LiveHub
from ..settings import Settings
from ..userdata import alerts as al
from ..userdata import schemas as s
from . import channel_configured
from .dispatcher import Dispatcher


class Recorded(NamedTuple):
    """`created` is False when `fire_id` was already logged (that earlier entry is returned)."""

    log: m.AlertLog
    created: bool


def log_entry(session: Session, row: m.AlertLog) -> al.AlertLogEntry:
    """A stored log row with its deliveries, in the API shape."""
    dels = list(
        session.scalars(
            select(m.AlertDelivery)
            .where(m.AlertDelivery.log_id == row.id)
            .order_by(m.AlertDelivery.id)
        )
    )
    return al.log_entry(row, dels)


def prune_log(session: Session, keep: int) -> None:
    """Keep the newest `keep` log entries (deliveries go with them)."""
    cutoff = session.scalar(
        select(m.AlertLog.id).order_by(m.AlertLog.id.desc()).offset(max(keep, 1)).limit(1)
    )
    if cutoff is None:
        return
    session.execute(delete(m.AlertDelivery).where(m.AlertDelivery.log_id <= cutoff))
    session.execute(delete(m.AlertLog).where(m.AlertLog.id <= cutoff))


def record_log_entry(
    session: Session,
    settings: Settings,
    hub: LiveHub,
    dispatcher: Dispatcher,
    *,
    fire_id: str,
    name: str,
    symbol: str,
    interval: str,
    kind: str,
    bar_time: int,
    message: str,
    values: dict[str, Any],
    notify: al.AlertNotify,
    alert_id: str | None = None,
    fired_at: datetime | None = None,
    delayed: bool = False,
    final: bool = False,
    alert_payload: dict[str, Any] | None = None,
    before_commit: Callable[[], None] | None = None,
) -> Recorded:
    """Log one fire in the caller's transaction, then commit and announce it.

    Idempotent per `fire_id`: a repeat (also one that loses a concurrent insert race, which
    rolls the whole transaction back) returns the stored entry with `created=False` and
    announces nothing. Otherwise adds one `AlertDelivery` per wanted channel (`failed`
    right away when the channel is not configured), runs `before_commit` (extra writes of
    the same transaction), prunes the log, commits, publishes `alert.fired` (with
    `alert_payload` as its `alert`, null for alert-less entries) and wakes the dispatcher.
    """
    prior = session.scalar(select(m.AlertLog).where(m.AlertLog.fire_id == fire_id))
    if prior is not None:
        return Recorded(prior, False)
    when = fired_at or s.now()
    log = m.AlertLog(
        fire_id=fire_id,
        alert_id=alert_id,
        alert_name=name,
        symbol=symbol,
        interval=interval,
        kind=kind,
        fired_at=when,
        bar_time=bar_time,
        message=message,
        values=values,
        delayed=delayed,
        final=final,
        read=False,
    )
    session.add(log)
    try:
        session.flush()
    except IntegrityError:
        # A concurrent retry logged this fireId first: that one wins, nothing else happens.
        session.rollback()
        winner = session.scalar(select(m.AlertLog).where(m.AlertLog.fire_id == fire_id))
        if winner is None:
            raise
        return Recorded(winner, False)

    wanted: list[tuple[str, str | None]] = []
    if notify.webhook:
        wanted.append(("webhook", notify.webhook_url))
    if notify.telegram:
        wanted.append(("telegram", None))
    if notify.email:
        wanted.append(("email", None))
    t = s.now()
    for channel, target in wanted:
        ok = channel_configured(settings, channel, target)
        session.add(
            m.AlertDelivery(
                log_id=log.id,
                channel=channel,
                target=target,
                status="pending" if ok else "failed",
                attempts=0,
                next_attempt_at=t,
                last_error=None if ok else "not configured",
            )
        )

    if before_commit is not None:
        before_commit()
    prune_log(session, settings.alerts_log_max)
    session.commit()

    entry = log_entry(session, log)
    hub.publish_threadsafe(
        "alerts",
        {
            "type": "alert.fired",
            "entry": entry.model_dump(mode="json", by_alias=True),
            "alert": alert_payload,
        },
    )
    dispatcher.wake()
    return Recorded(log, True)


__all__ = ["Recorded", "log_entry", "prune_log", "record_log_entry"]
