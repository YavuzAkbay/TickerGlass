"""Alerts (docs/alerts.md §1.4-§1.7): CRUD with revisions, firing, runtime state, log,
channels and the service heartbeat. Only the API writes the database; the Node service
goes through these routes."""

import hmac
import logging
from datetime import datetime, timedelta
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, Response
from sqlalchemy import case, delete, func, or_, select, update
from sqlalchemy.exc import IntegrityError

from .. import models as m
from ..deps import DispatcherDep, HubDep, SessionDep, SettingsDep
from ..notifications import (
    DeliveryError,
    channel_configured,
    email,
    mask_email,
    mask_url,
    smtp_recipients,
    telegram,
    webhook,
    webhook_allow_private,
)
from ..notifications import effective_webhook_url as effective_url
from ..notifications.dispatcher import email_content, iso, webhook_body
from ..settings import Settings
from ..userdata import alerts as al
from ..userdata import schemas as s
from ..userdata import store

log = logging.getLogger(__name__)
router = APIRouter(prefix="/alerts", tags=["alerts"])

ONLINE_WITHIN = timedelta(seconds=90)
_FIRE_RETRIES = 3


class ServiceState:
    """The evaluation service's last heartbeat (memory only, not in the DB)."""

    def __init__(self) -> None:
        self.heartbeat: al.ServiceHeartbeat | None = None
        self.last_at: datetime | None = None


def _service_state(request: Request) -> ServiceState:
    state: ServiceState = request.app.state.alerts_service
    return state


ServiceStateDep = Annotated[ServiceState, Depends(_service_state)]


def require_service_token(
    settings: SettingsDep, x_alerts_token: Annotated[str | None, Header()] = None
) -> None:
    """Service-only routes need `X-Alerts-Token` when `ALERTS_INTERNAL_TOKEN` is set."""
    expected = settings.alerts_internal_token
    if expected and not hmac.compare_digest((x_alerts_token or "").encode(), expected.encode()):
        raise HTTPException(401, "missing or invalid X-Alerts-Token")


ServiceOnly = [Depends(require_service_token)]


# ------------------------------------------------------------------ helpers


def _get(session: SessionDep, alert_id: str) -> m.Alert:
    row = session.get(m.Alert, alert_id)
    if row is None:
        raise HTTPException(404, f"alert not found: {alert_id}")
    return row


def _conflict(row: m.Alert) -> HTTPException:
    return HTTPException(
        409,
        {
            "message": f"alert {row.id} changed elsewhere",
            "current": al.alert_out(row).model_dump(mode="json", by_alias=True),
        },
    )


def _changed(hub: HubDep, ids: list[str], deleted: list[str] | None = None) -> None:
    hub.publish_threadsafe(
        "alerts", {"type": "alerts.changed", "ids": ids, "deleted": deleted or []}
    )


def _sweep_expired(session: SessionDep, hub: HubDep, skip: str | None = None) -> None:
    """Lazy expiry: active alerts past `expires_at` become `expired` (revision bumped).

    `skip` leaves one alert alone (a fire decides its own expiry against `firedAt`)."""
    t = s.now()
    due: tuple[Any, ...] = (
        m.Alert.status == "active",
        m.Alert.expires_at.is_not(None),
        m.Alert.expires_at <= t,
    )
    if skip is not None:
        due = (*due, m.Alert.id != skip)
    ids = list(session.scalars(select(m.Alert.id).where(*due)))
    if not ids:
        return
    session.execute(
        update(m.Alert)
        .where(m.Alert.id.in_(ids), *due)
        .values(status="expired", status_reason=None, revision=m.Alert.revision + 1)
        .execution_options(synchronize_session=False)
    )
    session.commit()
    _changed(hub, ids)


def _check_webhook(settings: Settings, notify: al.AlertNotify) -> None:
    """422 for a per-alert webhook URL the SSRF guard would refuse at send time."""
    url = notify.webhook_url
    if not url:
        return
    try:
        webhook.check_url(url, webhook_allow_private(settings, url))
    except DeliveryError as exc:
        raise HTTPException(422, f"webhookUrl: {exc}") from None


