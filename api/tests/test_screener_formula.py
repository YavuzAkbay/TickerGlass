"""Formula rules and columns of the screener (docs/design/server-screener.md §10): the shared
grammar vectors, SQL semantics on SQLite (division by zero, nulls, prev()), limits, and
hostile input that must fail before any SQL runs."""

import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, inspect, select
from sqlalchemy.dialects import postgresql, sqlite
from sqlalchemy.exc import DataError
from sqlalchemy.orm import Session
from test_screener_query import (
    NOW,
    NOW_TS,
    SETTINGS,
    TARGET,
    Statements,
    add_fund,
    add_snap,
    add_symbol,
)
from test_userdata import NullProvider

from tickerglass_api.app import create_app
from tickerglass_api.db import make_engine, run_migrations
from tickerglass_api.services.screener import formula as fx
from tickerglass_api.services.screener import query as q
from tickerglass_api.services.screener.fields import FIELDS
from tickerglass_api.services.screener.query import (
    ScanError,
    compile_filter,
    run_scan,
    validate_request,
)
from tickerglass_api.services.screener.schemas import FormulaRule, Rule, ScanRequest

VECTORS: dict[str, Any] = json.loads(
    (Path(__file__).parent / "data" / "formula_vectors.json").read_text(encoding="utf-8")
)
SYMBOLS = ["AAA", "BBB", "CCC"]


# ------------------------------------------------------------------ vectors


def test_vector_catalog_mirrors_the_registry() -> None:
    """The web client validates against the vectors' catalog: it must match `FIELDS`."""
    assert VECTORS["fields"] == [
        {"id": s.id, "type": s.type, "crossable": s.crossable, "fundamental": s.fundamental}
        for s in FIELDS.values()
    ]


@pytest.mark.parametrize("vec", VECTORS["valid"], ids=lambda v: repr(v["formula"])[:40])
def test_valid_vectors(vec: dict[str, Any]) -> None:
    assert fx.sexpr(fx.parse(vec["formula"], FIELDS)) == vec["sexpr"]


@pytest.mark.parametrize("vec", VECTORS["invalid"], ids=lambda v: repr(v["formula"])[:40])
def test_invalid_vectors(vec: dict[str, Any]) -> None:
    with pytest.raises(fx.FormulaError) as exc:
        fx.parse(vec["formula"], FIELDS, fundamentals=vec.get("fundamentals", True))
    assert (exc.value.code, exc.value.offset) == (vec["code"], vec["offset"])


def test_vectors_cover_every_error_code_and_limit() -> None:
    codes = {v["code"] for v in VECTORS["invalid"]}
    assert codes == {"bad_formula", "unknown_field", "field_unavailable", "too_complex"}
    assert any(v["offset"] == fx.MAX_LENGTH for v in VECTORS["invalid"])


def test_limits_at_the_boundary_parse() -> None:
    assert fx.parse("1" + " " * (fx.MAX_LENGTH - 1), FIELDS)
    nested = "(" * fx.MAX_DEPTH + "1" + ")" * fx.MAX_DEPTH
    assert fx.sexpr(fx.parse(nested, FIELDS)) == "1"
    # 64 nodes, shallow: max of 4 sums of 8 ones (15 nodes each) + 1 call + 3 spare literals.
    chain = "+".join(["1"] * 8)
    assert fx.parse(f"max({chain},{chain},{chain},{chain},1,1,1)", FIELDS)
    with pytest.raises(fx.FormulaError) as exc:
        fx.parse(f"max({chain},{chain},{chain},{chain},1,1,1,1)", FIELDS)
    assert exc.value.code == "too_complex"
    assert fx.parse("min(1, max(2, 3))", FIELDS)


# ----------------------------------------------------------------- compile


@pytest.fixture
def engine(tmp_path: Path) -> Engine:
    url = f"sqlite:///{tmp_path}/f.db"
    run_migrations(url)
    return make_engine(url)


