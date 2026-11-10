"""Scan engine: registry, operators, universes, staleness, sorting, safety
(docs/design/server-screener.md §4)."""

from collections.abc import Iterator
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError
from sqlalchemy import Engine, event, inspect
from sqlalchemy.orm import Session

from tickerglass_api.db import make_engine, run_migrations
from tickerglass_api.models import (
    ScreenerFundamental,
    ScreenerList,
    ScreenerListMember,
    ScreenerRun,
    ScreenerSnapshot,
    ScreenerSymbol,
    Watchlist,
)
from tickerglass_api.services.screener import universe as uv
from tickerglass_api.services.screener.fields import FIELDS, definitions
from tickerglass_api.services.screener.query import (
    ScanError,
    UniverseNotFound,
    compile_filter,
    current_cutoff,
    run_scan,
    snapshot_values,
    validate_request,
)
from tickerglass_api.services.screener.schemas import ScanRequest
from tickerglass_api.settings import Settings

NOW = datetime(2026, 11, 6, 12, 0, tzinfo=UTC)
NOW_TS = int(NOW.timestamp())
TARGET = date(2026, 11, 5)
SETTINGS = Settings(_env_file=None)  # type: ignore[call-arg]

FROZEN_IDS = [
    "name",
    "cls",
    "group",
    "exchange",
    "last",
    "chg1d",
    "gapPct",
    "volume",
    "avgVol30",
    "relVol",
    "avgDollarVol30",
    "perf1w",
    "perf1m",
    "perf3m",
    "perf6m",
    "perfYtd",
    "perf1y",
    "rsi14",
    "sma20",
    "sma50",
    "sma200",
    "pctVsSma20",
    "pctVsSma50",
    "pctVsSma200",
    "hi52",
    "lo52",
    "pctOffHi52",
    "pctOffLo52",
    "newHi52",
    "newLo52",
    "atr14",
    "atrPct",
    "smaCross",
    "daysSinceCross",
    "mcap",
    "pe",
    "fwdPe",
    "eps",
    "divYield",
    "beta",
    "sector",
    "industry",
    "nextEarnings",
    "daysToEarnings",
]


@pytest.fixture
def engine(tmp_path: Path) -> Engine:
    url = f"sqlite:///{tmp_path}/q.db"
    run_migrations(url)
    return make_engine(url)


def add_symbol(session: Session, symbol: str, rank: int, **kw: Any) -> None:
    session.add(
        ScreenerSymbol(
            symbol=symbol,
            cls=kw.pop("cls", "stocks"),
            name=kw.pop("name", f"{symbol} Inc"),
            grp=kw.pop("grp", "Tech"),
            exchange=kw.pop("exchange", "NASDAQ"),
            rank=rank,
            cap_static=None,
            source="bundled",
            fail_count=0,
            updated_at=NOW,
            **kw,
        )
    )


def add_snap(session: Session, symbol: str, as_of: date = TARGET, **cols: Any) -> None:
    session.add(
        ScreenerSnapshot(
            symbol=symbol,
            provider="yahoo",
            as_of_date=as_of,
            bar_ts=0,
            computed_at=NOW,
            bars_count=300,
            **cols,
        )
    )


def add_run(
    session: Session,
    status: str = "done",
    target: date = TARGET,
    *,
    kind: str = "snapshot",
    finished_at: datetime | None = NOW,
) -> None:
    session.add(
        ScreenerRun(
            kind=kind,
            trigger="manual",
            provider="yahoo",
            target_date=target,
            status=status,
            total=1,
            done=1,
            failed=0,
            tokens=1,
            started_at=NOW,
            finished_at=finished_at,
        )
    )


def add_fund(session: Session, symbol: str, **cols: Any) -> None:
    session.add(ScreenerFundamental(symbol=symbol, provider="yahoo", **cols))


