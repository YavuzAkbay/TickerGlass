"""Indicator, drawing and chart templates.

POST creates or replaces by natural key (name; tool type + name for drawing
templates): 201 when created, 200 when replaced. PUT /{id} edits by id and
returns 409 if the new name is taken by another template. A unique-key race
(two writers creating the same name at once) is also a 409, never a 500.
"""

from typing import Annotated, Any

from fastapi import APIRouter, HTTPException, Query, Response
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .. import models as m
from ..deps import SessionDep
from ..userdata import schemas as s
from ..userdata import store

router = APIRouter(tags=["templates"])


def _get(session: Session, model: Any, tid: str, what: str) -> Any:
    row = session.get(model, tid)
    if row is None:
        raise HTTPException(404, f"{what} not found: {tid}")
    return row


def _name_taken(what: str, name: str) -> HTTPException:
    return HTTPException(409, f"a {what} named {name!r} already exists")


def _flush(session: Session, what: str, name: str) -> None:
    """Flush; a unique-name violation (a concurrent writer took the name after
    our check) becomes the same 409 as the check itself."""
    try:
        session.flush()
    except IntegrityError as exc:
        session.rollback()
        raise _name_taken(what, name) from exc


def _commit(session: Session, what: str, name: str) -> None:
    _flush(session, what, name)
    session.commit()


# ------------------------------------------------------------ indicator templates


@router.get("/indicator-templates", response_model=list[s.IndicatorTemplate])
def list_indicator_templates(session: SessionDep) -> list[s.IndicatorTemplate]:
    rows = session.scalars(select(m.IndicatorTemplate).order_by(m.IndicatorTemplate.name))
    return [store.indicator_template(r) for r in rows]


@router.post("/indicator-templates", response_model=s.IndicatorTemplate, status_code=201)
def put_indicator_template(
    session: SessionDep, body: s.IndicatorTemplateIn, response: Response
) -> s.IndicatorTemplate:
    t = s.now()
    row = session.scalar(select(m.IndicatorTemplate).where(m.IndicatorTemplate.name == body.name))
    if row is None:
        row = m.IndicatorTemplate(id=s.new_id(), name=body.name, created_at=t)
        session.add(row)
    else:
        response.status_code = 200
    row.instances, row.schema_version, row.updated_at = body.instances, body.schema_version, t
    _commit(session, "indicator template", body.name)
    return store.indicator_template(row)


@router.get("/indicator-templates/{tid}", response_model=s.IndicatorTemplate)
def get_indicator_template(session: SessionDep, tid: str) -> s.IndicatorTemplate:
    return store.indicator_template(_get(session, m.IndicatorTemplate, tid, "indicator template"))


@router.put("/indicator-templates/{tid}", response_model=s.IndicatorTemplate)
def update_indicator_template(
    session: SessionDep, tid: str, body: s.IndicatorTemplateIn
) -> s.IndicatorTemplate:
    row = _get(session, m.IndicatorTemplate, tid, "indicator template")
    other = session.scalar(select(m.IndicatorTemplate).where(m.IndicatorTemplate.name == body.name))
    if other is not None and other.id != tid:
        raise _name_taken("indicator template", body.name)
    row.name, row.instances, row.schema_version = body.name, body.instances, body.schema_version
    row.updated_at = s.now()
    _commit(session, "indicator template", body.name)
    return store.indicator_template(row)


@router.delete("/indicator-templates/{tid}", status_code=204)
def delete_indicator_template(session: SessionDep, tid: str) -> Response:
    session.delete(_get(session, m.IndicatorTemplate, tid, "indicator template"))
    session.commit()
    return Response(status_code=204)


# ------------------------------------------------------------ drawing templates


@router.get("/drawing-templates", response_model=list[s.DrawingTemplate])
def list_drawing_templates(
    session: SessionDep,
    tool_type: Annotated[str | None, Query(alias="toolType", max_length=64)] = None,
) -> list[s.DrawingTemplate]:
    q = select(m.DrawingTemplate).order_by(m.DrawingTemplate.tool_type, m.DrawingTemplate.name)
    if tool_type is not None:
        q = q.where(m.DrawingTemplate.tool_type == tool_type)
    return [store.drawing_template(r) for r in session.scalars(q)]


