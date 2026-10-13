"""ORM <-> API conversion and the import/export logic."""

import math
from typing import Any, Literal

from sqlalchemy import delete, func, select, update
from sqlalchemy.orm import Session

from .. import models as m
from . import schemas as s


def layout_summary(row: m.Layout) -> s.LayoutSummary:
    return s.LayoutSummary(
        id=row.id,
        name=row.name,
        schema_version=row.schema_version,
        revision=row.revision,
        is_last_used=row.is_last_used,
        created_at=s.aware(row.created_at),
        updated_at=s.aware(row.updated_at),
    )


def layout(row: m.Layout) -> s.Layout:
    return s.Layout(**layout_summary(row).model_dump(), state=row.state)


def drawing(row: m.DrawingRow) -> s.Drawing:
    return s.Drawing(
        id=row.id,
        symbol=row.symbol,
        pane_id=row.pane_id,
        z=row.z,
        data=row.data,
        schema_version=row.schema_version,
        revision=row.revision,
        updated_at=s.aware(row.updated_at),
    )


def indicator_template(row: m.IndicatorTemplate) -> s.IndicatorTemplate:
    return s.IndicatorTemplate(
        id=row.id,
        name=row.name,
        instances=row.instances,
        schema_version=row.schema_version,
        created_at=s.aware(row.created_at),
        updated_at=s.aware(row.updated_at),
    )


def drawing_template(row: m.DrawingTemplate) -> s.DrawingTemplate:
    return s.DrawingTemplate(
        id=row.id,
        tool_type=row.tool_type,
        name=row.name,
        style=row.style,
        is_default=row.is_default,
        schema_version=row.schema_version,
        created_at=s.aware(row.created_at),
        updated_at=s.aware(row.updated_at),
    )


def chart_template(row: m.ChartTemplate) -> s.ChartTemplate:
    return s.ChartTemplate(
        id=row.id,
        name=row.name,
        data=row.data,
        schema_version=row.schema_version,
        created_at=s.aware(row.created_at),
        updated_at=s.aware(row.updated_at),
    )


def note(row: m.Note) -> s.Note:
    return s.Note(
        id=row.id,
        symbol=row.symbol,
        text=row.text,
        revision=row.revision,
        created_at=s.aware(row.created_at),
        updated_at=s.aware(row.updated_at),
    )


def drawing_fields(data: dict[str, Any]) -> tuple[str, str | None, str, int]:
    """(id, symbol, pane_id, z) of an engine `Drawing`. Raises ValueError.

    Scope 'all' maps to symbol null (synced); otherwise the symbol is upper-cased
    like `Chart.setSymbol`.
    """
    did = data.get("id")
    if not isinstance(did, str) or not 1 <= len(did) <= 64:
        raise ValueError("drawing.id must be a string of 1-64 characters")
    if not isinstance(data.get("type"), str):
        raise ValueError(f"drawing {did}: type must be a string")
    pane = data.get("paneId")
    if not isinstance(pane, str) or not 1 <= len(pane) <= 64:
        raise ValueError(f"drawing {did}: paneId must be a string of 1-64 characters")
    symbol: str | None = None
    if data.get("scope") != "all":
        raw = data.get("symbol", "")
        if not isinstance(raw, str) or len(raw.strip()) > 32:
            raise ValueError(f"drawing {did}: symbol must be a string of at most 32 characters")
        symbol = raw.strip().upper()
    z_raw = data.get("zIndex", 0)
    z = (
        int(z_raw)
        if isinstance(z_raw, int | float) and not isinstance(z_raw, bool) and math.isfinite(z_raw)
        else 0
    )
    return did, symbol, pane, max(-(2**31), min(2**31 - 1, z))


def set_last_used(session: Session, layout_id: str | None) -> None:
    session.execute(update(m.Layout).values(is_last_used=False))
    if layout_id is not None:
        session.execute(update(m.Layout).where(m.Layout.id == layout_id).values(is_last_used=True))


def clear_other_defaults(session: Session, tool_type: str, keep_id: str) -> None:
    session.execute(
        update(m.DrawingTemplate)
        .where(m.DrawingTemplate.tool_type == tool_type, m.DrawingTemplate.id != keep_id)
        .values(is_default=False)
    )


# ------------------------------------------------------------ export