@pytest.fixture
def session(engine: Engine) -> Iterator[Session]:
    """Seven symbols: AAA/BBB with full data, CCC all-null snapshot, DDD a day behind (stale),
    EEE too old (excluded), FFF without a snapshot, TTT tombstoned."""
    with Session(engine) as s:
        for i, sym in enumerate(["AAA", "BBB", "CCC", "DDD", "EEE", "FFF", "TTT"], start=1):
            add_symbol(
                s,
                sym,
                i,
                cls="etfs" if sym == "BBB" else "stocks",
                grp="Energy" if sym == "BBB" else "Tech",
                exchange=None if sym == "FFF" else "NASDAQ",
                **({"tombstoned_at": NOW} if sym == "TTT" else {}),
            )
        add_snap(
            s,
            "AAA",
            last=110.0,
            prev_last=99.0,
            sma20=100.0,
            prev_sma20=100.0,
            sma50=90.0,
            prev_sma50=105.0,
            sma200=80.0,
            rsi14=72.0,
            prev_rsi14=68.0,
            chg1d_pct=2.0,
            volume=1000.0,
            avg_vol30=500.0,
            rel_vol=2.0,
            hi52=120.0,
            lo52=60.0,
            new_hi52=True,
            new_lo52=False,
            cross_state=1,
            days_since_cross=3,
            perf_1m=10.0,
            pct_vs_sma20=10.0,
        )
        add_snap(
            s,
            "BBB",
            last=50.0,
            prev_last=55.0,
            sma20=60.0,
            prev_sma20=52.0,
            sma50=70.0,
            prev_sma50=70.0,
            rsi14=28.0,
            prev_rsi14=33.0,
            chg1d_pct=-3.0,
            volume=200.0,
            avg_vol30=400.0,
            rel_vol=0.5,
            hi52=90.0,
            new_hi52=False,
            cross_state=-1,
            days_since_cross=10,
            perf_1m=-5.0,
        )
        add_snap(s, "CCC")
        add_snap(s, "DDD", date(2026, 11, 2), last=20.0, rsi14=50.0, prev_rsi14=50.0)
        add_snap(s, "EEE", date(2026, 10, 20), last=30.0, rsi14=40.0)
        add_snap(s, "TTT", last=500.0)
        add_fund(
            s,
            "AAA",
            mcap=5e9,
            beta=1.2,
            sector="Technology",
            industry="Software",
            next_earnings_ts=NOW_TS + 3 * 86400 + 100,
        )
        add_fund(
            s,
            "BBB",
            mcap=20e9,
            beta=0.8,
            sector="Energy",
            next_earnings_ts=NOW_TS - 2 * 86400,
        )
        s.commit()
        yield s


def req(filter: Any = None, **kw: Any) -> ScanRequest:
    body: dict[str, Any] = {
        "universe": {
            "kind": "symbols",
            "symbols": ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF", "TTT"],
        },
        "filter": filter,
        "sort": {"field": "last", "dir": "desc"},
        **kw,
    }
    return ScanRequest.model_validate(body)


def rule(field: str, op: str, value: Any) -> dict[str, Any]:
    return {"field": field, "op": op, "value": value}


def group(*rules: Any, op: str = "and") -> dict[str, Any]:
    return {"op": op, "rules": list(rules)}


def scan(session: Session, filter: Any = None, **kw: Any) -> list[str]:
    out = run_scan(session, req(filter, **kw), settings=SETTINGS, now=NOW, target=TARGET)
    return [r.symbol for r in out.rows]


def match(session: Session, field: str, op: str, value: Any) -> set[str]:
    return set(scan(session, group(rule(field, op, value))))


def error(session: Session, filter: Any = None, **kw: Any) -> ScanError:
    with pytest.raises(ScanError) as exc:
        run_scan(session, req(filter, **kw), settings=SETTINGS, now=NOW, target=TARGET)
    return exc.value


# ----------------------------------------------------------------- registry


def test_registry_has_every_frozen_field() -> None:
    assert list(FIELDS) == FROZEN_IDS
    for spec in FIELDS.values():
        assert spec.ops, spec.id
        if spec.crossable:
            assert "crossesAbove" in spec.ops and "crossesBelow" in spec.ops
        else:
            assert "crossesAbove" not in spec.ops
    assert {f for f, s in FIELDS.items() if s.crossable} == {
        "last",
        "rsi14",
        "sma20",
        "sma50",
        "sma200",
    }
    assert FIELDS["rsi14"].ops == (">", "<", ">=", "<=", "between", "crossesAbove", "crossesBelow")
    assert FIELDS["rsi14"].dimension == "oscillator"
    assert FIELDS["newHi52"].ops == ("=",)
    assert FIELDS["smaCross"].enum_values == ("golden", "death")
    assert FIELDS["last"].dimension == FIELDS["sma200"].dimension == FIELDS["hi52"].dimension


def test_definitions_mark_fundamentals_unavailable() -> None:
    on = {d.id: d for d in definitions(fundamentals=True)}
    off = {d.id: d for d in definitions(fundamentals=False)}
    fundamental = {i for i, s in FIELDS.items() if s.fundamental}
    assert fundamental == {
        "mcap",
        "pe",
        "fwdPe",
        "eps",
        "divYield",
        "beta",
        "sector",
        "industry",
        "nextEarnings",
        "daysToEarnings",
    }
    assert all(on[i].available for i in on)
    assert {i for i, d in off.items() if not d.available} == fundamental
    dumped = on["rsi14"].model_dump(by_alias=True)
    assert dumped == {
        "id": "rsi14",
        "category": "technical",
        "type": "number",
        "unit": None,
        "dimension": "oscillator",
        "ops": [">", "<", ">=", "<=", "between", "crossesAbove", "crossesBelow"],
        "crossable": True,
        "available": True,
        "enumValues": None,
    }


# ---------------------------------------------------------------- operators