@pytest.fixture
def session(engine: Engine) -> Iterator[Session]:
    """AAA complete; BBB with sma200 = 0 (a zero divisor); CCC without sma200."""
    with Session(engine) as s:
        for i, sym in enumerate(SYMBOLS, start=1):
            add_symbol(s, sym, i)
        add_snap(
            s,
            "AAA",
            last=110.0,
            prev_last=100.0,
            sma200=100.0,
            rsi14=72.0,
            prev_rsi14=68.0,
            chg1d_pct=2.0,
            days_since_cross=3,
        )
        add_snap(
            s,
            "BBB",
            last=50.0,
            prev_last=55.0,
            sma200=0.0,
            rsi14=28.0,
            prev_rsi14=33.0,
            chg1d_pct=-3.0,
            days_since_cross=10,
        )
        add_snap(s, "CCC", last=20.0, rsi14=40.0, prev_rsi14=40.0)
        add_fund(s, "AAA", mcap=5e9, next_earnings_ts=NOW_TS + 3 * 86400 + 100)
        s.commit()
        yield s


def req(*rules: Any, **kw: Any) -> ScanRequest:
    body: dict[str, Any] = {
        "universe": {"kind": "symbols", "symbols": SYMBOLS},
        "filter": {"op": "and", "rules": list(rules)} if rules else None,
        "sort": {"field": "last", "dir": "desc"},
        **kw,
    }
    return ScanRequest.model_validate(body)


def f(formula: str, op: str, value: Any) -> dict[str, Any]:
    return {"formula": formula, "op": op, "value": value}


def match(session: Session, formula: str, op: str, value: Any, **kw: Any) -> set[str]:
    out = run_scan(
        session, req(f(formula, op, value)), settings=SETTINGS, now=NOW, target=TARGET, **kw
    )
    return {r.symbol for r in out.rows}


def error(session: Session, request: ScanRequest, **kw: Any) -> ScanError:
    with pytest.raises(ScanError) as exc:
        run_scan(session, request, settings=SETTINGS, now=NOW, target=TARGET, **kw)
    return exc.value


def test_formula_rule_parses_as_its_own_node() -> None:
    parsed = req(f("last", ">", 1), {"field": "last", "op": ">", "value": 1})
    assert parsed.filter is not None
    assert isinstance(parsed.filter.rules[0], FormulaRule)
    assert isinstance(parsed.filter.rules[1], Rule)
    assert parsed.model_dump(by_alias=True)["filter"]["rules"][0] == f("last", ">", 1)


def test_arithmetic_and_comparisons(session: Session) -> None:
    assert match(session, "last / sma200", ">", 1.05) == {"AAA"}
    assert match(session, "last / sma200 - 1", "between", [0.09, 0.11]) == {"AAA"}
    assert match(session, "-(last / sma200)", "<", 0) == {"AAA"}
    assert match(session, "last * 2 + 1", ">=", 101) == {"AAA", "BBB"}
    assert match(session, "1 + 2 * 3", ">=", 7) == {"AAA", "BBB", "CCC"}
    assert match(session, "(1 + 2) * 3", "<=", 8) == set()
    assert match(session, "abs(chg1d)", ">", 2.5) == {"BBB"}


def test_division_by_zero_and_nulls_never_match(session: Session) -> None:
    # BBB: sma200 = 0 -> NULL; CCC: sma200 NULL. Neither side of any comparison matches.
    for op, value in ((">", -1e18), ("<", 1e18), ("between", [-1e18, 1e18])):
        assert match(session, "last / sma200", op, value) == {"AAA"}
    assert match(session, "last / 0", ">", -1e18) == set()
    assert match(session, "last / (sma200 - sma200)", "<", 1e18) == set()
    # min/max propagate nulls (CCC's sma200), unlike PostgreSQL's LEAST/GREATEST by default.
    assert match(session, "min(rsi14, sma200)", ">", 0) == {"AAA"}
    assert match(session, "max(rsi14, sma200)", "<", 1e18) == {"AAA", "BBB"}
    assert match(session, "min(rsi14, 50)", ">=", 28) == {"AAA", "BBB", "CCC"}


def test_integer_fields_divide_as_reals(session: Session) -> None:
    assert match(session, "daysSinceCross / 4", "between", [0.74, 0.76]) == {"AAA"}
    assert match(session, "daysToEarnings * 2", "between", [6, 6]) == {"AAA"}


