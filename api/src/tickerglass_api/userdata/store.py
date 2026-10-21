"""ORM <-> API conversion and the import/export logic."""

import math
import re
from dataclasses import dataclass, field
from typing import Any, Literal, TypeVar, cast

from sqlalchemy import CursorResult, Result, delete, func, select, update
from sqlalchemy.orm import Session

from .. import models as m
from . import alerts as al
from . import schemas as s

_T = TypeVar("_T")


def rowcount(result: Result[Any]) -> int:
    """Rows matched by a Core UPDATE/DELETE executed through the session."""
    return cast(CursorResult[Any], result).rowcount


def reload(session: Session, model: type[_T], key: str) -> _T:
    """Re-select a row the current transaction just wrote with a Core statement."""
    row = session.get(model, key, populate_existing=True)
    if row is None:
        raise LookupError(f"{model.__name__} {key} vanished inside its own transaction")
    return row


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


def user_script(row: m.UserScript) -> s.UserScript:
    return s.UserScript(
        id=row.id,
        name=row.name,
        source=row.source,
        manifest=row.manifest,
        api_version=row.api_version,
        revision=row.revision,
        created_at=s.aware(row.created_at),
        updated_at=s.aware(row.updated_at),
    )


def dump_items(items: list[s.WatchlistSymbolItem | s.WatchlistSectionItem]) -> list[Any]:
    """Validated watchlist items as the JSON stored in `watchlists.items`."""
    return [i.model_dump(mode="json", by_alias=True) for i in items]


def watchlist(row: m.Watchlist) -> s.Watchlist:
    return s.Watchlist.model_validate(
        {
            "id": row.id,
            "name": row.name,
            "items": row.items,
            "revision": row.revision,
            "createdAt": s.aware(row.created_at),
            "updatedAt": s.aware(row.updated_at),
        }
    )


def flag(row: m.SymbolFlag) -> s.Flag:
    return s.Flag(
        symbol=row.symbol,
        color=row.color,  # type: ignore[arg-type]
        created_at=s.aware(row.created_at),
        updated_at=s.aware(row.updated_at),
    )