def _check_drawings(session: SessionDep, symbol: str, spec: al.AlertSpec) -> None:
    """Drawing operands must reference a stored drawing that supports the part and symbol."""
    for use in al.drawing_uses(spec):
        row = session.get(m.DrawingRow, use.drawing_id)
        if row is None:
            raise HTTPException(422, f"drawing not saved: {use.drawing_id}")
        dtype = row.data.get("type")
        points = row.data.get("points")
        n_points = len(points) if isinstance(points, list) else 0
        is_channel = (
            dtype == "rectangle"
            or (dtype == "parallel-channel" and n_points == 3)
            or (dtype == "flat-channel" and n_points == 3)
            # Stored with the 4th anchor; a 3-anchor draft derives it.
            or (dtype == "split-channel" and n_points in (3, 4))
        )
        if use.part == "line":
            if dtype not in al.LINE_TOOLS:
                raise HTTPException(422, f"drawing {use.drawing_id} ({dtype}) has no 'line' part")
        elif not is_channel:
            what = "a channel part" if use.part else "a channel"
            raise HTTPException(
                422,
                f"drawing {use.drawing_id} ({dtype}) is not {what}: needs a "
                "rectangle, a 3-point parallel-channel, flat-channel or split-channel",
            )
        if row.symbol is not None and row.symbol != symbol.strip().upper():
            raise HTTPException(
                422, f"drawing {use.drawing_id} belongs to {row.symbol}, not {symbol}"
            )


def _expiry(value: datetime | None) -> datetime | None:
    return None if value is None else al.utc(value)


def _require_future(status: str, expires_at: datetime | None) -> None:
    if status == "active" and expires_at is not None and expires_at <= s.now():
        raise HTTPException(422, "expiresAt must be in the future for an active alert")


def _entry(session: SessionDep, row: m.AlertLog) -> al.AlertLogEntry:
    dels = list(
        session.scalars(
            select(m.AlertDelivery)
            .where(m.AlertDelivery.log_id == row.id)
            .order_by(m.AlertDelivery.id)
        )
    )
    return al.log_entry(row, dels)


# --------------------------------------------------------------- fixed paths


@router.get("/states", response_model=list[al.StateOut])
def get_states(session: SessionDep) -> list[al.StateOut]:
    """Runtime states of all alerts (service)."""
    q = select(m.AlertState).order_by(m.AlertState.alert_id)
    return [
        al.StateOut(alert_id=r.alert_id, revision=r.revision, state=r.state)
        for r in session.scalars(q)
    ]


@router.put("/states", response_model=al.StatesWritten, dependencies=ServiceOnly)
def put_states(session: SessionDep, body: al.StatesPut) -> al.StatesWritten:
    """Upsert each state only if the alert exists at exactly that revision; never 409."""
    last: dict[str, al.StateIn] = {x.alert_id: x for x in body.states}
    for attempt in range(_FIRE_RETRIES):
        revisions = {
            aid: rev
            for aid, rev in session.execute(
                select(m.Alert.id, m.Alert.revision).where(m.Alert.id.in_(list(last)))
            )
        }
        written = [a for a, x in last.items() if revisions.get(a) == x.revision]
        t = s.now()
        existing = {
            r.alert_id: r
            for r in session.scalars(select(m.AlertState).where(m.AlertState.alert_id.in_(written)))
        }
        for a in written:
            x = last[a]
            row = existing.get(a)
            if row is None:
                session.add(
                    m.AlertState(alert_id=a, revision=x.revision, state=x.state, updated_at=t)
                )
            else:
                row.revision, row.state, row.updated_at = x.revision, x.state, t
        try:
            session.commit()
        except IntegrityError:
            # A concurrent writer inserted (or the alert vanished): redo against the new state.
            session.rollback()
            if attempt == _FIRE_RETRIES - 1:
                raise HTTPException(409, "states changed elsewhere; retry") from None
            continue
        written_set = set(written)
        return al.StatesWritten(written=written, ignored=[a for a in last if a not in written_set])
    raise AssertionError("unreachable")  # pragma: no cover