@pytest.mark.parametrize(
    ("field", "op", "value", "expected"),
    [
        ("last", ">", 60, {"AAA"}),
        ("last", "<", 40, {"DDD"}),
        ("last", ">=", 50, {"AAA", "BBB"}),
        ("last", "<=", 50, {"BBB", "DDD"}),
        ("last", "between", [20, 50], {"BBB", "DDD"}),
        ("rsi14", ">", -1000, {"AAA", "BBB", "DDD"}),  # nulls never match
        ("newHi52", "=", True, {"AAA"}),
        ("newHi52", "=", False, {"BBB"}),
        ("newLo52", "=", False, {"AAA"}),
        ("smaCross", "=", "golden", {"AAA"}),
        ("smaCross", "=", "death", {"BBB"}),
        ("smaCross", "in", ["golden", "death"], {"AAA", "BBB"}),
        ("daysSinceCross", "=", 3, {"AAA"}),
        ("daysSinceCross", "<=", 5, {"AAA"}),
        ("sector", "=", "Technology", {"AAA"}),
        ("sector", "in", ["Technology", "Energy"], {"AAA", "BBB"}),
        ("industry", "=", "Software", {"AAA"}),
        ("mcap", ">", 10e9, {"BBB"}),
        ("beta", "between", [1, 2], {"AAA"}),
        ("group", "=", "Energy", {"BBB"}),
        ("group", "in", ["Energy", "Nope"], {"BBB"}),
        ("cls", "=", "etfs", {"BBB"}),
        ("exchange", "=", "NASDAQ", {"AAA", "BBB", "CCC", "DDD"}),
        ("name", "=", "AAA Inc", {"AAA"}),
        ("relVol", ">", 1, {"AAA"}),
        ("perf1m", "<", 0, {"BBB"}),
        ("daysToEarnings", "between", [0, 5], {"AAA"}),
        ("daysToEarnings", "<", 0, {"BBB"}),
        ("nextEarnings", ">", NOW_TS, {"AAA"}),
    ],
)
def test_operators(session: Session, field: str, op: str, value: Any, expected: set[str]) -> None:
    assert match(session, field, op, value) == expected


def test_crosses(session: Session) -> None:
    assert match(session, "rsi14", "crossesAbove", 70) == {"AAA"}
    assert match(session, "rsi14", "crossesAbove", 60) == set()  # was already above
    assert match(session, "rsi14", "crossesBelow", 30) == {"BBB"}
    assert match(session, "last", "crossesAbove", {"field": "sma20"}) == {"AAA"}
    assert match(session, "last", "crossesBelow", {"field": "sma20"}) == {"BBB"}
    assert match(session, "sma20", "crossesAbove", {"field": "sma50"}) == {"AAA"}
    # CCC/DDD/FFF have a null side: never a cross.
    assert match(session, "last", "crossesAbove", 100) == {"AAA"}
    assert match(session, "last", "crossesBelow", 52) == {"BBB"}
    assert match(session, "last", "crossesAbove", 10) == set()  # AAA was already above


def test_cross_rejects_non_crossable(session: Session) -> None:
    err = error(session, group(rule("pctVsSma20", "crossesAbove", 1)))
    assert (err.code, err.path) == ("bad_op", "filter.rules[0].op")
    err = error(session, group(rule("last", "crossesAbove", {"field": "hi52"})))
    assert (err.code, err.path) == ("bad_value", "filter.rules[0].value.field")


def test_pct_operators(session: Session) -> None:
    assert match(session, "last", "abovePct", {"field": "sma50", "pct": 10}) == {"AAA"}
    assert match(session, "last", "abovePct", {"field": "sma50", "pct": 30}) == set()
    assert match(session, "last", "belowPct", {"field": "sma50", "pct": 20}) == {"BBB"}
    assert match(session, "last", "belowPct", {"field": "sma50", "pct": 40}) == set()
    for bad in (5, {"field": "sma50"}, {"field": "sma50", "pct": "x"}, {"pct": 1}):
        assert error(session, group(rule("last", "abovePct", bad))).code == "bad_value"
    assert error(session, group(rule("rsi14", "abovePct", {"field": "rsi14", "pct": 1}))).code == (
        "bad_op"
    )


def test_field_operands_need_the_same_dimension(session: Session) -> None:
    assert match(session, "last", ">", {"field": "sma20"}) == {"AAA"}
    assert match(session, "volume", ">", {"field": "avgVol30"}) == {"AAA"}
    for field, other in (
        ("last", "rsi14"),
        ("volume", "last"),
        ("rsi14", "chg1d"),
        ("last", "mcap"),
    ):
        err = error(session, group(rule(field, ">", {"field": other})))
        assert (err.code, err.path) == ("bad_value", "filter.rules[0].value.field")
    err = error(session, group(rule("last", ">", {"field": "nope"})))
    assert (err.code, err.path) == ("unknown_field", "filter.rules[0].value.field")


