"""Scan engine: compiles a `ScanRequest` to one SQLAlchemy Core SELECT over
`screener_symbols LEFT JOIN screener_snapshots LEFT JOIN screener_fundamentals` and runs it.

Reads the database only, never a provider. Safety rests on three rules: every column comes
from the `fields.FIELDS` whitelist, every client value is a bound parameter, and any invalid
request raises `ScanError` while the statement is being built, before anything is executed.
No `text()` and no string-built SQL appear in this module.

Semantics (design §4): nulls never match a rule; `{field}` operands share the rule field's
dimension; `crossesAbove X` is `a > X AND prev_a <= prev_X` (a number X is its own previous
value); `abovePct`/`belowPct` are `a > b*(1+pct/100)` / `a < b*(1-pct/100)`; an empty group
imposes no constraint. Class universes are `symbol IN class_symbols(cls)`; tombstoned symbols
never appear. A symbol whose snapshot is older than `target - screener_stale_days` is left out,
one older than the target is returned with `stale: true` (unless it is one day behind and was
computed after the target session's bars were final, as crypto's last complete UTC day is);
a symbol without any snapshot is
returned with null values (it cannot match a filter). The target is the `target_date` argument
(WP2's `stack.screener.target_date()`), else the newest finished snapshot run's target date,
else the newest snapshot date. Sorts put nulls last in both directions.
"""

import math
import operator
from collections.abc import Callable
from datetime import date, datetime, timedelta
from typing import Any, TypeVar
from zoneinfo import ZoneInfoNotFoundError

from sqlalchemy import ColumnElement, Select, and_, case, func, null, or_, select
from sqlalchemy.exc import DataError
from sqlalchemy.orm import Session

from ...models import (
    ScreenerFundamental,
    ScreenerList,
    ScreenerListMember,
    ScreenerRun,
    ScreenerSnapshot,
    ScreenerSymbol,
    Watchlist,
)
from ...settings import Settings
from ...userdata.schemas import aware
from . import formula as fx
from . import universe as uv
from .fields import DEFAULT_FIELDS, FIELDS, NOW_PARAM, FieldSpec, convert
from .schemas import (
    MAX_DEPTH,
    MAX_RULES,
    Coverage,
    FormulaRule,
    Group,
    Rule,
    Scalar,
    ScanRequest,
    ScanResponse,
    ScanRow,
    Sort,
)
from .technicals import session_final_at

_sym = ScreenerSymbol.__table__
_snap = ScreenerSnapshot.__table__
_fund = ScreenerFundamental.__table__
_member = ScreenerListMember.__table__
_run = ScreenerRun.__table__

_FINISHED = ("done", "partial")
_OPS = {
    ">": operator.gt,
    "<": operator.lt,
    ">=": operator.ge,
    "<=": operator.le,
}
_ALL_OPS = (*_OPS, "=", "between", "in", "crossesAbove", "crossesBelow", "abovePct", "belowPct")
_MAX_IN = 100
#: Most groups (the root included) of one filter; with `MAX_RULES` and `MAX_DEPTH` this bounds the
#: size of the compiled WHERE clause.
MAX_GROUPS = 20
_MAX_PCT = 1e6


