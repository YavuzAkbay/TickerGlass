"""Notes: general (symbol null) or per symbol."""

from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Response
from sqlalchemy import select, update

from .. import models as m
from ..deps import SessionDep
from ..userdata import schemas as s
from ..userdata import store

router = APIRouter(prefix="/notes", tags=["notes"])


def _get(session: SessionDep, note_id: str) -> m.Note:
    row = session.get(m.Note, note_id)
    if row is None:
        raise HTTPException(404, f"note not found: {note_id}")
    return row


@router.get("", response_model=list[s.Note])
def list_notes(
    session: SessionDep, symbol: Annotated[str | None, Query(max_length=32)] = None
) -> list[s.Note]:
    """All notes (oldest first), or only those of `symbol`."""
    q = select(m.Note).order_by(m.Note.created_at, m.Note.id)
    if symbol is not None:
        q = q.where(m.Note.symbol == symbol.strip().upper())
    return [store.note(r) for r in session.scalars(q)]


@router.post("", response_model=s.Note, status_code=201)
def create_note(session: SessionDep, body: s.NoteIn) -> s.Note:
    t = s.now()
    row = m.Note(
        id=s.new_id(), symbol=body.symbol, text=body.text, revision=1, created_at=t, updated_at=t
    )
    session.add(row)
    session.commit()
    return store.note(row)


@router.get("/{note_id}", response_model=s.Note)
def get_note(session: SessionDep, note_id: str) -> s.Note:
    return store.note(_get(session, note_id))


@router.put("/{note_id}", response_model=s.Note)
def update_note(session: SessionDep, note_id: str, body: s.NoteUpdate) -> s.Note:
    """409 (with the stored note) if `revision` is given and stale.

    Check and write are one conditional UPDATE (no lost updates under concurrency).
    """
    cond = [m.Note.id == note_id]
    if body.revision is not None:
        cond.append(m.Note.revision == body.revision)
    stmt = (
        update(m.Note)
        .where(*cond)
        .values(
            symbol=body.symbol, text=body.text, revision=m.Note.revision + 1, updated_at=s.now()
        )
        .execution_options(synchronize_session=False)
    )
    if store.rowcount(session.execute(stmt)) != 1:
        session.rollback()
        row = _get(session, note_id)
        raise HTTPException(
            409,
            {
                "message": f"note {note_id} changed elsewhere",
                "current": store.note(row).model_dump(mode="json", by_alias=True),
            },
        )
    row = store.reload(session, m.Note, note_id)
    session.commit()
    return store.note(row)


@router.delete("/{note_id}", status_code=204)
def delete_note(session: SessionDep, note_id: str) -> Response:
    session.delete(_get(session, note_id))
    session.commit()
    return Response(status_code=204)