def test_field_operand_cannot_be_the_field_itself(session: Session) -> None:
    for op, value in (
        (">", {"field": "last"}),
        ("crossesAbove", {"field": "last"}),
        ("abovePct", {"field": "last", "pct": 5}),
        ("belowPct", {"field": "last", "pct": 5}),
    ):
        err = error(session, group(rule("last", op, value)))
        assert (err.code, err.path) == ("bad_value", "filter.rules[0].value.field"), op


def test_nulls_never_match(session: Session) -> None:
    everything = set(scan(session))
    assert everything == {"AAA", "BBB", "CCC", "DDD", "FFF"}
    for op, value in ((">", -1e18), ("<", 1e18), ("between", [-1e18, 1e18])):
        got = match(session, "rsi14", op, value)
        assert got == {"AAA", "BBB", "DDD"}  # CCC, FFF have no rsi14
    assert match(session, "smaCross", "in", ["golden", "death"]) == {"AAA", "BBB"}


def test_groups(session: Session) -> None:
    f = group(rule("last", ">", 40), rule("rsi14", "<", 60))
    assert set(scan(session, f)) == {"BBB"}
    f = group(rule("last", ">", 100), rule("rsi14", "<", 30), op="or")
    assert set(scan(session, f)) == {"AAA", "BBB"}
    nested = group(
        rule("last", ">", 100),
        group(rule("rsi14", "<", 60), rule("last", "<", 60)),
        op="or",
    )
    assert set(scan(session, nested)) == {"AAA", "BBB", "DDD"}
    assert set(scan(session, group())) == set(scan(session, None))  # empty group: no constraint
    assert set(scan(session, group(group(), group(op="or")))) == set(scan(session))


def test_limits(session: Session) -> None:
    deep = group(group(group(rule("last", ">", 1))))
    err = error(session, deep)
    assert err.code == "too_complex" and err.path == "filter.rules[0].rules[0]"
    assert set(scan(session, group(group(rule("last", ">", 1))))) == {"AAA", "BBB", "DDD"}

    fifty = [rule("last", ">", i) for i in range(50)]
    assert scan(session, group(*fifty)) is not None
    err = error(session, group(*fifty, rule("last", ">", 0)))
    assert err.code == "too_complex" and err.path == "filter.rules[50]"
    split = group(group(*fifty[:25]), group(*fifty[25:], rule("last", ">", 0)), op="or")
    assert error(session, split).code == "too_complex"


def test_group_count_is_bounded(session: Session) -> None:
    ok = group(*(group(rule("last", ">", i)) for i in range(19)))  # root + 19 = 20 groups
    assert set(scan(session, ok)) == {"AAA", "BBB", "DDD"}
    err = error(session, group(*(group() for _ in range(20))))  # empty groups count too
    assert err.code == "too_complex" and err.path == "filter.rules[19]"
    assert "groups" in err.message


def test_days_to_earnings_is_whole_floored_days(session: Session) -> None:
    for i, (sym, offset) in enumerate(
        [("G75", 7.5 * 86400), ("G70", 7 * 86400), ("G80", 8 * 86400 - 1), ("GNEG", -0.5 * 86400)]
    ):
        add_symbol(session, sym, 50 + i)
        add_fund(session, sym, next_earnings_ts=NOW_TS + int(offset))
    session.commit()
    names = ["G75", "G70", "G80", "GNEG"]
    universe = {"kind": "symbols", "symbols": names}

    def days(op: str, value: Any) -> set[str]:
        out = run_scan(
            session,
            req(
                group(rule("daysToEarnings", op, value)),
                universe=universe,
                fields=["daysToEarnings"],
            ),
            settings=SETTINGS,
            now=NOW,
            target=TARGET,
        )
        return {r.symbol for r in out.rows}

    # 7.5 days is shown as 7 and `= 7` matches it (as it does 7.0 and 7.99 days).
    assert days("=", 7) == {"G75", "G70", "G80"}
    assert days("=", 8) == set()
    assert days("<=", 7) == {"G75", "G70", "G80", "GNEG"}
    assert days("<", 7) == {"GNEG"}
    assert days("=", -1) == {"GNEG"}  # half a day ago floors to -1, like the response
    assert days("between", [7, 7]) == {"G75", "G70", "G80"}
    out = run_scan(
        session,
        req(None, universe=universe, fields=["daysToEarnings"]),
        settings=SETTINGS,
        now=NOW,
        target=TARGET,
    )
    shown = {r.symbol: r.values["daysToEarnings"] for r in out.rows}
    assert shown == {"G75": 7, "G70": 7, "G80": 7, "GNEG": -1}
    assert all(isinstance(v, int) for v in shown.values())