def drawing_fields(data: dict[str, Any]) -> tuple[str, str | None, str, int]:
    """(id, symbol, pane_id, z) of an engine `Drawing`. Raises ValueError.

    Scope 'all' maps to symbol null (synced); otherwise the symbol is required
    (non-empty) and upper-cased like `Chart.setSymbol`.
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
        raw = data.get("symbol")
        if not isinstance(raw, str) or not 1 <= len(raw.strip()) <= 32:
            raise ValueError(
                f"drawing {did}: symbol must be a non-empty string of at most 32 characters "
                "unless scope is 'all'"
            )
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
        app="tickerglass",
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
        watchlists=[
            s.BundleWatchlist(**watchlist(r).model_dump())
            for r in rows(m.Watchlist, m.Watchlist.created_at, m.Watchlist.id)
        ],
        flags=[
            s.BundleFlag(**flag(r).model_dump())
            for r in rows(m.SymbolFlag, m.SymbolFlag.created_at, m.SymbolFlag.symbol)
        ],
        alerts=[
            al.BundleAlert(**al.alert_out(r).model_dump(exclude={"drawing_id"}))
            for r in rows(m.Alert, m.Alert.created_at, m.Alert.id)
        ],
        user_scripts=[
            s.BundleUserScript(**user_script(r).model_dump())
            for r in rows(m.UserScript, m.UserScript.created_at, m.UserScript.id)
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


#: Bundle section (field name) -> table it fills.
SECTIONS: dict[str, Any] = {
    "layouts": m.Layout,
    "drawings": m.DrawingRow,
    "indicator_templates": m.IndicatorTemplate,
    "drawing_templates": m.DrawingTemplate,
    "chart_templates": m.ChartTemplate,
    "settings": m.Setting,
    "notes": m.Note,
    "watchlists": m.Watchlist,
    "flags": m.SymbolFlag,
    "alerts": m.Alert,
    "user_scripts": m.UserScript,
}

_SAFE_LAYOUT_ID = re.compile(r"[A-Za-z0-9_-]{1,36}")


def _import_layout_id(wanted: str) -> str:
    """Keep the bundle's layout id unless it would shadow a fixed route
    (`/layouts/last-used`) or not round-trip through a URL path segment."""
    if wanted in s.RESERVED_LAYOUT_IDS or not _SAFE_LAYOUT_ID.fullmatch(wanted):
        return s.new_id()
    return wanted


@dataclass
class Touched:
    """Ids an import wrote or removed, for the `/ws` change events (published after commit)."""

    alerts: set[str] = field(default_factory=set)
    alerts_deleted: set[str] = field(default_factory=set)
    drawings: set[str] = field(default_factory=set)
    drawings_deleted: set[str] = field(default_factory=set)


def import_bundle(
    session: Session,
    bundle: s.Bundle,
    mode: Literal["merge", "replace"],
    touched: Touched | None = None,
) -> s.ImportSummary:
    """Apply `bundle` in `session` (the caller commits or rolls back).

    merge: layouts, drawings, notes and user scripts match by id; templates by name
    (drawing templates by tool type + name); settings by key. Matches are
    overwritten (revision bumped), the rest is created (watchlists match by id,
    flags by symbol). replace: the tables of
    the sections present in the bundle are emptied first; absent sections are
    left alone (so `{"version": 1, "app": "tickerglass"}` changes nothing).
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
    _dupes([x.id for x in bundle.watchlists], "watchlist id")
    _dupes([x.symbol for x in bundle.flags], "flag symbol")
    for key, value in bundle.settings.items():
        if value is None:
            raise BundleError(f"setting {key}: value must not be null (omit the key instead)")

    _dupes([x.id for x in bundle.alerts], "alert id")
    _dupes([x.id for x in bundle.user_scripts], "user script id")

    summary = s.ImportSummary(mode=mode, dry_run=False)
    touched = touched if touched is not None else Touched()
    if mode == "replace":
        for section, model in SECTIONS.items():
            if section not in bundle.model_fields_set:
                continue
            c: s.ImportCounts = getattr(summary, section)
            c.deleted = session.scalar(select(func.count()).select_from(model)) or 0
            if section == "alerts":
                touched.alerts_deleted.update(session.scalars(select(m.Alert.id)))
                session.execute(delete(m.AlertState))
            elif section == "drawings":
                touched.drawings_deleted.update(session.scalars(select(m.DrawingRow.id)))
            session.execute(delete(model))
        session.flush()

    t = s.now()
    last_used: str | None = None
    for x in bundle.layouts:
        lid = _import_layout_id(x.id)
        lrow = session.get(m.Layout, lid)
        if lrow is None:
            session.add(
                m.Layout(
                    id=lid,
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
            last_used = lid
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
        touched.drawings.add(did)

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

    for w in bundle.watchlists:
        wid = w.id if _SAFE_LAYOUT_ID.fullmatch(w.id) else s.new_id()
        wrow = session.get(m.Watchlist, wid)
        if wrow is None:
            session.add(
                m.Watchlist(
                    id=wid,
                    name=w.name,
                    items=dump_items(w.items),
                    revision=1,
                    created_at=w.created_at or t,
                    updated_at=t,
                )
            )
            summary.watchlists.created += 1
        else:
            wrow.name, wrow.items, wrow.updated_at = w.name, dump_items(w.items), t
            wrow.revision += 1
            summary.watchlists.updated += 1

    for f in bundle.flags:
        frow = session.get(m.SymbolFlag, f.symbol)
        if frow is None:
            session.add(
                m.SymbolFlag(
                    symbol=f.symbol, color=f.color, created_at=f.created_at or t, updated_at=t
                )
            )
            summary.flags.created += 1
        else:
            if frow.color != f.color:
                frow.color, frow.created_at = f.color, t
            frow.updated_at = t
            summary.flags.updated += 1

    for u in bundle.user_scripts:
        urow = session.get(m.UserScript, u.id)
        if urow is None:
            session.add(
                m.UserScript(
                    id=u.id,
                    name=u.name,
                    source=u.source,
                    manifest=u.manifest,
                    api_version=u.api_version,
                    revision=1,
                    created_at=u.created_at or t,
                    updated_at=t,
                )
            )
            summary.user_scripts.created += 1
        else:
            urow.name, urow.source, urow.manifest = u.name, u.source, u.manifest
            urow.api_version, urow.updated_at = u.api_version, t
            urow.revision += 1
            summary.user_scripts.updated += 1

    for a in bundle.alerts:
        _import_alert(session, a, t, summary, touched)
    session.flush()
    if bundle.alerts and (session.scalar(select(func.count()).select_from(m.Alert)) or 0) > (
        al.MAX_ALERTS
    ):
        raise BundleError(f"import would exceed {al.MAX_ALERTS} alerts")
    touched.alerts_deleted -= touched.alerts
    touched.drawings_deleted -= touched.drawings
    return summary


def _import_alert(
    session: Session,
    a: al.BundleAlert,
    t: Any,
    summary: s.ImportSummary,
    touched: Touched,
) -> None:
    """Merge one alert by id. Imported alerts keep their status; the state row is dropped."""
    aid = a.id
    if not _SAFE_LAYOUT_ID.fullmatch(aid) or aid in al.RESERVED_ALERT_IDS:
        aid = s.new_id()
    fields: dict[str, Any] = {
        "name": a.name,
        "symbol": a.symbol,
        "interval": a.interval,
        "prepost": a.prepost,
        "spec": al.dump_spec(a.spec),
        "schema_version": al.ALERT_SCHEMA_VERSION,
        "message": a.message,
        "notify": al.dump_notify(a.notify),
        "status": a.status,
        "status_reason": a.status_reason,
        "expires_at": None if a.expires_at is None else al.utc(a.expires_at),
        "drawing_id": al.derive_drawing_id(a.spec),
        "fire_count": a.fire_count,
        "last_fired_at": None if a.last_fired_at is None else al.utc(a.last_fired_at),
    }
    row = session.get(m.Alert, aid)
    if row is None:
        session.add(
            m.Alert(id=aid, revision=1, created_at=a.created_at or t, updated_at=t, **fields)
        )
        summary.alerts.created += 1
    else:
        for key, value in fields.items():
            setattr(row, key, value)
        row.revision += 1
        row.updated_at = t
        session.execute(delete(m.AlertState).where(m.AlertState.alert_id == aid))
        summary.alerts.updated += 1
    touched.alerts.add(aid)


def _free_id(session: Session, model: Any, wanted: str | None) -> str:
    if wanted is not None and session.get(model, wanted) is None:
        return wanted
    return s.new_id()