@router.post("/drawing-templates", response_model=s.DrawingTemplate, status_code=201)
def put_drawing_template(
    session: SessionDep, body: s.DrawingTemplateIn, response: Response
) -> s.DrawingTemplate:
    """Create or replace by (toolType, name). `isDefault` clears the tool's other default."""
    t = s.now()
    row = session.scalar(
        select(m.DrawingTemplate).where(
            m.DrawingTemplate.tool_type == body.tool_type, m.DrawingTemplate.name == body.name
        )
    )
    if row is None:
        row = m.DrawingTemplate(
            id=s.new_id(), tool_type=body.tool_type, name=body.name, created_at=t
        )
        session.add(row)
    else:
        response.status_code = 200
    row.style, row.is_default, row.schema_version = body.style, body.is_default, body.schema_version
    row.updated_at = t
    _flush(session, f"{body.tool_type} template", body.name)
    if body.is_default:
        store.clear_other_defaults(session, body.tool_type, row.id)
    session.commit()
    return store.drawing_template(row)


@router.get("/drawing-templates/{tid}", response_model=s.DrawingTemplate)
def get_drawing_template(session: SessionDep, tid: str) -> s.DrawingTemplate:
    return store.drawing_template(_get(session, m.DrawingTemplate, tid, "drawing template"))


@router.put("/drawing-templates/{tid}", response_model=s.DrawingTemplate)
def update_drawing_template(
    session: SessionDep, tid: str, body: s.DrawingTemplateIn
) -> s.DrawingTemplate:
    row = _get(session, m.DrawingTemplate, tid, "drawing template")
    other = session.scalar(
        select(m.DrawingTemplate).where(
            m.DrawingTemplate.tool_type == body.tool_type, m.DrawingTemplate.name == body.name
        )
    )
    if other is not None and other.id != tid:
        raise _name_taken(f"{body.tool_type} template", body.name)
    row.tool_type, row.name, row.style = body.tool_type, body.name, body.style
    row.is_default, row.schema_version = body.is_default, body.schema_version
    row.updated_at = s.now()
    _flush(session, f"{body.tool_type} template", body.name)
    if body.is_default:
        store.clear_other_defaults(session, body.tool_type, row.id)
    session.commit()
    return store.drawing_template(row)


@router.delete("/drawing-templates/{tid}", status_code=204)
def delete_drawing_template(session: SessionDep, tid: str) -> Response:
    session.delete(_get(session, m.DrawingTemplate, tid, "drawing template"))
    session.commit()
    return Response(status_code=204)


# ------------------------------------------------------------ chart templates


@router.get("/chart-templates", response_model=list[s.ChartTemplate])
def list_chart_templates(session: SessionDep) -> list[s.ChartTemplate]:
    rows = session.scalars(select(m.ChartTemplate).order_by(m.ChartTemplate.name))
    return [store.chart_template(r) for r in rows]


@router.post("/chart-templates", response_model=s.ChartTemplate, status_code=201)
def put_chart_template(
    session: SessionDep, body: s.ChartTemplateIn, response: Response
) -> s.ChartTemplate:
    t = s.now()
    row = session.scalar(select(m.ChartTemplate).where(m.ChartTemplate.name == body.name))
    if row is None:
        row = m.ChartTemplate(id=s.new_id(), name=body.name, created_at=t)
        session.add(row)
    else:
        response.status_code = 200
    row.data, row.schema_version, row.updated_at = body.data, body.schema_version, t
    _commit(session, "chart template", body.name)
    return store.chart_template(row)


@router.get("/chart-templates/{tid}", response_model=s.ChartTemplate)
def get_chart_template(session: SessionDep, tid: str) -> s.ChartTemplate:
    return store.chart_template(_get(session, m.ChartTemplate, tid, "chart template"))


@router.put("/chart-templates/{tid}", response_model=s.ChartTemplate)
def update_chart_template(
    session: SessionDep, tid: str, body: s.ChartTemplateIn
) -> s.ChartTemplate:
    row = _get(session, m.ChartTemplate, tid, "chart template")
    other = session.scalar(select(m.ChartTemplate).where(m.ChartTemplate.name == body.name))
    if other is not None and other.id != tid:
        raise _name_taken("chart template", body.name)
    row.name, row.data, row.schema_version = body.name, body.data, body.schema_version
    row.updated_at = s.now()
    _commit(session, "chart template", body.name)
    return store.chart_template(row)


@router.delete("/chart-templates/{tid}", status_code=204)
def delete_chart_template(session: SessionDep, tid: str) -> Response:
    session.delete(_get(session, m.ChartTemplate, tid, "chart template"))
    session.commit()
    return Response(status_code=204)