def test_bad_values(session: Session) -> None:
    cases: list[tuple[str, str, Any]] = [
        ("last", ">", "5"),
        ("last", ">", True),
        ("last", ">", None),
        ("last", ">", float("inf")),
        ("last", ">", [1]),
        ("last", "between", [1]),
        ("last", "between", [5, 1]),
        ("last", "between", ["a", "b"]),
        ("last", "between", 5),
        ("newHi52", "=", 1),
        ("newHi52", "=", "true"),
        ("smaCross", "=", "sideways"),
        ("smaCross", "in", ["golden", "x"]),
        ("smaCross", "=", 1),
        ("sector", "in", "Tech"),
        ("sector", "in", []),
        ("sector", "in", [1]),
        ("sector", "in", ["x"] * 101),
        ("sector", "=", 5),
        ("cls", "=", "bonds"),
        ("daysSinceCross", "=", "3"),
    ]
    for field, op, value in cases:
        err = error(session, group(rule(field, op, value)))
        assert err.code == "bad_value", (field, op, value)
        assert err.path.startswith("filter.rules[0].value"), (field, op, value)


def test_bad_op_and_unknown_field(session: Session) -> None:
    for field, op in (
        ("last", "="),
        ("last", "in"),
        ("newHi52", ">"),
        ("sector", ">"),
        ("sector", "between"),
        ("smaCross", ">"),
        ("last", "contains"),
        ("last", ""),
    ):
        err = error(session, group(rule(field, op, 1)))
        assert (err.code, err.path) == ("bad_op", "filter.rules[0].op"), (field, op)
    for field in ("nope", "", "LAST", "last ", "last; DROP TABLE screener_symbols"):
        err = error(session, group(rule(field, ">", 1)))
        assert (err.code, err.path) == ("unknown_field", "filter.rules[0].field"), field
    err = error(session, group(group(rule("last", ">", 1), rule("x", ">", 1))))
    assert err.path == "filter.rules[0].rules[1].field"


def test_unavailable_fundamentals(session: Session) -> None:
    f = req(group(rule("mcap", ">", 1)))
    with pytest.raises(ScanError) as exc:
        run_scan(session, f, settings=SETTINGS, now=NOW, target=TARGET, fundamentals=False)
    assert (exc.value.code, exc.value.path) == ("field_unavailable", "filter.rules[0].field")
    with pytest.raises(ScanError) as exc:
        run_scan(
            session,
            req(sort={"field": "pe", "dir": "asc"}),
            settings=SETTINGS,
            now=NOW,
            target=TARGET,
            fundamentals=False,
        )
    assert (exc.value.code, exc.value.path) == ("field_unavailable", "sort.field")
    with pytest.raises(ScanError):
        validate_request(f, fundamentals=False)
    validate_request(f)
    # A requested column is simply null.
    out = run_scan(
        session,
        req(fields=["last", "mcap"]),
        settings=SETTINGS,
        now=NOW,
        target=TARGET,
        fundamentals=False,
    )
    assert out.rows[0].values == {"last": 110.0, "mcap": None}


# ------------------------------------------------- stale rows and coverage


def test_staleness(session: Session) -> None:
    out = run_scan(session, req(), settings=SETTINGS, now=NOW, target=TARGET)
    by = {r.symbol: r for r in out.rows}
    assert set(by) == {"AAA", "BBB", "CCC", "DDD", "FFF"}  # EEE too old, TTT tombstoned
    assert by["DDD"].stale is True
    assert not any(by[s].stale for s in ("AAA", "BBB", "CCC", "FFF"))
    assert out.coverage.universe == 6  # tombstoned TTT excluded
    assert out.coverage.with_snapshot == 4  # AAA BBB CCC DDD; not EEE (old) nor FFF (none)
    assert out.provider == "yahoo"
    # A filter drops the snapshot-less symbol.
    assert "FFF" not in scan(session, group(rule("last", ">", -1)))
    # A newer target makes AAA stale and pushes DDD (11-02) past the 7 day window.
    out = run_scan(session, req(), settings=SETTINGS, now=NOW, target=date(2026, 11, 10))
    by = {r.symbol: r for r in out.rows}
    assert "DDD" not in by and by["AAA"].stale is True


def test_as_of_is_the_latest_finished_snapshot_run(session: Session) -> None:
    # Snapshot rows exist (a first run in flight), but no run has finished: no asOf yet.
    add_run(session, "running", finished_at=None)
    add_run(session, "failed", date(2026, 11, 4))
    add_run(session, "done", date(2026, 11, 4), kind="fundamentals")
    session.commit()
    out = run_scan(session, req(), settings=SETTINGS, now=NOW, target=TARGET)
    assert out.as_of is None and out.computed_at is None and out.total == 5
    add_run(session, "partial", date(2026, 11, 4), finished_at=datetime(2026, 11, 5, 3, tzinfo=UTC))
    session.commit()
    out = run_scan(session, req(), settings=SETTINGS, now=NOW, target=TARGET)
    assert out.as_of == "2026-11-04" and out.computed_at == "2026-11-05T03:00:00+00:00"
    add_run(session, "done", TARGET)
    session.commit()
    out = run_scan(session, req(), settings=SETTINGS, now=NOW, target=TARGET)
    assert out.as_of == "2026-11-05" and out.computed_at == NOW.isoformat()


