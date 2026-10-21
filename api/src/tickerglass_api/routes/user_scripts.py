"""User indicator scripts (client-chosen ids, whole-script revisions)."""

from fastapi import APIRouter, HTTPException, Response
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError

from .. import models as m
from ..deps import SessionDep
from ..userdata import schemas as s
from ..userdata import store

router = APIRouter(prefix="/user-scripts", tags=["user-scripts"])


def _get(session: SessionDep, script_id: str) -> m.UserScript:
    row = session.get(m.UserScript, script_id)
    if row is None:
        raise HTTPException(404, f"user script not found: {script_id}")
    return row


def _conflict(row: m.UserScript) -> HTTPException:
    return HTTPException(
        409,
        {
            "message": f"user script {row.id} changed elsewhere",
            "current": store.user_script(row).model_dump(mode="json", by_alias=True),
        },
    )


@router.get("", response_model=list[s.UserScript])
def list_user_scripts(session: SessionDep) -> list[s.UserScript]:
    """All scripts including sources (oldest first)."""
    q = select(m.UserScript).order_by(m.UserScript.created_at, m.UserScript.id)
    return [store.user_script(r) for r in session.scalars(q)]


@router.post("", response_model=s.UserScript, status_code=201)
def create_user_script(session: SessionDep, body: s.UserScriptIn) -> s.UserScript:
    """409 (with the stored script) if a client-chosen `id` already exists."""
    sid = body.id or s.new_id()
    existing = session.get(m.UserScript, sid)
    if existing is not None:
        raise _conflict(existing)
    t = s.now()
    row = m.UserScript(
        id=sid,
        name=body.name,
        source=body.source,
        manifest=body.manifest,
        api_version=body.api_version,
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
        winner = session.get(m.UserScript, sid)
        if winner is None:
            raise
        raise _conflict(winner) from None
    return store.user_script(row)


@router.get("/{script_id}", response_model=s.UserScript)
def get_user_script(session: SessionDep, script_id: str) -> s.UserScript:
    return store.user_script(_get(session, script_id))


@router.put("/{script_id}", response_model=s.UserScript)
def update_user_script(
    session: SessionDep, script_id: str, body: s.UserScriptUpdate
) -> s.UserScript:
    """409 (with the stored script) if `revision` is given and stale.

    Check and write are one conditional UPDATE (no lost updates under concurrency).
    """
    cond = [m.UserScript.id == script_id]
    if body.revision is not None:
        cond.append(m.UserScript.revision == body.revision)
    stmt = (
        update(m.UserScript)
        .where(*cond)
        .values(
            name=body.name,
            source=body.source,
            manifest=body.manifest,
            api_version=body.api_version,
            revision=m.UserScript.revision + 1,
            updated_at=s.now(),
        )
        .execution_options(synchronize_session=False)
    )
    if store.rowcount(session.execute(stmt)) != 1:
        session.rollback()
        raise _conflict(_get(session, script_id))
    row = store.reload(session, m.UserScript, script_id)
    session.commit()
    return store.user_script(row)


@router.delete("/{script_id}", status_code=204)
def delete_user_script(session: SessionDep, script_id: str) -> Response:
    session.delete(_get(session, script_id))
    session.commit()
    return Response(status_code=204)