def export_bundle(session: Session) -> s.Bundle:
    def rows(model: Any, *order: Any) -> list[Any]:
        return list(session.scalars(select(model).order_by(*order)))

    return s.Bundle(
        version=s.BUNDLE_VERSION,
        exported_at=s.now(),
        layouts=[
            s.BundleLayout(**layout(r).model_dump())
            for r in rows(m.Layout, m.Layout.created_at, m.Layout.id)
        ],
        drawings=[
            s.BundleDrawing(**drawing(r).model_dump()) for r in rows(m.DrawingRow, m.DrawingRow.id)
        ],
        indicator_templates=[
            s.BundleIndicatorTemplate(**indicator_template(r).model_dump())
            for r in rows(m.IndicatorTemplate, m.IndicatorTemplate.name)
        ],
        drawing_templates=[
            s.BundleDrawingTemplate(**drawing_template(r).model_dump())
            for r in rows(m.DrawingTemplate, m.DrawingTemplate.tool_type, m.DrawingTemplate.name)
        ],
        chart_templates=[
            s.BundleChartTemplate(**chart_template(r).model_dump())
            for r in rows(m.ChartTemplate, m.ChartTemplate.name)
        ],
        settings={r.key: r.value for r in rows(m.Setting, m.Setting.key)},
        notes=[
            s.BundleNote(**note(r).model_dump()) for r in rows(m.Note, m.Note.created_at, m.Note.id)
        ],
    )


# ------------------------------------------------------------ import


class BundleError(ValueError):
    """The bundle is well-formed JSON but cannot be imported (422)."""


def _dupes(keys: list[Any], what: str) -> None:
    seen: set[Any] = set()
    for k in keys:
        if k in seen:
            raise BundleError(f"duplicate {what} in bundle: {k}")
        seen.add(k)


USER_TABLES: list[Any] = [
    m.Layout,
    m.DrawingRow,
    m.IndicatorTemplate,
    m.DrawingTemplate,
    m.ChartTemplate,
    m.Setting,
    m.Note,
]