class ScanError(Exception):
    """An invalid request. `code` is one of unknown_field, bad_op, field_unavailable,
    bad_value, too_complex, bad_formula, formula_overflow (a missing list or watchlist is a 404
    `UniverseNotFound` with code unknown_list / unknown_watchlist); `path` points at the
    offending part, e.g. `filter.rules[1].value`; `offset` is the character position inside a
    formula (design §10), else None and left out of the detail."""

    status = 422

    def __init__(self, code: str, message: str, path: str = "", offset: int | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.path = path
        self.offset = offset

    def detail(self) -> dict[str, str | int]:
        out: dict[str, str | int] = {"code": self.code, "message": self.message, "path": self.path}
        if self.offset is not None:
            out["offset"] = self.offset
        return out


class UniverseNotFound(ScanError):
    status = 404

    def __init__(self, code: str, message: str, path: str = "universe") -> None:
        super().__init__(code, message, path)


# ------------------------------------------------------------------ compile


def _lookup(fid: object, path: str, fundamentals: bool) -> FieldSpec:
    spec = FIELDS.get(fid) if isinstance(fid, str) else None
    if spec is None:
        raise ScanError("unknown_field", "unknown field", path)
    if spec.fundamental and not fundamentals:
        raise ScanError(
            "field_unavailable", f"{spec.id} is not available from this data source", path
        )
    return spec


def _number(value: object, path: str) -> float:
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise ScanError("bad_value", "expected a number", path)
    try:
        out = float(value)
    except OverflowError:
        raise ScanError("bad_value", "number out of range", path) from None
    if not math.isfinite(out):
        raise ScanError("bad_value", "number must be finite", path)
    return out


def _field_operand(value: object, spec: FieldSpec, path: str, fundamentals: bool) -> FieldSpec:
    if not isinstance(value, dict) or not isinstance(value.get("field"), str):
        raise ScanError("bad_value", "expected a number or {field}", path)
    other = _lookup(value["field"], f"{path}.field", fundamentals)
    if other.id == spec.id:
        raise ScanError("bad_value", f"{spec.id} cannot be compared with itself", f"{path}.field")
    if other.dimension != spec.dimension or not other.numeric:
        raise ScanError(
            "bad_value",
            f"{other.id} ({other.dimension}) cannot be compared with {spec.id} ({spec.dimension})",
            f"{path}.field",
        )
    return other


def _string(value: object, spec: FieldSpec, path: str) -> Any:
    """A validated string/enum literal, mapped to the stored value for coded enums."""
    if not isinstance(value, str) or len(value) > 200:
        raise ScanError("bad_value", "expected a string", path)
    if spec.enum_values is not None and value not in spec.enum_values:
        raise ScanError("bad_value", f"must be one of {', '.join(spec.enum_values)}", path)
    return spec.codes[value] if spec.codes is not None else value


def _rule(rule: Rule, path: str, fundamentals: bool) -> ColumnElement[bool]:
    spec = _lookup(rule.field, f"{path}.field", fundamentals)
    op, value, vpath = rule.op, rule.value, f"{path}.value"
    if op not in _ALL_OPS or op not in spec.ops:
        raise ScanError("bad_op", f"operator {op!r} is not valid for {spec.id}", f"{path}.op")
    a = spec.column

    if op in _OPS:
        if isinstance(value, dict):
            return _OPS[op](a, _field_operand(value, spec, vpath, fundamentals).column)  # type: ignore[no-any-return]
        return _OPS[op](a, _number(value, vpath))  # type: ignore[no-any-return]

    if op == "between":
        if not isinstance(value, list) or len(value) != 2:
            raise ScanError("bad_value", "expected [low, high]", vpath)
        lo, hi = _number(value[0], f"{vpath}[0]"), _number(value[1], f"{vpath}[1]")
        if lo > hi:
            raise ScanError("bad_value", "low must not exceed high", vpath)
        return a.between(lo, hi)

    if op in ("crossesAbove", "crossesBelow"):
        assert spec.prev_column is not None  # in spec.ops only for crossable fields
        if isinstance(value, dict):
            other = _field_operand(value, spec, vpath, fundamentals)
            if other.prev_column is None:
                raise ScanError("bad_value", f"{other.id} is not crossable", f"{vpath}.field")
            b, prev_b = other.column, other.prev_column
        else:
            b = prev_b = _number(value, vpath)  # type: ignore[assignment]
        if op == "crossesAbove":
            return and_(a > b, spec.prev_column <= prev_b)
        return and_(a < b, spec.prev_column >= prev_b)

    if op in ("abovePct", "belowPct"):
        if not isinstance(value, dict) or set(value) != {"field", "pct"}:
            raise ScanError("bad_value", "expected {field, pct}", vpath)
        other = _field_operand(value, spec, vpath, fundamentals)
        pct = _number(value["pct"], f"{vpath}.pct")
        if abs(pct) > _MAX_PCT:
            raise ScanError("bad_value", "pct out of range", f"{vpath}.pct")
        if op == "abovePct":
            return a > other.column * (1 + pct / 100)
        return a < other.column * (1 - pct / 100)

    if op == "in":
        if not isinstance(value, list) or not 1 <= len(value) <= _MAX_IN:
            raise ScanError("bad_value", f"expected 1-{_MAX_IN} strings", vpath)
        return a.in_([_string(v, spec, f"{vpath}[{i}]") for i, v in enumerate(value)])

    # op == "="
    if spec.type == "bool":
        if not isinstance(value, bool):
            raise ScanError("bad_value", "expected true or false", vpath)
        return a == value
    eq: ColumnElement[bool]
    eq = a == _number(value, vpath) if spec.numeric else a == _string(value, spec, vpath)
    return eq


def parse_formula(text: str, path: str, *, fundamentals: bool = True) -> fx.Node:
    """A formula's AST; a `FormulaError` becomes a `ScanError` with `path` and `offset`."""
    try:
        return fx.parse(text, FIELDS, fundamentals=fundamentals)
    except fx.FormulaError as exc:
        raise ScanError(
            exc.code, f"{exc.message} (at character {exc.offset})", path, exc.offset
        ) from None


def _formula_rule(rule: FormulaRule, path: str, fundamentals: bool) -> ColumnElement[bool]:
    if rule.op not in fx.FORMULA_OPS:
        raise ScanError("bad_op", f"operator {rule.op!r} is not valid for a formula", f"{path}.op")
    expr = fx.compile_node(
        parse_formula(rule.formula, f"{path}.formula", fundamentals=fundamentals)
    )
    value, vpath = rule.value, f"{path}.value"
    if rule.op == "between":
        if not isinstance(value, list) or len(value) != 2:
            raise ScanError("bad_value", "expected [low, high]", vpath)
        lo, hi = _number(value[0], f"{vpath}[0]"), _number(value[1], f"{vpath}[1]")
        if lo > hi:
            raise ScanError("bad_value", "low must not exceed high", vpath)
        return expr.between(lo, hi)
    return _OPS[rule.op](expr, _number(value, vpath))  # type: ignore[no-any-return]


class _Budget:
    def __init__(self) -> None:
        self.rules = 0
        self.groups = 0
        self.formulas = 0


def _group(
    group: Group, path: str, depth: int, budget: _Budget, fundamentals: bool
) -> ColumnElement[bool] | None:
    if depth > MAX_DEPTH:
        raise ScanError("too_complex", f"groups nest at most {MAX_DEPTH} deep", path)
    budget.groups += 1
    if budget.groups > MAX_GROUPS:
        raise ScanError("too_complex", f"at most {MAX_GROUPS} groups", path)
    parts: list[ColumnElement[bool]] = []
    for i, node in enumerate(group.rules):
        npath = f"{path}.rules[{i}]"
        clause: ColumnElement[bool] | None
        if isinstance(node, Group):
            clause = _group(node, npath, depth + 1, budget, fundamentals)
        else:
            budget.rules += 1
            if budget.rules > MAX_RULES:
                raise ScanError("too_complex", f"at most {MAX_RULES} rules", npath)
            if isinstance(node, FormulaRule):
                budget.formulas += 1
                if budget.formulas > fx.MAX_FORMULA_RULES:
                    raise ScanError(
                        "too_complex", f"at most {fx.MAX_FORMULA_RULES} formula rules", npath
                    )
                clause = _formula_rule(node, npath, fundamentals)
            else:
                clause = _rule(node, npath, fundamentals)
        if clause is not None:
            parts.append(clause)
    if not parts:
        return None
    if len(parts) == 1:
        return parts[0]
    return and_(*parts) if group.op == "and" else or_(*parts)


def compile_filter(group: Group | None, *, fundamentals: bool = True) -> ColumnElement[bool] | None:
    """The WHERE clause of a filter, or None for no constraint. Raises `ScanError`."""
    if group is None:
        return None
    return _group(group, "filter", 1, _Budget(), fundamentals)


def _order(sort: Sort, fundamentals: bool) -> list[ColumnElement[Any]]:
    spec = _lookup(sort.field, "sort.field", fundamentals)
    col = spec.column
    # Nulls last in both directions, portable across SQLite and PostgreSQL.
    return [
        case((col.is_(None), 1), else_=0),
        col.desc() if sort.dir == "desc" else col.asc(),
        _sym.c.rank,
        _sym.c.symbol,
    ]


class _Column:
    """One returned value: a registry field, or a formula (`"=<formula>"`, design §10)."""

    def __init__(self, key: str, spec: FieldSpec | None, formula: fx.Node | None = None) -> None:
        self.key = key
        self.spec = spec
        self.formula = formula

    def sql(self, fundamentals: bool) -> ColumnElement[Any]:
        if self.formula is not None:
            return fx.compile_node(self.formula, fundamentals=fundamentals)
        assert self.spec is not None
        return self.spec.column if fundamentals or not self.spec.fundamental else null()

    def value(self, raw: Any) -> Scalar:
        if self.spec is not None:
            return convert(self.spec, raw)  # type: ignore[no-any-return]
        return convert_formula(raw)


def convert_formula(raw: Any) -> float | None:
    """A formula column's stored value as returned (NaN/inf -> null)."""
    if raw is None or isinstance(raw, bool) or not isinstance(raw, int | float):
        return None
    out = float(raw)
    return out if math.isfinite(out) else None


def _columns(req: ScanRequest, fundamentals: bool) -> list[_Column]:
    """Requested columns. A formula column referencing a field the provider lacks is null,
    like a plain fundamental column."""
    wanted = req.fields if req.fields is not None else [*DEFAULT_FIELDS, req.sort.field]
    ids = list(dict.fromkeys(wanted))
    out: list[_Column] = []
    formulas = 0
    for i, fid in enumerate(ids):
        if isinstance(fid, str) and fid.startswith(fx.FIELD_PREFIX):
            formulas += 1
            if formulas > fx.MAX_FORMULA_FIELDS:
                raise ScanError(
                    "too_complex",
                    f"at most {fx.MAX_FORMULA_FIELDS} formula columns",
                    f"fields[{i}]",
                )
            node = parse_formula(fid[len(fx.FIELD_PREFIX) :], f"fields[{i}]")
            out.append(_Column(fid, None, node))
            continue
        if not isinstance(fid, str) or fid not in FIELDS:
            raise ScanError("unknown_field", "unknown field", f"fields[{i}]")
        out.append(_Column(fid, FIELDS[fid]))
    return out


def validate_request(req: ScanRequest, *, fundamentals: bool = True) -> None:
    """Check a request without a database (filter, sort and requested fields). Raises
    `ScanError`; `run_scan` does the same before it executes anything."""
    compile_filter(req.filter, fundamentals=fundamentals)
    _order(req.sort, fundamentals)
    _columns(req, fundamentals)


# ---------------------------------------------------------------- universe


def _watchlist_symbols(session: Session, wid: str) -> list[str]:
    items = session.scalar(select(Watchlist.items).where(Watchlist.id == wid))
    if items is None:
        raise UniverseNotFound("unknown_watchlist", f"watchlist not found: {wid}")
    out: dict[str, None] = {}
    for item in items:
        if isinstance(item, dict) and item.get("type") == "symbol":
            out[str(item.get("symbol", "")).upper()] = None
    return list(out)


def _universe_clause(session: Session, req: ScanRequest) -> ColumnElement[bool]:
    u = req.universe
    if u.kind == "class":
        return _sym.c.symbol.in_(uv.class_symbols(u.cls))
    if u.kind == "list":
        if session.get(ScreenerList, u.id) is None:
            raise UniverseNotFound("unknown_list", f"list not found: {u.id}")
        return _sym.c.symbol.in_(select(_member.c.symbol).where(_member.c.list_id == u.id))
    if u.kind == "watchlist":
        return _sym.c.symbol.in_(_watchlist_symbols(session, u.id))
    return _sym.c.symbol.in_(u.symbols)


# --------------------------------------------------------------------- run


def _joined() -> Any:
    return _sym.outerjoin(_snap, _snap.c.symbol == _sym.c.symbol).outerjoin(
        _fund, _fund.c.symbol == _sym.c.symbol
    )


def target_date(session: Session) -> date | None:
    """Newest finished snapshot run's target date, else the newest snapshot date."""
    found = session.scalar(
        select(func.max(_run.c.target_date)).where(
            _run.c.kind == "snapshot", _run.c.status.in_(_FINISHED)
        )
    )
    if found is not None:
        return found  # type: ignore[no-any-return]
    newest: date | None = session.scalar(select(func.max(_snap.c.as_of_date)))
    return newest


def latest_finished_run(session: Session) -> tuple[date | None, datetime | None]:
    """`(target_date, finished_at)` of the newest finished (done or partial) snapshot run, or
    `(None, None)` while none has finished. This is what a scan's and the status's `asOf` /
    `computedAt` report: the rows a first run has written so far are not a complete snapshot, so
    the data counts as absent until the run finishes."""
    row = session.execute(
        select(_run.c.target_date, _run.c.finished_at)
        .where(_run.c.kind == "snapshot", _run.c.status.in_(_FINISHED))
        .order_by(_run.c.id.desc())
        .limit(1)
    ).first()
    if row is None:
        return None, None
    return row[0], row[1]


#: A snapshot at most this many days behind the target counts as current once computed after
#: the target session's bars were final (crypto's newest complete UTC day trails the US close).
CURRENT_LAG_DAYS = 1


def current_cutoff(tgt: date, settings: Settings) -> datetime:
    """From this instant on a snapshot of `tgt`'s session is current whatever its newest bar's
    date (same rule as the job's work queue)."""
    settle = timedelta(seconds=settings.bars_settle_after_close_s)
    try:
        return session_final_at(
            tgt, settings.screener_tz, settle, extra=settings.market_extra_holidays
        )
    except (ZoneInfoNotFoundError, ValueError):
        return session_final_at(tgt, "UTC", settle, extra=settings.market_extra_holidays)


def iso(value: datetime | None) -> str | None:
    return aware(value).isoformat() if value is not None else None


def formula_paths(req: ScanRequest) -> list[str]:
    """Paths of the request's formulas (rules, then `"="` columns), in request order."""
    out: list[str] = []

    def walk(group: Group, path: str) -> None:
        for i, node in enumerate(group.rules):
            npath = f"{path}.rules[{i}]"
            if isinstance(node, Group):
                walk(node, npath)
            elif isinstance(node, FormulaRule):
                out.append(f"{npath}.formula")

    if req.filter is not None:
        walk(req.filter, "filter")
    for i, fid in enumerate(req.fields or ()):
        if fid.startswith(fx.FIELD_PREFIX):
            out.append(f"fields[{i}]")
    return out


_T = TypeVar("_T")


def _needs_savepoint(session: Session) -> bool:
    """SQLite never raises on float overflow (it yields inf); PostgreSQL does, and an error
    there aborts the whole transaction, so formula queries run inside a SAVEPOINT."""
    return session.get_bind().dialect.name != "sqlite"


def _guarded(session: Session, paths: list[str], run: Callable[[], _T]) -> _T:
    """Run a query; with formulas, a numeric overflow of the database (PostgreSQL
    `NumericValueOutOfRange`, raised as `DataError`) becomes a 422 `formula_overflow` at the
    first formula's path, and the caller's transaction stays usable."""
    if not paths:
        return run()
    try:
        if not _needs_savepoint(session):
            return run()
        with session.begin_nested():
            return run()
    except DataError:
        raise ScanError(
            "formula_overflow", "a formula's value is out of the database's numeric range", paths[0]
        ) from None


def run_scan(
    session: Session,
    req: ScanRequest,
    *,
    settings: Settings,
    now: datetime,
    fundamentals: bool = True,
    target: date | None = None,
) -> ScanResponse:
    """Run a scan on the database. `fundamentals=False` (provider without `ScreenInfoProvider`)
    makes rules or sorts on fundamental fields fail with `field_unavailable` and requested
    fundamental columns come back null. `target` overrides the session date used for staleness.
    Raises `ScanError` (422) or `UniverseNotFound` (404); executes nothing in that case."""
    where_filter = compile_filter(req.filter, fundamentals=fundamentals)
    order = _order(req.sort, fundamentals)
    columns = _columns(req, fundamentals)
    scope = [_sym.c.tombstoned_at.is_(None), _universe_clause(session, req)]

    tgt = target if target is not None else target_date(session)
    cutoff = tgt - timedelta(days=settings.screener_stale_days) if tgt is not None else None
    recent = (
        or_(_snap.c.as_of_date.is_(None), _snap.c.as_of_date >= cutoff)
        if cutoff is not None
        else None
    )
    where = [*scope]
    if recent is not None:
        where.append(recent)
    if where_filter is not None:
        where.append(where_filter)
    params = {NOW_PARAM: int(now.timestamp())}

    picked = [
        _sym.c.symbol,
        _sym.c.name,
        _sym.c.cls,
        _sym.c.grp,
        _sym.c.exchange,
        _snap.c.as_of_date,
        *(c.sql(fundamentals).label(f"f{i}") for i, c in enumerate(columns)),
        _snap.c.computed_at,
    ]
    page: Select[Any] = (
        select(*picked)
        .select_from(_joined())
        .where(*where)
        .order_by(*order)
        .limit(req.limit)
        .offset(req.offset)
    )
    paths = formula_paths(req)
    total = _guarded(
        session,
        paths,
        lambda: session.scalar(
            select(func.count()).select_from(_joined()).where(*where).params(params)
        ),
    )
    cover = session.execute(
        select(
            func.count(),
            func.count(
                case((and_(_snap.c.symbol.is_not(None), recent), 1))
                if recent is not None
                else case((_snap.c.symbol.is_not(None), 1))
            ),
        )
        .select_from(_joined())
        .where(*scope)
    ).one()
    rows = _guarded(session, paths, lambda: session.execute(page, params).all())

    as_of, computed_at = latest_finished_run(session)
    provider = session.scalar(
        select(_snap.c.provider).order_by(_snap.c.computed_at.desc()).limit(1)
    )
    out: list[ScanRow] = []
    final = current_cutoff(tgt, settings) if tgt is not None else None
    for r in rows:
        stale = r.as_of_date is not None and tgt is not None and r.as_of_date < tgt
        if (
            stale
            and final is not None
            and tgt is not None
            and r.computed_at is not None
            and (tgt - r.as_of_date).days <= CURRENT_LAG_DAYS
        ):
            stale = aware(r.computed_at) < final
        values: dict[str, Scalar] = {c.key: c.value(r[6 + i]) for i, c in enumerate(columns)}
        out.append(
            ScanRow(
                symbol=r.symbol,
                name=r.name,
                cls=r.cls,
                group=r.grp,
                exchange=r.exchange,
                stale=bool(stale),
                values=values,
            )
        )
    return ScanResponse(
        as_of=as_of.isoformat() if as_of is not None else None,
        computed_at=iso(computed_at),
        provider=provider or "",
        total=total or 0,
        offset=req.offset,
        limit=req.limit,
        coverage=Coverage(universe=cover[0], with_snapshot=cover[1]),
        rows=out,
    )


def snapshot_values(
    session: Session, symbols: list[str], *, settings: Settings, now: datetime
) -> tuple[str | None, dict[str, dict[str, Scalar]]]:
    """Every non-meta field of the given symbols from the database: `(asOf, {symbol:
    {fieldId: value}})`. Untracked, tombstoned and too-stale symbols are omitted."""
    specs = [s for s in FIELDS.values() if s.category != "meta"]
    tgt = target_date(session)
    where: list[ColumnElement[bool]] = [
        _sym.c.tombstoned_at.is_(None),
        _sym.c.symbol.in_(symbols),
        or_(_snap.c.symbol.is_not(None), _fund.c.symbol.is_not(None)),
    ]
    if tgt is not None:
        where.append(
            or_(
                _snap.c.as_of_date.is_(None),
                _snap.c.as_of_date >= tgt - timedelta(days=settings.screener_stale_days),
            )
        )
    stmt = (
        select(_sym.c.symbol, *(spec.column.label(f"f{i}") for i, spec in enumerate(specs)))
        .select_from(_joined())
        .where(*where)
    )
    result = session.execute(stmt, {NOW_PARAM: int(now.timestamp())}).all()
    rows = {
        r.symbol: {spec.id: convert(spec, r[1 + i]) for i, spec in enumerate(specs)} for r in result
    }
    as_of = session.scalar(select(func.max(_snap.c.as_of_date)))
    return (as_of.isoformat() if as_of is not None else None), rows


def data_version(session: Session, now: datetime) -> str:
    """Cheap fingerprint of everything a scan reads: finished runs, snapshot/fundamentals
    rows, universe tables and watchlists (their updated-at stamps and row counts, so a delete
    changes it too), plus the day (for `daysToEarnings`). Part of the
    ETag, so a provider switch (cache wipe) or a list edit invalidates cached scans."""
    row = session.execute(
        select(
            select(func.max(_run.c.id)).where(_run.c.status.in_(_FINISHED)).scalar_subquery(),
            select(func.count()).select_from(_snap).scalar_subquery(),
            select(func.max(_snap.c.computed_at)).scalar_subquery(),
            select(func.count()).select_from(_fund).scalar_subquery(),
            select(func.max(_fund.c.quote_at)).scalar_subquery(),
            select(func.max(_fund.c.info_at)).scalar_subquery(),
            select(func.max(_sym.c.updated_at)).scalar_subquery(),
            select(func.count()).where(_sym.c.tombstoned_at.is_not(None)).scalar_subquery(),
            select(func.max(ScreenerList.__table__.c.updated_at)).scalar_subquery(),
            select(func.count()).select_from(ScreenerList.__table__).scalar_subquery(),
            select(func.count()).select_from(_member).scalar_subquery(),
            select(func.max(Watchlist.__table__.c.updated_at)).scalar_subquery(),
            select(func.count()).select_from(Watchlist.__table__).scalar_subquery(),
        )
    ).one()
    return "|".join(str(v) for v in (*row, now.date().isoformat()))