def test_target_comes_from_the_newest_finished_run(session: Session) -> None:
    def run(status: str, target: date, kind: str = "snapshot") -> None:
        session.add(
            ScreenerRun(
                kind=kind,
                trigger="manual",
                provider="yahoo",
                target_date=target,
                status=status,
                total=1,
                done=1,
                failed=0,
                tokens=1,
                started_at=NOW,
            )
        )
        session.commit()

    plain = run_scan(session, req(), settings=SETTINGS, now=NOW)  # newest snapshot date
    assert next(r for r in plain.rows if r.symbol == "DDD").stale is True
    run("running", date(2026, 11, 20))  # unfinished runs do not count
    run("done", date(2026, 11, 10), kind="fundamentals")  # nor do other kinds
    assert not next(
        r for r in run_scan(session, req(), settings=SETTINGS, now=NOW).rows if r.symbol == "AAA"
    ).stale
    run("partial", date(2026, 11, 6))
    out = run_scan(session, req(), settings=SETTINGS, now=NOW)
    assert next(r for r in out.rows if r.symbol == "AAA").stale is True


# ------------------------------------------------- sorting and paging


def test_sort_nulls_last_both_directions(session: Session) -> None:
    desc = scan(session, sort={"field": "rsi14", "dir": "desc"})
    assert desc == ["AAA", "DDD", "BBB", "CCC", "FFF"]
    asc = scan(session, sort={"field": "rsi14", "dir": "asc"})
    assert asc == ["BBB", "DDD", "AAA", "CCC", "FFF"]
    s = scan(session, sort={"field": "sector", "dir": "asc"})
    assert s[:2] == ["BBB", "AAA"] and set(s[2:]) == {"CCC", "DDD", "FFF"}
    b = scan(session, sort={"field": "smaCross", "dir": "desc"})
    assert b[:2] == ["AAA", "BBB"]


def test_pagination_and_total(session: Session) -> None:
    kw = {"sort": {"field": "last", "dir": "desc"}}
    full = run_scan(session, req(**kw), settings=SETTINGS, now=NOW, target=TARGET)
    assert [r.symbol for r in full.rows] == ["AAA", "BBB", "DDD", "CCC", "FFF"]
    assert full.total == 5 and (full.offset, full.limit) == (0, 100)
    page = run_scan(
        session, req(limit=2, offset=1, **kw), settings=SETTINGS, now=NOW, target=TARGET
    )
    assert [r.symbol for r in page.rows] == ["BBB", "DDD"]
    assert page.total == 5 and (page.offset, page.limit) == (1, 2)
    past = run_scan(
        session, req(limit=2, offset=10, **kw), settings=SETTINGS, now=NOW, target=TARGET
    )
    assert past.rows == [] and past.total == 5
    filtered = run_scan(
        session,
        req(group(rule("last", ">", 0)), limit=1, **kw),
        settings=SETTINGS,
        now=NOW,
        target=TARGET,
    )
    assert filtered.total == 3 and len(filtered.rows) == 1
    for bad in ({"limit": 0}, {"limit": 501}, {"offset": -1}):
        with pytest.raises(ValidationError):
            req(**bad)


def test_ties_break_on_rank_then_symbol(session: Session) -> None:
    assert scan(session, sort={"field": "cls", "dir": "asc"}) == ["BBB", "AAA", "CCC", "DDD", "FFF"]


def test_fields_selection_and_conversion(session: Session) -> None:
    out = run_scan(
        session,
        req(fields=["smaCross", "daysToEarnings", "newHi52", "sector", "name", "cls", "last"]),
        settings=SETTINGS,
        now=NOW,
        target=TARGET,
    )
    by = {r.symbol: r for r in out.rows}
    assert by["AAA"].values == {
        "smaCross": "golden",
        "daysToEarnings": 3,
        "newHi52": True,
        "sector": "Technology",
        "name": "AAA Inc",
        "cls": "stocks",
        "last": 110.0,
    }
    assert by["BBB"].values["smaCross"] == "death" and by["BBB"].values["daysToEarnings"] == -2
    assert by["CCC"].values["smaCross"] is None and by["CCC"].values["daysToEarnings"] is None
    assert by["AAA"].cls == "stocks" and by["BBB"].group == "Energy"
    assert by["FFF"].exchange is None and by["AAA"].exchange == "NASDAQ"
    default = run_scan(session, req(), settings=SETTINGS, now=NOW, target=TARGET)
    assert "last" in default.rows[0].values and "mcap" in default.rows[0].values
    err = error(session, fields=["last", "bogus"])
    assert (err.code, err.path) == ("unknown_field", "fields[1]")


