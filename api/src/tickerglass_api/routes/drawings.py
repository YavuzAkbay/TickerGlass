"""Drawings: one row per drawing, batch writes with per-drawing revisions."""

from typing import Annotated

from fastapi import APIRouter, HTTPException, Query
from sqlalchemy import delete, func, insert, or_, select, update
from sqlalchemy.exc import IntegrityError

from .. import models as m
from ..deps import HubDep, SessionDep
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


Parsed = list[tuple[s.DrawingUpsert, tuple[str, str | None, str, int]]]


def _conflict_error(conflicts: list[s.DrawingConflict]) -> HTTPException:
    return HTTPException(
        409,
        {
            "message": f"{len(conflicts)} drawing(s) changed elsewhere",
            "conflicts": [c.model_dump(mode="json", by_alias=True) for c in conflicts],
        },
    )


def _conflict(did: str, row: m.DrawingRow | None) -> s.DrawingConflict:
    return s.DrawingConflict(
        id=did,
        revision=None if row is None else row.revision,
        drawing=None if row is None else store.drawing(row),
    )


def _apply(
    session: SessionDep, body: s.DrawingBatch, parsed: Parsed, rows: dict[str, m.DrawingRow]
) -> tuple[list[str], list[str]]:
    """Write the batch with conditional statements. Returns (deleted ids, lost ids):
    a lost id is one whose stored copy changed after the pre-check (a concurrent
    writer); the caller then rolls everything back."""
    t = s.now()
    lost: list[str] = []
    for up, (did, symbol, pane, z) in parsed:
        values: dict[str, object] = {
            "symbol": symbol,
            "pane_id": pane,
            "z": z,
            "data": up.drawing,
            "schema_version": body.schema_version,
            "updated_at": t,
        }
        row = rows.get(did)
        if row is not None:
            cond = [m.DrawingRow.id == did]
            if not body.force:
                cond.append(m.DrawingRow.revision == row.revision)
            stmt = (
                update(m.DrawingRow)
                .where(*cond)
                .values(revision=m.DrawingRow.revision + 1, **values)
                .execution_options(synchronize_session=False)
            )
            if store.rowcount(session.execute(stmt)) == 1:
                continue
            if not body.force:
                lost.append(did)
                continue
            # force, and it was deleted meanwhile: create it again.
        try:
            session.execute(insert(m.DrawingRow).values(id=did, revision=1, **values))
        except IntegrityError:
            # Created concurrently. On Postgres the transaction is now unusable: stop here.
            lost.append(did)
            return [], lost

    deleted: list[str] = []
    for d in body.deletes:
        cond = [m.DrawingRow.id == d.id]
        checked = d.base_revision is not None and not body.force
        if checked:
            cond.append(m.DrawingRow.revision == d.base_revision)
        dstmt = delete(m.DrawingRow).where(*cond).execution_options(synchronize_session=False)
        if store.rowcount(session.execute(dstmt)) == 1:
            deleted.append(d.id)
        elif checked and session.scalar(select(func.count()).where(m.DrawingRow.id == d.id)):
            lost.append(d.id)
    return deleted, lost


@router.post("/batch", response_model=s.DrawingBatchResult)
def batch(session: SessionDep, hub: HubDep, body: s.DrawingBatch) -> s.DrawingBatchResult:
    """Upsert and delete in one transaction; all-or-nothing.

    Each upsert carries the revision it was based on (null = new); each delete
    optionally does. Any mismatch fails the whole batch with 409 and
    `conflicts` (the stored copy of each conflicting drawing). `force` skips
    the checks. Writes are conditional on the revision read, so a writer that
    commits between the check and the write also yields a 409, never a lost update.
    """
    parsed: Parsed = []
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
                conflicts.append(_conflict(did, row))
        if conflicts:
            raise _conflict_error(conflicts)

    deleted, lost = _apply(session, body, parsed, rows)
    if lost:
        session.rollback()
        stored = {
            r.id: r for r in session.scalars(select(m.DrawingRow).where(m.DrawingRow.id.in_(lost)))
        }
        raise _conflict_error([_conflict(did, stored.get(did)) for did in lost])
    written = [f[0] for _, f in parsed]
    q = (
        select(m.DrawingRow)
        .where(m.DrawingRow.id.in_(written))
        .execution_options(populate_existing=True)
    )
    by_id = {r.id: r for r in session.scalars(q)}
    out = [by_id[did] for did in written]
    session.commit()
    if written or deleted:
        hub.publish_threadsafe(
            "drawings", {"type": "drawings.changed", "ids": written, "deleted": deleted}
        )
    return s.DrawingBatchResult(drawings=[store.drawing(r) for r in out], deleted=deleted)