def test_prev(session: Session) -> None:
    assert match(session, "rsi14 - prev(rsi14)", ">", 0) == {"AAA"}
    assert match(session, "rsi14 - prev(rsi14)", "<", 0) == {"BBB"}
    assert match(session, "last / prev(last) * 100 - 100", "between", [9.9, 10.1]) == {"AAA"}


def test_formula_mixes_with_plain_rules_and_groups(session: Session) -> None:
    request = req(
        {"field": "rsi14", "op": ">", "value": 20},
        {"op": "or", "rules": [f("last / sma200", ">", 1), f("abs(chg1d)", ">", 2.9)]},
    )
    out = run_scan(session, request, settings=SETTINGS, now=NOW, target=TARGET)
    assert {r.symbol for r in out.rows} == {"AAA", "BBB"}


def test_formula_columns(session: Session) -> None:
    key = "=last / sma200"
    out = run_scan(
        session,
        req(fields=[key, "last", "=rsi14 - prev(rsi14)"]),
        settings=SETTINGS,
        now=NOW,
        target=TARGET,
    )
    by = {r.symbol: r.values for r in out.rows}
    assert by["AAA"][key] == pytest.approx(1.1) and by["AAA"]["last"] == 110.0
    assert by["BBB"][key] is None and by["CCC"][key] is None
    assert by["AAA"]["=rsi14 - prev(rsi14)"] == pytest.approx(4.0)
    # A fundamental reference is null (not an error) when the provider lacks fundamentals.
    out = run_scan(
        session,
        req(fields=["=mcap / 1000000000"]),
        settings=SETTINGS,
        now=NOW,
        target=TARGET,
        fundamentals=False,
    )
    assert {r.values["=mcap / 1000000000"] for r in out.rows} == {None}
    out = run_scan(
        session, req(fields=["=mcap / 1000000000"]), settings=SETTINGS, now=NOW, target=TARGET
    )
    assert {r.symbol: r.values["=mcap / 1000000000"] for r in out.rows}["AAA"] == 5.0


def test_compiled_sql_binds_literals_and_guards_min_max() -> None:
    parsed = req(f("last * 12345.5 + min(rsi14, 7777)", ">", 4242))
    clause = compile_filter(parsed.filter)
    assert clause is not None
    for dialect, fn in ((sqlite.dialect(), "min("), (postgresql.dialect(), "least(")):
        sql = str(clause.compile(dialect=dialect))
        assert "12345" not in sql and "7777" not in sql and "4242" not in sql
        assert fn in sql
    pg = str(clause.compile(dialect=postgresql.dialect()))
    assert "CASE WHEN" in pg and "IS NULL" in pg


# ---------------------------------------------------------------- errors


def test_error_detail_has_path_and_offset(session: Session) -> None:
    exc = error(session, req({"field": "rsi14", "op": ">", "value": 1}, f("last + nope", ">", 1)))
    assert exc.detail() == {
        "code": "unknown_field",
        "message": "unknown field 'nope' (at character 7)",
        "path": "filter.rules[1].formula",
        "offset": 7,
    }
    exc = error(session, req(fields=["last", "=last +"]))
    assert (exc.code, exc.path, exc.offset) == ("bad_formula", "fields[1]", 6)
    exc = error(session, req(f("pe * 2", ">", 1)), fundamentals=False)
    assert (exc.code, exc.path, exc.offset) == ("field_unavailable", "filter.rules[0].formula", 0)
    # Plain errors keep the frozen three-key detail.
    exc = error(session, req({"field": "nope", "op": ">", "value": 1}))
    assert set(exc.detail()) == {"code", "message", "path"}


@pytest.mark.parametrize(
    ("rule", "code", "path"),
    [
        (f("last", "crossesAbove", 1), "bad_op", "filter.rules[0].op"),
        (f("last", "=", 1), "bad_op", "filter.rules[0].op"),
        (f("last", "in", [1]), "bad_op", "filter.rules[0].op"),
        (f("last", ">", "1"), "bad_value", "filter.rules[0].value"),
        (f("last", ">", True), "bad_value", "filter.rules[0].value"),
        (f("last", ">", {"field": "sma20"}), "bad_value", "filter.rules[0].value"),
        (f("last", ">", None), "bad_value", "filter.rules[0].value"),
        (f("last", "between", [2, 1]), "bad_value", "filter.rules[0].value"),
        (f("last", "between", [1]), "bad_value", "filter.rules[0].value"),
        (f("last", "between", 1), "bad_value", "filter.rules[0].value"),
        (f("last", ">", 1e400), "bad_value", "filter.rules[0].value"),
    ],
)
def test_rule_shape_errors(rule: dict[str, Any], code: str, path: str) -> None:
    with pytest.raises(ScanError) as exc:
        validate_request(req(rule))
    assert (exc.value.code, exc.value.path) == (code, path)


