"""Saved screens (whole-screen revisions, client-chosen ids) and the built-in presets.
Mirrors `routes/watchlists.py`; the scan itself lives in `routes/screener.py`."""

import copy
from typing import Any

from fastapi import APIRouter, HTTPException, Response
from sqlalchemy import delete, func, select, update
from sqlalchemy.exc import IntegrityError

from .. import models as m
from ..deps import SessionDep, SettingsDep
from ..notifications import DeliveryError, webhook, webhook_allow_private
from ..services.screener.presets import PRESETS
from ..settings import Settings
from ..userdata import schemas as s
from ..userdata import screens as sc
from ..userdata import store

router = APIRouter(prefix="/screener", tags=["screener"])


def _get(session: SessionDep, screen_id: str) -> m.Screen:
    row = session.get(m.Screen, screen_id)
    if row is None:
        raise HTTPException(404, f"screen not found: {screen_id}")
    return row


def _conflict(row: m.Screen) -> HTTPException:
    return HTTPException(
        409,
        {
            "message": f"screen {row.id} changed elsewhere",
            "current": sc.screen_out(row).model_dump(mode="json", by_alias=True),
        },
    )


def _check_webhook(settings: Settings, alert: sc.ScreenAlert | None) -> None:
    """422 for a per-screen webhook URL the SSRF guard would refuse at send time."""
    url = alert.notify.webhook_url if alert is not None else None
    if not url:
        return
    try:
        webhook.check_url(url, webhook_allow_private(settings, url))
    except DeliveryError as exc:
        raise HTTPException(422, f"webhookUrl: {exc}") from None


def _reset_state(session: SessionDep, screen_id: str) -> None:
    """Forget the last members: the next evaluation is a baseline (no alert burst)."""
    session.execute(delete(m.ScreenState).where(m.ScreenState.screen_id == screen_id))


@router.get("/presets", response_model=list[sc.Preset])
def list_presets() -> list[sc.Preset]:
    """Built-in screens (templates; save one to keep it)."""
    return [sc.Preset(**copy.deepcopy(p)) for p in PRESETS]


@router.get("/screens", response_model=list[sc.Screen])
def list_screens(session: SessionDep) -> list[sc.Screen]:
    """All saved screens (oldest first)."""
    q = select(m.Screen).order_by(m.Screen.created_at, m.Screen.id)
    return [sc.screen_out(r) for r in session.scalars(q)]


@router.post("/screens", response_model=sc.Screen, status_code=201)
def create_screen(session: SessionDep, settings: SettingsDep, body: sc.ScreenIn) -> sc.Screen:
    """409 (with the stored screen) if a client-chosen `id` already exists."""
    _check_webhook(settings, body.alert)
    sid = body.id or s.new_id()
    existing = session.get(m.Screen, sid)
    if existing is not None:
        raise _conflict(existing)
    if (session.scalar(select(func.count()).select_from(m.Screen)) or 0) >= sc.MAX_SCREENS:
        raise HTTPException(422, f"at most {sc.MAX_SCREENS} screens")
    t = s.now()
    row = m.Screen(
        id=sid,
        name=body.name,
        spec=sc.dump_spec(body.spec),
        schema_version=sc.SCREEN_SCHEMA_VERSION,
        alert=sc.dump_alert(body.alert),
        revision=1,
        created_at=t,
        updated_at=t,
    )
    session.add(row)
    try:
        session.commit()
    except IntegrityError:
        # A concurrent POST claimed this id between our check and insert.
        session.rollback()
        winner = session.get(m.Screen, sid)
        if winner is None:
            raise
        raise _conflict(winner) from None
    return sc.screen_out(row)


@router.get("/screens/{screen_id}", response_model=sc.Screen)
def get_screen(session: SessionDep, screen_id: str) -> sc.Screen:
    return sc.screen_out(_get(session, screen_id))


def _write(
    session: SessionDep,
    screen_id: str,
    revision: int | None,
    values: dict[str, Any],
    *,
    reset: bool,
) -> sc.Screen:
    """One conditional UPDATE (no lost updates under concurrency); 409 if stale."""
    cond = [m.Screen.id == screen_id]
    if revision is not None:
        cond.append(m.Screen.revision == revision)
    stmt = (
        update(m.Screen)
        .where(*cond)
        .values(**values, revision=m.Screen.revision + 1, updated_at=s.now())
        .execution_options(synchronize_session=False)
    )
    if store.rowcount(session.execute(stmt)) != 1:
        session.rollback()
        raise _conflict(_get(session, screen_id))
    if reset:
        _reset_state(session, screen_id)
    row = store.reload(session, m.Screen, screen_id)
    session.commit()
    return sc.screen_out(row)


def _needs_baseline(old: m.Screen, spec: dict[str, Any], alert: dict[str, Any] | None) -> bool:
    """A changed spec, or an alert switched on, starts from a fresh baseline."""
    return old.spec != spec or (sc.alert_enabled(alert) and not sc.alert_enabled(old.alert))


@router.put("/screens/{screen_id}", response_model=sc.Screen)
def update_screen(
    session: SessionDep, settings: SettingsDep, screen_id: str, body: sc.ScreenUpdate
) -> sc.Screen:
    """409 (with the stored screen) if `revision` is given and stale."""
    _check_webhook(settings, body.alert)
    old = _get(session, screen_id)
    spec = sc.dump_spec(body.spec)
    alert = sc.dump_alert(body.alert)
    return _write(
        session,
        screen_id,
        body.revision,
        {
            "name": body.name,
            "spec": spec,
            "schema_version": sc.SCREEN_SCHEMA_VERSION,
            "alert": alert,
        },
        reset=_needs_baseline(old, spec, alert),
    )


@router.patch("/screens/{screen_id}", response_model=sc.Screen)
def patch_screen(
    session: SessionDep, settings: SettingsDep, screen_id: str, body: sc.ScreenPatch
) -> sc.Screen:
    """Change only the given keys (`alert: null` removes the alert); 409 if `revision` is stale."""
    given = body.model_fields_set
    if "alert" in given:
        _check_webhook(settings, body.alert)
    old = _get(session, screen_id)
    values: dict[str, Any] = {}
    spec = old.spec
    alert = old.alert
    if body.name is not None:
        values["name"] = body.name
    if body.spec is not None:
        spec = sc.dump_spec(body.spec)
        values["spec"], values["schema_version"] = spec, sc.SCREEN_SCHEMA_VERSION
    if "alert" in given:
        alert = sc.dump_alert(body.alert)
        values["alert"] = alert
    return _write(
        session,
        screen_id,
        body.revision,
        values,
        reset=_needs_baseline(old, spec, alert),
    )


@router.delete("/screens/{screen_id}", status_code=204)
def delete_screen(session: SessionDep, screen_id: str) -> Response:
    row = _get(session, screen_id)
    _reset_state(session, screen_id)
    session.delete(row)
    session.commit()
    return Response(status_code=204)