def test_response_json_is_camel_case(session: Session) -> None:
    out = run_scan(session, req(limit=1), settings=SETTINGS, now=NOW, target=TARGET)
    body = out.model_dump(mode="json", by_alias=True)
    assert set(body) == {
        "asOf",
        "computedAt",
        "provider",
        "total",
        "offset",
        "limit",
        "coverage",
        "rows",
    }
    assert set(body["coverage"]) == {"universe", "withSnapshot"}
    assert set(body["rows"][0]) == {
        "symbol",
        "name",
        "cls",
        "group",
        "exchange",
        "stale",
        "values",
    }


# --------------------------------------------------------------- universes


def test_class_list_and_watchlist_universes(session: Session) -> None:
    uv.seed_bundle(session, now=NOW)
    dup = sorted(set(uv.class_symbols("etfs")) & set(uv.class_symbols("commodities")))[0]
    for sym in ("AAPL", dup, "BTC-USD"):
        if session.get(ScreenerSnapshot, sym) is None:
            add_snap(session, sym, last=1.0)
    session.add(
        Watchlist(
            id="w1",
            name="W",
            items=[
                {"type": "symbol", "symbol": "aapl"},
                {"type": "section", "id": "s", "title": "S", "collapsed": False},
                {"type": "symbol", "symbol": "BTC-USD"},
            ],
            revision=1,
            created_at=NOW,
            updated_at=NOW,
        )
    )
    session.commit()

    def symbols(universe: dict[str, Any]) -> set[str]:
        body = {"universe": universe, "filter": None, "limit": 500, "fields": ["last"]}
        out = run_scan(
            session, ScanRequest.model_validate(body), settings=SETTINGS, now=NOW, target=TARGET
        )
        return {r.symbol for r in out.rows if r.values["last"] is not None}

    assert "AAPL" in symbols({"kind": "class", "cls": "stocks"})
    assert "AAPL" not in symbols({"kind": "class", "cls": "crypto"})
    assert "BTC-USD" in symbols({"kind": "class", "cls": "crypto"})
    # A symbol stored once as an etf is still in the commodities class universe.
    assert session.get(ScreenerSymbol, dup).cls == "etfs"  # type: ignore[union-attr]
    assert dup in symbols({"kind": "class", "cls": "commodities"})
    assert dup in symbols({"kind": "class", "cls": "etfs"})
    assert symbols({"kind": "watchlist", "id": "w1"}) == {"AAPL", "BTC-USD"}
    assert "AAPL" in symbols({"kind": "list", "id": "sp500"})
    assert symbols({"kind": "symbols", "symbols": ["aapl", "zzzz"]}) == {"AAPL"}
    assert symbols({"kind": "symbols", "symbols": []}) == set()

    session.add(
        ScreenerList(
            id="mine", name="M", kind="custom", as_of="2026-11", source="upload", updated_at=NOW
        )
    )
    session.flush()
    session.add(ScreenerListMember(list_id="mine", symbol="BTC-USD"))
    session.commit()
    assert symbols({"kind": "list", "id": "mine"}) == {"BTC-USD"}

    for universe, name in (
        ({"kind": "list", "id": "nolist"}, "list not found: nolist"),
        ({"kind": "watchlist", "id": "nowl"}, "watchlist not found: nowl"),
    ):
        body = {"universe": universe, "filter": None}
        with pytest.raises(UniverseNotFound) as exc:
            run_scan(session, ScanRequest.model_validate(body), settings=SETTINGS, now=NOW)
        assert exc.value.status == 404 and exc.value.message == name


def test_universe_shape_validation() -> None:
    bad: list[Any] = [
        {"kind": "class", "cls": "bonds"},
        {"kind": "class"},
        {"kind": "nope"},
        {"kind": "list", "id": "x'; DROP TABLE screener_symbols; --"},
        {"kind": "list", "id": ""},
        {"kind": "list", "id": "a" * 37},
        {"kind": "watchlist", "id": "a b"},
        {"kind": "symbols", "symbols": ["AAPL; DROP"]},
        {"kind": "symbols", "symbols": ["A" * 33]},
        {"kind": "symbols", "symbols": [f"S{i}" for i in range(1001)]},
        {"kind": "symbols", "symbols": "AAPL"},
        {"kind": "symbols", "symbols": ["AAPL"], "extra": 1},
        {},
        "stocks",
    ]
    for universe in bad:
        with pytest.raises(ValidationError):
            ScanRequest.model_validate({"universe": universe})
    ok = ScanRequest.model_validate(
        {"universe": {"kind": "symbols", "symbols": [f"S{i}" for i in range(1000)]}}
    )
    assert ok.universe.kind == "symbols" and len(ok.universe.symbols) == 1000
    assert ok.limit == 100 and ok.offset == 0 and ok.filter is None and ok.fields is None
    dedup = ScanRequest.model_validate(
        {"universe": {"kind": "symbols", "symbols": ["a", "A", " b "]}}
    )
    assert dedup.universe.symbols == ["A", "B"]  # type: ignore[union-attr]
    for extra in ({"sort": {"field": "last", "dir": "sideways"}}, {"sort": {"dir": "asc"}}):
        with pytest.raises(ValidationError):
            ScanRequest.model_validate({"universe": {"kind": "class", "cls": "stocks"}, **extra})