@router.get("/log", response_model=al.LogPage)
def get_log(
    session: SessionDep,
    alert_id: Annotated[str | None, Query(alias="alertId", max_length=36)] = None,
    symbol: Annotated[str | None, Query(max_length=128)] = None,
    before: Annotated[int | None, Query(ge=0)] = None,
    after: Annotated[int | None, Query(ge=0)] = None,
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
) -> al.LogPage:
    """Newest first. `before`/`after` are exclusive log ids."""
    q = select(m.AlertLog).order_by(m.AlertLog.id.desc()).limit(limit + 1)
    if alert_id is not None:
        q = q.where(m.AlertLog.alert_id == alert_id)
    if symbol is not None:
        q = q.where(m.AlertLog.symbol == symbol)
    if before is not None:
        q = q.where(m.AlertLog.id < before)
    if after is not None:
        q = q.where(m.AlertLog.id > after)
    rows = list(session.scalars(q))
    has_more = len(rows) > limit
    rows = rows[:limit]
    by_log: dict[int, list[m.AlertDelivery]] = {}
    if rows:
        dq = (
            select(m.AlertDelivery)
            .where(m.AlertDelivery.log_id.in_([r.id for r in rows]))
            .order_by(m.AlertDelivery.id)
        )
        for d in session.scalars(dq):
            by_log.setdefault(d.log_id, []).append(d)
    unread = session.scalar(select(func.count()).where(m.AlertLog.read.is_(False))) or 0
    return al.LogPage(
        entries=[al.log_entry(r, by_log.get(r.id, [])) for r in rows],
        has_more=has_more,
        unread=unread,
    )


@router.post("/log/read")
def read_log(session: SessionDep, hub: HubDep, body: al.LogRead) -> dict[str, int]:
    """Mark entries read (`upTo` inclusive and/or `ids`); returns the new unread total."""
    if body.up_to is None and not body.ids:
        raise HTTPException(422, "give 'upTo' and/or a non-empty 'ids'")
    cond = []
    if body.up_to is not None:
        cond.append(m.AlertLog.id <= body.up_to)
    if body.ids:
        cond.append(m.AlertLog.id.in_(body.ids))
    session.execute(
        update(m.AlertLog)
        .where(or_(*cond), m.AlertLog.read.is_(False))
        .values(read=True)
        .execution_options(synchronize_session=False)
    )
    unread = session.scalar(select(func.count()).where(m.AlertLog.read.is_(False))) or 0
    session.commit()
    frame: dict[str, Any] = {"type": "alerts.log"}
    if body.ids:
        frame["ids"] = body.ids
    if body.up_to is not None:
        frame["readUpTo"] = body.up_to
    hub.publish_threadsafe("alerts", frame)
    return {"unread": unread}


@router.delete("/log", status_code=204)
def clear_log(
    session: SessionDep,
    hub: HubDep,
    alert_id: Annotated[str | None, Query(alias="alertId", max_length=36)] = None,
) -> Response:
    """Delete log entries (and their deliveries): of one alert, or all."""
    ids_q = select(m.AlertLog.id)
    if alert_id is not None:
        ids_q = ids_q.where(m.AlertLog.alert_id == alert_id)
    ids = list(session.scalars(ids_q))
    # Deliveries first, so this does not rely on ON DELETE CASCADE being enforced.
    session.execute(delete(m.AlertDelivery).where(m.AlertDelivery.log_id.in_(ids)))
    session.execute(delete(m.AlertLog).where(m.AlertLog.id.in_(ids)))
    session.commit()
    frame: dict[str, Any] = {"type": "alerts.log", "cleared": True}
    if alert_id is not None:
        frame["alertId"] = alert_id
    hub.publish_threadsafe("alerts", frame)
    return Response(status_code=204)


@router.get("/channels", response_model=al.Channels)
def get_channels(settings: SettingsDep) -> al.Channels:
    """Which external channels are configured; URLs and addresses are masked."""
    recipients = smtp_recipients(settings)
    return al.Channels(
        webhook=al.WebhookChannel(
            configured=bool(settings.alerts_webhook_url), url=mask_url(settings.alerts_webhook_url)
        ),
        telegram=al.TelegramChannel(configured=channel_configured(settings, "telegram")),
        email=al.EmailChannel(
            configured=channel_configured(settings, "email"),
            to=", ".join(mask_email(a) for a in recipients) or None,
        ),
    )