def import_bundle(
    session: Session, bundle: s.Bundle, mode: Literal["merge", "replace"]
) -> s.ImportSummary:
    """Apply `bundle` in `session` (the caller commits or rolls back).

    merge: layouts, drawings and notes match by id; templates by name
    (drawing templates by tool type + name); settings by key. Matches are
    overwritten (revision bumped), the rest is created. replace: all user
    data is deleted first.
    """
    if not 1 <= bundle.version <= s.BUNDLE_VERSION:
        raise BundleError(
            f"unsupported bundle version {bundle.version} (this server reads 1-{s.BUNDLE_VERSION})"
        )
    drawings: list[tuple[s.BundleDrawing, tuple[str, str | None, str, int]]] = []
    for d in bundle.drawings:
        try:
            drawings.append((d, drawing_fields(d.data)))
        except ValueError as exc:
            raise BundleError(str(exc)) from exc
    _dupes([x.id for x in bundle.layouts], "layout id")
    _dupes([f[0] for _, f in drawings], "drawing id")
    _dupes([x.name for x in bundle.indicator_templates], "indicator template name")
    _dupes([(x.tool_type, x.name) for x in bundle.drawing_templates], "drawing template")
    _dupes([x.name for x in bundle.chart_templates], "chart template name")
    _dupes([x.id for x in bundle.notes], "note id")

    summary = s.ImportSummary(mode=mode, dry_run=False)
    if mode == "replace":
        counts = [
            summary.layouts,
            summary.drawings,
            summary.indicator_templates,
            summary.drawing_templates,
            summary.chart_templates,
            summary.settings,
            summary.notes,
        ]
        for model, c in zip(USER_TABLES, counts, strict=True):
            c.deleted = session.scalar(select(func.count()).select_from(model)) or 0
            session.execute(delete(model))
        session.flush()

    t = s.now()
    last_used: str | None = None
    for x in bundle.layouts:
        lrow = session.get(m.Layout, x.id)
        if lrow is None:
            session.add(
                m.Layout(
                    id=x.id,
                    name=x.name,
                    state=x.state,
                    schema_version=x.schema_version,
                    revision=1,
                    is_last_used=False,
                    created_at=x.created_at or t,
                    updated_at=t,
                )
            )
            summary.layouts.created += 1
        else:
            lrow.name, lrow.state, lrow.schema_version = x.name, x.state, x.schema_version
            lrow.revision += 1
            lrow.updated_at = t
            summary.layouts.updated += 1
        if x.is_last_used:
            last_used = x.id
    session.flush()
    has_last = session.scalar(select(func.count()).where(m.Layout.is_last_used.is_(True)))
    if last_used is not None and (mode == "replace" or not has_last):
        set_last_used(session, last_used)

    for d, (did, symbol, pane, z) in drawings:
        drow = session.get(m.DrawingRow, did)
        if drow is None:
            session.add(
                m.DrawingRow(
                    id=did,
                    symbol=symbol,
                    pane_id=pane,
                    z=z,
                    data=d.data,
                    schema_version=d.schema_version,
                    revision=1,
                    updated_at=t,
                )
            )
            summary.drawings.created += 1
        else:
            drow.symbol, drow.pane_id, drow.z, drow.data = symbol, pane, z, d.data
            drow.schema_version = d.schema_version
            drow.revision += 1
            drow.updated_at = t
            summary.drawings.updated += 1

    for it in bundle.indicator_templates:
        irow = session.scalar(
            select(m.IndicatorTemplate).where(m.IndicatorTemplate.name == it.name)
        )
        if irow is None:
            session.add(
                m.IndicatorTemplate(
                    id=_free_id(session, m.IndicatorTemplate, it.id),
                    name=it.name,
                    instances=it.instances,
                    schema_version=it.schema_version,
                    created_at=it.created_at or t,
                    updated_at=t,
                )
            )
            summary.indicator_templates.created += 1
        else:
            irow.instances, irow.schema_version = it.instances, it.schema_version
            irow.updated_at = t
            summary.indicator_templates.updated += 1
        session.flush()

    for dt in bundle.drawing_templates:
        trow = session.scalar(
            select(m.DrawingTemplate).where(
                m.DrawingTemplate.tool_type == dt.tool_type, m.DrawingTemplate.name == dt.name
            )
        )
        if trow is None:
            trow = m.DrawingTemplate(
                id=_free_id(session, m.DrawingTemplate, dt.id),
                tool_type=dt.tool_type,
                name=dt.name,
                style=dt.style,
                is_default=dt.is_default,
                schema_version=dt.schema_version,
                created_at=dt.created_at or t,
                updated_at=t,
            )
            session.add(trow)
            summary.drawing_templates.created += 1
        else:
            trow.style, trow.is_default = dt.style, dt.is_default
            trow.schema_version, trow.updated_at = dt.schema_version, t
            summary.drawing_templates.updated += 1
        session.flush()
        if dt.is_default:
            clear_other_defaults(session, dt.tool_type, trow.id)

    for ct in bundle.chart_templates:
        crow = session.scalar(select(m.ChartTemplate).where(m.ChartTemplate.name == ct.name))
        if crow is None:
            session.add(
                m.ChartTemplate(
                    id=_free_id(session, m.ChartTemplate, ct.id),
                    name=ct.name,
                    data=ct.data,
                    schema_version=ct.schema_version,
                    created_at=ct.created_at or t,
                    updated_at=t,
                )
            )
            summary.chart_templates.created += 1
        else:
            crow.data, crow.schema_version, crow.updated_at = ct.data, ct.schema_version, t
            summary.chart_templates.updated += 1
        session.flush()

    for key, value in bundle.settings.items():
        srow = session.get(m.Setting, key)
        if srow is None:
            session.add(m.Setting(key=key, value=value, updated_at=t))
            summary.settings.created += 1
        else:
            srow.value, srow.updated_at = value, t
            summary.settings.updated += 1

    for n in bundle.notes:
        nrow = session.get(m.Note, n.id)
        if nrow is None:
            session.add(
                m.Note(
                    id=n.id,
                    symbol=n.symbol,
                    text=n.text,
                    revision=1,
                    created_at=n.created_at or t,
                    updated_at=t,
                )
            )
            summary.notes.created += 1
        else:
            nrow.symbol, nrow.text, nrow.updated_at = n.symbol, n.text, t
            nrow.revision += 1
            summary.notes.updated += 1
    session.flush()
    return summary


def _free_id(session: Session, model: Any, wanted: str | None) -> str:
    if wanted is not None and session.get(model, wanted) is None:
        return wanted
    return s.new_id()
