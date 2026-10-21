"""Named chart layouts with optimistic concurrency (docs/persistence.md)."""

from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Response
from sqlalchemy import select, update

from .. import models as m
from ..deps import SessionDep
from ..userdata import schemas as s
from ..userdata import store

router = APIRouter(prefix="/layouts", tags=["layouts"])


def _get(session: SessionDep, layout_id: str) -> m.Layout:
    row = session.get(m.Layout, layout_id)
    if row is None:
        raise HTTPException(404, f"layout not found: {layout_id}")
    return row


def _create(session: SessionDep, name: str, state: dict[str, object], version: int) -> m.Layout:
    t = s.now()
    row = m.Layout(
        id=s.new_id(),
        name=name,
        state=state,
        schema_version=version,
        revision=1,
        is_last_used=False,
        created_at=t,
        updated_at=t,
    )
    session.add(row)
    session.commit()
    return row


@router.get("", response_model=list[s.LayoutSummary])
def list_layouts(session: SessionDep) -> list[s.LayoutSummary]:
    """Summaries (no state), most recently updated first."""
    rows = session.scalars(select(m.Layout).order_by(m.Layout.updated_at.desc(), m.Layout.id))
    return [store.layout_summary(r) for r in rows]


@router.post("", response_model=s.Layout, status_code=201)
def create_layout(session: SessionDep, body: s.LayoutCreate) -> s.Layout:
    """Create (also "save as": post the current state under a new name)."""
    return store.layout(_create(session, body.name, body.state, body.schema_version))


@router.get("/last-used", response_model=s.Layout | None)
def get_last_used(session: SessionDep) -> s.Layout | None:
    """The layout to restore on startup, or null."""
    row = session.scalar(select(m.Layout).where(m.Layout.is_last_used.is_(True)))
    return None if row is None else store.layout(row)


@router.put("/last-used", status_code=204)
def set_last_used(session: SessionDep, body: s.LastUsed) -> Response:
    _get(session, body.id)
    store.set_last_used(session, body.id)
    session.commit()
    return Response(status_code=204)


@router.post("/import", response_model=s.Layout, status_code=201)
def import_layout(
    session: SessionDep,
    body: s.LayoutExport,
    name: Annotated[str | None, Query(min_length=1, max_length=200)] = None,
) -> s.Layout:
    """Create a new layout from a single-layout export file."""
    if not 1 <= body.version <= s.BUNDLE_VERSION:
        raise HTTPException(422, f"unsupported layout file version {body.version}")
    doc = body.layout
    return store.layout(_create(session, name or doc.name, doc.state, doc.schema_version))


@router.get("/{layout_id}", response_model=s.Layout)
def get_layout(session: SessionDep, layout_id: str) -> s.Layout:
    return store.layout(_get(session, layout_id))


@router.put("/{layout_id}", response_model=s.Layout)
def save_layout(session: SessionDep, layout_id: str, body: s.LayoutSave) -> s.Layout:
    """Overwrite the state. 409 (with the stored layout) unless `revision` is current.

    The revision check and the write are one conditional UPDATE, so two writers
    based on the same revision cannot both succeed.
    """
    stmt = (
        update(m.Layout)
        .where(m.Layout.id == layout_id, m.Layout.revision == body.revision)
        .values(
            state=body.state,
            schema_version=body.schema_version,
            revision=m.Layout.revision + 1,
            updated_at=s.now(),
        )
        .execution_options(synchronize_session=False)
    )
    if store.rowcount(session.execute(stmt)) != 1:
        session.rollback()
        row = _get(session, layout_id)
        raise HTTPException(
            409,
            {
                "message": f"layout {layout_id} changed elsewhere "
                f"(revision {row.revision}, yours {body.revision})",
                "current": store.layout(row).model_dump(mode="json", by_alias=True),
            },
        )
    row = store.reload(session, m.Layout, layout_id)
    session.commit()
    return store.layout(row)


@router.patch("/{layout_id}", response_model=s.LayoutSummary)
def rename_layout(session: SessionDep, layout_id: str, body: s.LayoutRename) -> s.LayoutSummary:
    """Rename. Does not bump `revision` (it guards the state only)."""
    row = _get(session, layout_id)
    row.name = body.name
    row.updated_at = s.now()
    session.commit()
    return store.layout_summary(row)


@router.post("/{layout_id}/duplicate", response_model=s.Layout, status_code=201)
def duplicate_layout(session: SessionDep, layout_id: str, body: s.LayoutRename) -> s.Layout:
    """Copy the stored state under a new name."""
    src = _get(session, layout_id)
    return store.layout(_create(session, body.name, src.state, src.schema_version))


@router.delete("/{layout_id}", status_code=204)
def delete_layout(session: SessionDep, layout_id: str) -> Response:
    session.delete(_get(session, layout_id))
    session.commit()
    return Response(status_code=204)


@router.get("/{layout_id}/export", response_model=s.LayoutExport)
def export_layout(session: SessionDep, layout_id: str) -> s.LayoutExport:
    row = _get(session, layout_id)
    return s.LayoutExport(
        exported_at=s.now(),
        layout=s.LayoutDocument(name=row.name, state=row.state, schema_version=row.schema_version),
    )