@router.post("/channels/{channel}/test")
def test_channel(
    settings: SettingsDep,
    channel: Literal["webhook", "telegram", "email"],
    body: al.ChannelTest | None = None,
) -> dict[str, bool]:
    """Send one test message synchronously (no log entry). 400 if not configured, 502 on failure."""
    override = body.webhook_url if body is not None else None
    if channel == "webhook" and override:
        try:
            webhook.check_url(override, webhook_allow_private(settings, override))
        except DeliveryError as exc:
            raise HTTPException(422, f"webhookUrl: {exc}") from None
    if not channel_configured(settings, channel, override):
        raise HTTPException(400, f"{channel} is not configured")
    now = s.now()
    probe = m.AlertLog(
        id=0,
        fire_id="test",
        alert_id=None,
        alert_name="Test alert",
        symbol="TEST",
        interval="1D",
        kind="fired",
        fired_at=now,
        bar_time=int(now.timestamp()),
        message="InvestOpen test notification",
        values={},
        delayed=False,
        final=False,
        read=True,
    )
    try:
        if channel == "webhook":
            url = effective_url(settings, override)
            assert url is not None
            body_bytes, content_type = webhook_body(probe, raw=False)
            webhook.send(
                url,
                body_bytes,
                content_type,
                secret=settings.alerts_webhook_secret,
                allow_private=webhook_allow_private(settings, override),
            )
        elif channel == "telegram":
            assert settings.telegram_bot_token and settings.telegram_chat_id
            telegram.send(settings.telegram_bot_token, settings.telegram_chat_id, probe.message)
        else:
            subject, text = email_content(probe)
            email.send(settings, subject, text)
    except DeliveryError as exc:
        # Generic on purpose: the cause (refused, timeout, blocked...) would be a port-scan oracle.
        log.warning("%s test failed: %s", channel, exc)
        raise HTTPException(502, f"{channel} test failed; see the server log") from None
    return {"ok": True}


@router.post("/service/heartbeat", status_code=204, dependencies=ServiceOnly)
def heartbeat(state: ServiceStateDep, body: al.ServiceHeartbeat) -> Response:
    state.heartbeat, state.last_at = body, s.now()
    return Response(status_code=204)


@router.get("/service")
def get_service(state: ServiceStateDep) -> dict[str, Any]:
    """Last heartbeat plus `online` (heartbeat less than 90 s old)."""
    if state.heartbeat is None or state.last_at is None:
        return {"online": False}
    return {
        **state.heartbeat.model_dump(mode="json", by_alias=True),
        "online": s.now() - state.last_at < ONLINE_WITHIN,
        "lastHeartbeatAt": iso(state.last_at),
    }


# --------------------------------------------------------------------- CRUD


@router.get("", response_model=list[al.Alert])
def list_alerts(
    session: SessionDep,
    hub: HubDep,
    status: Annotated[al.Status | None, Query()] = None,
    symbol: Annotated[str | None, Query(max_length=128)] = None,
) -> list[al.Alert]:
    """All alerts, newest first."""
    _sweep_expired(session, hub)
    q = select(m.Alert).order_by(m.Alert.created_at.desc(), m.Alert.id)
    if status is not None:
        q = q.where(m.Alert.status == status)
    if symbol is not None:
        q = q.where(m.Alert.symbol == symbol)
    return [al.alert_out(r) for r in session.scalars(q)]


@router.post("", response_model=al.Alert, status_code=201)
def create_alert(
    session: SessionDep, hub: HubDep, settings: SettingsDep, body: al.AlertIn
) -> al.Alert:
    """409 (with the stored alert) if a client-chosen `id` already exists."""
    _check_webhook(settings, body.notify)
    aid = body.id or s.new_id()
    existing = session.get(m.Alert, aid)
    if existing is not None:
        raise _conflict(existing)
    if (session.scalar(select(func.count()).select_from(m.Alert)) or 0) >= al.MAX_ALERTS:
        raise HTTPException(422, f"at most {al.MAX_ALERTS} alerts")
    status = body.status or "active"
    expires_at = _expiry(body.expires_at)
    _require_future(status, expires_at)
    _check_drawings(session, body.symbol, body.spec)
    t = s.now()
    row = m.Alert(
        id=aid,
        name=body.name,
        symbol=body.symbol,
        interval=body.interval,
        prepost=body.prepost,
        spec=al.dump_spec(body.spec),
        schema_version=al.ALERT_SCHEMA_VERSION,
        message=body.message,
        notify=al.dump_notify(body.notify),
        status=status,
        status_reason=None,
        expires_at=expires_at,
        drawing_id=al.derive_drawing_id(body.spec),
        revision=1,
        fire_count=0,
        last_fired_at=None,
        created_at=t,
        updated_at=t,
    )
    session.add(row)
    try:
        session.commit()
    except IntegrityError:
        session.rollback()
        winner = session.get(m.Alert, aid)
        if winner is None:
            raise
        raise _conflict(winner) from None
    _changed(hub, [aid])
    return al.alert_out(row)


@router.get("/{alert_id}", response_model=al.Alert)
def get_alert(session: SessionDep, hub: HubDep, alert_id: str) -> al.Alert:
    _sweep_expired(session, hub)
    return al.alert_out(_get(session, alert_id))