def test_formula_limits() -> None:
    rules = [f("last", ">", i) for i in range(fx.MAX_FORMULA_RULES)]
    validate_request(req(*rules))
    with pytest.raises(ScanError) as exc:
        validate_request(req(*rules, {"op": "or", "rules": [f("rsi14", ">", 1)]}))
    assert (exc.value.code, exc.value.path) == ("too_complex", "filter.rules[10].rules[0]")
    # Formula rules count toward the 50-rule budget.
    plain = [{"field": "last", "op": ">", "value": i} for i in range(41)]
    with pytest.raises(ScanError) as exc:
        validate_request(req(*plain, *rules))
    assert exc.value.code == "too_complex" and exc.value.path == "filter.rules[50]"
    cols = [f"=last * {i}" for i in range(fx.MAX_FORMULA_FIELDS)]
    validate_request(req(fields=cols))
    with pytest.raises(ScanError) as exc:
        validate_request(req(fields=[*cols, "=last * 9"]))
    assert (exc.value.code, exc.value.path) == ("too_complex", f"fields[{fx.MAX_FORMULA_FIELDS}]")
    with pytest.raises(ScanError) as exc:
        validate_request(req(f("x" * 201, ">", 1)))
    assert (exc.value.code, exc.value.offset) == ("too_complex", fx.MAX_LENGTH)


def test_sort_by_formula_is_not_supported() -> None:
    with pytest.raises(ScanError) as exc:
        validate_request(req(sort={"field": "=last", "dir": "asc"}))
    assert (exc.value.code, exc.value.path) == ("unknown_field", "sort.field")


# ------------------------------------------------------------------ safety

HOSTILE = [
    "last; DROP TABLE screener_snapshots; --",
    "last' OR '1'='1",
    'last" OR "1"="1',
    "last -- comment\nOR 1",
    "__class__",
    "__import__('os')",
    "last.__class__",
    "screener_snapshots.last",
    "(SELECT 1)",
    "last UNION SELECT 1",
    "lаst",  # Cyrillic a
    "ｌａｓｔ",  # full-width "last"
    "last​",  # zero-width space
    "last\x00",
    "1" * 25,
    "9" * 400,
    "1e999",
    "x" * 300,
    "sqlite_master",
    "rsi14 /* */ + 1",
    "prev(last; DROP)",
    "abs(last) OR 1=1",
]


def test_hostile_formulas_execute_no_sql(session: Session, engine: Engine) -> None:
    seen = Statements(engine)
    for text in HOSTILE:
        for request in (
            req(f(text, ">", 1)),
            req({"op": "or", "rules": [f(text, "between", [0, 1])]}),
            req(fields=["last", f"={text}"]),
        ):
            with pytest.raises(ScanError):
                run_scan(session, request, settings=SETTINGS, now=NOW, target=TARGET)
    assert seen.sql == []
    assert "screener_snapshots" in inspect(engine).get_table_names()


# ---------------------------------------------------------------- overflow


class Overflow(Exception):
    """Stands in for psycopg's `NumericValueOutOfRange`."""


