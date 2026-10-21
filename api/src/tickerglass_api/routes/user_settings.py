"""User settings: one JSON value per key (last writer wins per key)."""

from typing import Annotated, Any

from fastapi import APIRouter, Body, HTTPException, Response
from pydantic import ValidationError
from sqlalchemy import select

from .. import models as m
from ..deps import SessionDep
from ..userdata import schemas as s

router = APIRouter(prefix="/settings", tags=["settings"])

MAX_PATCH_KEYS = 1000


def _key(key: str) -> str:
    try:
        return s.check_setting_key(key)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


def _all(session: SessionDep) -> dict[str, Any]:
    return {r.key: r.value for r in session.scalars(select(m.Setting).order_by(m.Setting.key))}


def _put(session: SessionDep, key: str, value: Any) -> None:
    row = session.get(m.Setting, key)
    if row is None:
        session.add(m.Setting(key=key, value=value, updated_at=s.now()))
    else:
        row.value, row.updated_at = value, s.now()


@router.get("")
def get_settings(session: SessionDep) -> dict[str, Any]:
    return _all(session)


@router.patch("")
def patch_settings(session: SessionDep, body: Annotated[dict[str, Any], Body()]) -> dict[str, Any]:
    """Set several keys at once; a null value deletes the key. Returns all settings."""
    if len(body) > MAX_PATCH_KEYS:
        raise HTTPException(422, f"at most {MAX_PATCH_KEYS} keys per request")
    for key, value in body.items():
        _key(key)
        if value is None:
            row = session.get(m.Setting, key)
            if row is not None:
                session.delete(row)
            continue
        try:
            s.SettingIn(value=value)
        except ValidationError as exc:
            raise HTTPException(422, f"setting {key}: {exc.errors()[0]['msg']}") from exc
        _put(session, key, value)
    session.commit()
    return _all(session)


@router.get("/{key}")
def get_setting(session: SessionDep, key: str) -> Any:
    row = session.get(m.Setting, _key(key))
    if row is None:
        raise HTTPException(404, f"setting not found: {key}")
    return row.value


@router.put("/{key}", status_code=204)
def put_setting(session: SessionDep, key: str, body: s.SettingIn) -> Response:
    if body.value is None:
        raise HTTPException(422, "value must not be null (DELETE the key instead)")
    _put(session, _key(key), body.value)
    session.commit()
    return Response(status_code=204)


@router.delete("/{key}", status_code=204)
def delete_setting(session: SessionDep, key: str) -> Response:
    row = session.get(m.Setting, _key(key))
    if row is not None:
        session.delete(row)
        session.commit()
    return Response(status_code=204)