@router.put("/{alert_id}", response_model=al.Alert)
def update_alert(
    session: SessionDep, hub: HubDep, settings: SettingsDep, alert_id: str, body: al.AlertUpdate
) -> al.Alert:
    """Replace all editable fields. 409 (with the stored alert) if `revision` is given and stale.

    Bumps the revision, drops the runtime state and clears the status reason. `triggered`,
    `expired` and `error` alerts become `active` unless the body says `paused`.
    """
    if body.id is not None and body.id != alert_id:
        raise HTTPException(422, "id in the body does not match the URL")
    _check_webhook(settings, body.notify)
    row = _get(session, alert_id)
    expires_at = _expiry(body.expires_at)
    kept = "paused" if row.status == "paused" else "active"
    _require_future(body.status or kept, expires_at)
    _check_drawings(session, body.symbol, body.spec)
    cond = [m.Alert.id == alert_id]
    if body.revision is not None:
        cond.append(m.Alert.revision == body.revision)
    status: Any = body.status or case((m.Alert.status == "paused", "paused"), else_="active")
    stmt = (
        update(m.Alert)
        .where(*cond)
        .values(
            name=body.name,
            symbol=body.symbol,
            interval=body.interval,
            prepost=body.prepost,
            spec=al.dump_spec(body.spec),
            schema_version=al.ALERT_SCHEMA_VERSION,
            message=body.message,
            notify=al.dump_notify(body.notify),
            status=status,
            status_reason=None,
            expires_at=expires_at,
            drawing_id=al.derive_drawing_id(body.spec),
            revision=m.Alert.revision + 1,
            updated_at=s.now(),
        )
        .execution_options(synchronize_session=False)
    )
    if store.rowcount(session.execute(stmt)) != 1:
        session.rollback()
        raise _conflict(_get(session, alert_id))
    session.execute(delete(m.AlertState).where(m.AlertState.alert_id == alert_id))
    out = store.reload(session, m.Alert, alert_id)
    session.commit()
    _changed(hub, [alert_id])
    return al.alert_out(out)


@router.patch("/{alert_id}", response_model=al.Alert)
def patch_alert(session: SessionDep, hub: HubDep, alert_id: str, body: al.AlertPatch) -> al.Alert:
    """Pause or restart (`active` from any status; keeps `fireCount`, drops the state)."""
    row = _get(session, alert_id)
    set_expiry = "expires_at" in body.model_fields_set
    expires_at = _expiry(body.expires_at) if set_expiry else row.expires_at
    _require_future(body.status, None if expires_at is None else al.utc(expires_at))
    cond = [m.Alert.id == alert_id]
    if body.revision is not None:
        cond.append(m.Alert.revision == body.revision)
    values: dict[str, Any] = {
        "status": body.status,
        "status_reason": None,
        "revision": m.Alert.revision + 1,
        "updated_at": s.now(),
    }
    if set_expiry:
        values["expires_at"] = expires_at
    stmt = (
        update(m.Alert).where(*cond).values(**values).execution_options(synchronize_session=False)
    )
    if store.rowcount(session.execute(stmt)) != 1:
        session.rollback()
        raise _conflict(_get(session, alert_id))
    session.execute(delete(m.AlertState).where(m.AlertState.alert_id == alert_id))
    out = store.reload(session, m.Alert, alert_id)
    session.commit()
    _changed(hub, [alert_id])
    return al.alert_out(out)


@router.delete("/{alert_id}", status_code=204)
def delete_alert(session: SessionDep, hub: HubDep, alert_id: str) -> Response:
    """Log entries stay (the log outlives the alert)."""
    row = _get(session, alert_id)
    session.execute(delete(m.AlertState).where(m.AlertState.alert_id == alert_id))
    session.delete(row)
    session.commit()
    _changed(hub, [], [alert_id])
    return Response(status_code=204)


@router.post("/{alert_id}/status", response_model=al.Alert, dependencies=ServiceOnly)
def set_status(session: SessionDep, hub: HubDep, alert_id: str, body: al.AlertStatusIn) -> al.Alert:
    """Service marks an alert `expired`/`error`. Conditional on `revision` and `active` (409)."""
    stmt = (
        update(m.Alert)
        .where(
            m.Alert.id == alert_id, m.Alert.revision == body.revision, m.Alert.status == "active"
        )
        .values(
            status=body.status,
            status_reason=body.reason or None,
            revision=m.Alert.revision + 1,
            updated_at=s.now(),
        )
        .execution_options(synchronize_session=False)
    )
    if store.rowcount(session.execute(stmt)) != 1:
        session.rollback()
        raise _conflict(_get(session, alert_id))
    out = store.reload(session, m.Alert, alert_id)
    session.commit()
    _changed(hub, [alert_id])
    return al.alert_out(out)