# ------------------------------------------------------------------ safety


class Statements:
    def __init__(self, engine: Engine) -> None:
        self.sql: list[str] = []
        event.listen(engine, "before_cursor_execute", self._on)

    def _on(self, conn: Any, cursor: Any, statement: str, *args: Any) -> None:
        self.sql.append(statement)


INJECTIONS = [
    "last; DROP TABLE screener_snapshots; --",
    "last' OR '1'='1",
    "1) OR (1=1",
    "\x00",
    "last --",
    "(SELECT 1)",
    "x" * 64,
]


def test_invalid_requests_execute_no_sql(session: Session, engine: Engine) -> None:
    seen = Statements(engine)
    for inj in INJECTIONS:
        for f in (
            group(rule(inj, ">", 1)),
            group(rule("last", inj, 1)),
            group(rule("last", ">", {"field": inj})),
            group(group(rule(inj, "=", "x"))),
        ):
            with pytest.raises(ScanError):
                run_scan(session, req(f), settings=SETTINGS, now=NOW, target=TARGET)
        with pytest.raises(ScanError):
            run_scan(
                session,
                req(sort={"field": inj, "dir": "asc"}),
                settings=SETTINGS,
                now=NOW,
                target=TARGET,
            )
        with pytest.raises(ScanError):
            run_scan(session, req(fields=["last", inj]), settings=SETTINGS, now=NOW, target=TARGET)
        for universe in (
            {"kind": "list", "id": inj},
            {"kind": "watchlist", "id": inj},
            {"kind": "class", "cls": inj},
            {"kind": "symbols", "symbols": [inj]},
        ):
            with pytest.raises(ValidationError):
                ScanRequest.model_validate({"universe": universe})
    with pytest.raises(ScanError):
        run_scan(
            session,
            req(group(rule("last", ">", 1), rule("last", "~", 1))),
            settings=SETTINGS,
            now=NOW,
            target=TARGET,
        )
    assert seen.sql == []


def test_values_are_bound_parameters(session: Session, engine: Engine) -> None:
    """Hostile values reach SQLite only as parameters: the tables survive and nothing matches."""
    hostile = "x'; DROP TABLE screener_snapshots; --"
    seen = Statements(engine)
    assert match(session, "sector", "=", hostile) == set()
    assert match(session, "sector", "in", [hostile, "' OR 1=1 --"]) == set()
    assert match(session, "name", "=", hostile) == set()
    assert all(hostile not in sql for sql in seen.sql) and seen.sql
    assert {"screener_snapshots", "screener_symbols"} <= set(inspect(engine).get_table_names())
    assert match(session, "last", ">", 60) == {"AAA"}


def test_compiled_sql_binds_values() -> None:
    parsed = ScanRequest.model_validate(
        {"universe": {"kind": "class", "cls": "stocks"}, "filter": group(rule("rsi14", ">", 5))}
    )
    clause = compile_filter(parsed.filter)
    assert clause is not None
    sql = str(clause.compile())
    assert sql.startswith("screener_snapshots.rsi14 > :") and "5" not in sql


# ---------------------------------------------------------------- snapshot


def test_snapshot_values(session: Session) -> None:
    as_of, rows = snapshot_values(
        session, ["AAA", "FFF", "TTT", "EEE", "NOPE"], settings=SETTINGS, now=NOW
    )
    assert as_of == "2026-11-05"
    assert set(rows) == {"AAA"}  # FFF has no data, TTT tombstoned, EEE too old, NOPE untracked
    assert rows["AAA"]["rsi14"] == 72.0 and rows["AAA"]["smaCross"] == "golden"
    assert rows["AAA"]["sector"] == "Technology" and rows["AAA"]["daysToEarnings"] == 3
    assert "name" not in rows["AAA"] and "cls" not in rows["AAA"]
    assert set(rows["AAA"]) == set(FIELDS) - {"name", "cls", "group", "exchange"}
    # No tracked data at all.
    assert snapshot_values(session, ["FFF"], settings=SETTINGS, now=NOW)[1] == {}


def test_current_cutoff_honours_extra_holidays() -> None:
    """The day after Thanksgiving closes at 13:00 ET; declared closed (`MARKET_EXTRA_HOLIDAYS`)
    it is not an early-close trading day, so the cutoff falls back to the regular close."""
    day = date(2026, 11, 27)
    early = current_cutoff(day, SETTINGS)
    closed = current_cutoff(
        day,
        Settings(_env_file=None, market_extra_holidays=[day]),  # type: ignore[call-arg]
    )
    assert early.astimezone(UTC).hour == 18  # 13:00 EST + settle within the hour
    assert closed - early == timedelta(hours=3)