def _overflowing(session: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    """Statements computing a formula division fail like a PostgreSQL float overflow."""
    real_execute, real_scalar = session.execute, session.scalar

    def check(stmt: Any) -> None:
        if "nullif" in str(stmt).lower():
            raise DataError(str(stmt), {}, Overflow("value out of range: overflow"))

    def execute(stmt: Any, *a: Any, **kw: Any) -> Any:
        check(stmt)
        return real_execute(stmt, *a, **kw)

    def scalar(stmt: Any, *a: Any, **kw: Any) -> Any:
        check(stmt)
        return real_scalar(stmt, *a, **kw)

    monkeypatch.setattr(session, "execute", execute)
    monkeypatch.setattr(session, "scalar", scalar)


@pytest.mark.parametrize("savepoint", [False, True])
def test_database_overflow_is_a_422(
    session: Session, monkeypatch: pytest.MonkeyPatch, savepoint: bool
) -> None:
    monkeypatch.setattr(q, "_needs_savepoint", lambda s: savepoint)
    _overflowing(session, monkeypatch)
    exc = error(
        session, req({"field": "rsi14", "op": ">", "value": 1}, f("mcap * mcap / 2", ">", 1))
    )
    assert exc.status == 422
    assert exc.detail() == {
        "code": "formula_overflow",
        "message": "a formula's value is out of the database's numeric range",
        "path": "filter.rules[1].formula",
    }
    # The session (and, with the savepoint, its outer transaction) is still usable.
    monkeypatch.undo()
    assert session.scalar(select(q._sym.c.symbol).limit(1)) is not None


def test_overflow_in_a_formula_column_points_at_the_column(
    session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    def boom(*a: Any, **kw: Any) -> Any:
        raise DataError("SELECT", {}, Overflow("overflow"))

    monkeypatch.setattr(session, "execute", boom)
    monkeypatch.setattr(session, "scalar", boom)
    exc = error(session, req(fields=["last", "=last * 1000 / 7"]))
    assert (exc.code, exc.path) == ("formula_overflow", "fields[1]")


def test_data_errors_without_formulas_are_not_masked(
    session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    def boom(*a: Any, **kw: Any) -> Any:
        raise DataError("SELECT", {}, Overflow("other"))

    monkeypatch.setattr(session, "scalar", boom)
    with pytest.raises(DataError):
        run_scan(session, req(), settings=SETTINGS, now=NOW, target=TARGET)


def test_formula_paths() -> None:
    request = req(
        {"field": "last", "op": ">", "value": 1},
        {"op": "or", "rules": [f("last", ">", 1)]},
        f("rsi14", ">", 1),
        fields=["last", "=last * 2"],
    )
    assert q.formula_paths(request) == [
        "filter.rules[1].rules[0].formula",
        "filter.rules[2].formula",
        "fields[1]",
    ]


# ------------------------------------------------------------------ routes


@pytest.fixture
def client(tmp_path: Path) -> Iterator[TestClient]:
    app = create_app(provider=NullProvider(), database_url=f"sqlite:///{tmp_path}/r.db")
    with TestClient(app) as c:
        yield c


def test_scan_route_422_with_offset_and_no_sql(client: TestClient) -> None:
    engine: Engine = client.app.state.engine  # type: ignore[attr-defined]
    seen = Statements(engine)
    body = {
        "universe": {"kind": "symbols", "symbols": SYMBOLS},
        "filter": {"op": "and", "rules": [f("last; DROP TABLE bars", ">", 1)]},
    }
    res = client.post("/api/screener/scan", json=body)
    assert res.status_code == 422
    assert res.json()["detail"] == {
        "code": "bad_formula",
        "message": "unexpected character (at character 4)",
        "path": "filter.rules[0].formula",
        "offset": 4,
    }
    assert seen.sql == []
    ok = client.post(
        "/api/screener/scan",
        json={**body, "filter": {"op": "and", "rules": [f("last / sma200", ">", 1)]}},
    )
    assert ok.status_code == 200, ok.text


def test_saved_screen_round_trips_formulas(client: TestClient) -> None:
    spec = {
        "schemaVersion": 1,
        "universe": {"kind": "class", "cls": "stocks"},
        "filter": {
            "op": "and",
            "rules": [
                {"field": "rsi14", "op": "<", "value": 30},
                f("last / sma200 - 1", "between", [-0.05, 0.05]),
            ],
        },
        "sort": {"field": "rsi14", "dir": "asc"},
        "columns": ["last", "=last / sma200"],
    }
    res = client.post("/api/screener/screens", json={"name": "F", "spec": spec})
    assert res.status_code == 201, res.text
    got = client.get(f"/api/screener/screens/{res.json()['id']}").json()
    assert got["spec"] == spec
    bad = {**spec, "filter": {"op": "and", "rules": [f("last +", ">", 1)]}}
    res = client.post("/api/screener/screens", json={"name": "B", "spec": bad})
    assert res.status_code == 422
    assert "bad_formula" in res.text