@router.post("/{alert_id}/fire", response_model=al.AlertLogEntry, dependencies=ServiceOnly)
def fire_alert(
    session: SessionDep,
    hub: HubDep,
    dispatcher: DispatcherDep,
    settings: SettingsDep,
    alert_id: str,
    body: al.FireIn,
) -> al.AlertLogEntry:
    """Record a fire in one transaction (see docs/alerts.md §1.5).

    Idempotent per `fireId`. 409 (with the stored alert) if the alert was paused, edited,
    expired or finished since the evaluator read it; the service then reloads.
    """
    # Not this alert: a retried fire with firedAt < expiresAt must be judged by the UPDATE's own
    # `expires_at > firedAt`, not lost to a sweep that ran first.
    _sweep_expired(session, hub, skip=alert_id)
    prior = session.scalar(select(m.AlertLog).where(m.AlertLog.fire_id == body.fire_id))
    if prior is not None:
        return _entry(session, prior)

    fired_at = al.utc(body.fired_at)
    values: dict[str, Any] = {
        "fire_count": m.Alert.fire_count + 1,
        "last_fired_at": fired_at,
    }
    if body.final:
        values.update(status="triggered", revision=m.Alert.revision + 1)
    stmt = (
        update(m.Alert)
        .where(
            m.Alert.id == alert_id,
            m.Alert.revision == body.revision,
            m.Alert.status == "active",
            or_(m.Alert.expires_at.is_(None), m.Alert.expires_at > fired_at),
        )
        .values(**values)
        .execution_options(synchronize_session=False)
    )
    if store.rowcount(session.execute(stmt)) != 1:
        session.rollback()
        _sweep_expired(session, hub)  # now it may expire, so the 409 carries the stored state
        raise _conflict(_get(session, alert_id))
    alert = store.reload(session, m.Alert, alert_id)

    log = m.AlertLog(
        fire_id=body.fire_id,
        alert_id=alert.id,
        alert_name=alert.name,
        symbol=alert.symbol,
        interval=alert.interval,
        kind="fired",
        fired_at=fired_at,
        bar_time=body.bar_time,
        message=body.message,
        values=body.values,
        delayed=body.delayed,
        final=body.final,
        read=False,
    )
    session.add(log)
    try:
        session.flush()
    except IntegrityError:
        # A concurrent retry logged this fireId first: that one wins, nothing else happens.
        session.rollback()
        winner = session.scalar(select(m.AlertLog).where(m.AlertLog.fire_id == body.fire_id))
        if winner is None:
            raise
        return _entry(session, winner)

    notify = al.AlertNotify.model_validate(alert.notify)
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

    # Same rule as PUT /alerts/states: after a final fire's revision bump this is ignored.
    if body.state is not None and alert.revision == body.revision:
        srow = session.get(m.AlertState, alert.id)
        if srow is None:
            session.add(
                m.AlertState(
                    alert_id=alert.id, revision=body.revision, state=body.state, updated_at=t
                )
            )
        else:
            srow.revision, srow.state, srow.updated_at = body.revision, body.state, t

    _prune_log(session, settings.alerts_log_max)
    session.commit()

    entry = _entry(session, log)
    hub.publish_threadsafe(
        "alerts",
        {
            "type": "alert.fired",
            "entry": entry.model_dump(mode="json", by_alias=True),
            "alert": {
                "id": alert.id,
                "status": alert.status,
                "revision": alert.revision,
                "fireCount": alert.fire_count,
                "lastFiredAt": iso(fired_at),
            },
        },
    )
    if body.final:
        _changed(hub, [alert.id])
    dispatcher.wake()
    return entry


def _prune_log(session: SessionDep, keep: int) -> None:
    """Keep the newest `keep` log entries (deliveries go with them)."""
    cutoff = session.scalar(
        select(m.AlertLog.id).order_by(m.AlertLog.id.desc()).offset(max(keep, 1)).limit(1)
    )
    if cutoff is None:
        return
    session.execute(delete(m.AlertDelivery).where(m.AlertDelivery.log_id <= cutoff))
    session.execute(delete(m.AlertLog).where(m.AlertLog.id <= cutoff))
