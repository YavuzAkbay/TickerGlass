"""Drawings: one row per drawing, batch writes with per-drawing revisions."""

from typing import Annotated

from fastapi import APIRouter, HTTPException, Query
from sqlalchemy import or_, select

from .. import models as m
from ..deps import SessionDep
from ..userdata import schemas as s
from ..userdata import store

router = APIRouter(prefix="/drawings", tags=["drawings"])


@router.get("", response_model=s.DrawingList)
def list_drawings(
    session: SessionDep,
    symbol: Annotated[str | None, Query(max_length=32)] = None,
    synced: bool = True,
) -> s.DrawingList:
    """All drawings, or those of `symbol` plus (unless `synced=false`) the synced ones."""
    q = select(m.DrawingRow).order_by(m.DrawingRow.z, m.DrawingRow.id)
    if symbol is not None:
        sym = symbol.strip().upper()
        cond = m.DrawingRow.symbol == sym
        q = q.where(or_(cond, m.DrawingRow.symbol.is_(None)) if synced else cond)
    return s.DrawingList(drawings=[store.drawing(r) for r in session.scalars(q)])


@router.post("/batch", response_model=s.DrawingBatchResult)
def batch(session: SessionDep, body: s.DrawingBatch) -> s.DrawingBatchResult:
    """Upsert and delete in one transaction; all-or-nothing.

    Each upsert carries the revision it was based on (null = new); each delete
    optionally does. Any mismatch fails the whole batch with 409 and
    `conflicts` (the stored copy of each conflicting drawing). `force` skips
    the checks.
    """
    parsed: list[tuple[s.DrawingUpsert, tuple[str, str | None, str, int]]] = []
    for up in body.upserts:
        try:
            parsed.append((up, store.drawing_fields(up.drawing)))
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
    ids = [f[0] for _, f in parsed] + [d.id for d in body.deletes]
    if len(set(ids)) != len(ids):
        raise HTTPException(422, "a drawing id appears more than once in the batch")

    rows = {r.id: r for r in session.scalars(select(m.DrawingRow).where(m.DrawingRow.id.in_(ids)))}
    if not body.force:
        conflicts: list[s.DrawingConflict] = []
        checks = [(f[0], up.base_revision, True) for up, f in parsed] + [
            (d.id, d.base_revision, False) for d in body.deletes
        ]
        for did, base, is_upsert in checks:
            row = rows.get(did)
            if is_upsert:
                ok = row.revision == base if row is not None else base is None
            else:
                ok = base is None or row is None or row.revision == base
            if not ok:
                conflicts.append(
                    s.DrawingConflict(
                        id=did,
                        revision=None if row is None else row.revision,
                        drawing=None if row is None else store.drawing(row),
                    )
                )
        if conflicts:
            raise HTTPException(
                409,
                {
                    "message": f"{len(conflicts)} drawing(s) changed elsewhere",
                    "conflicts": [c.model_dump(mode="json", by_alias=True) for c in conflicts],
                },
            )

    t = s.now()
    out: list[m.DrawingRow] = []
    for up, (did, symbol, pane, z) in parsed:
        row = rows.get(did)
        if row is None:
            row = m.DrawingRow(id=did, revision=0)
            session.add(row)
        row.symbol, row.pane_id, row.z, row.data = symbol, pane, z, up.drawing
        row.schema_version = body.schema_version
        row.revision += 1
        row.updated_at = t
        out.append(row)
    deleted: list[str] = []
    for d in body.deletes:
        row = rows.get(d.id)
        if row is not None:
            session.delete(row)
            deleted.append(d.id)
    session.commit()
    return s.DrawingBatchResult(drawings=[store.drawing(r) for r in out], deleted=deleted)
