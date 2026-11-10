"""Screener HTTP API: universe, lists, fields, scan, status, runs, snapshot
(docs/design/server-screener.md §4). None of these endpoints may call the provider."""

from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, delete, event, update
from sqlalchemy.orm import Session
from test_screener_query import NOW, TARGET, add_fund, add_run, add_snap, add_symbol
from test_userdata import NullProvider

from tickerglass_api.app import create_app
from tickerglass_api.models import (
    Bar,
    ScreenerFundamental,
    ScreenerListMember,
    ScreenerRun,
    ScreenerSnapshot,
    ScreenerSymbol,
    Watchlist,
)
from tickerglass_api.routes import screener as routes
from tickerglass_api.services.screener import universe as uv
from tickerglass_api.services.screener.fields import FIELDS
from tickerglass_api.services.screener.job import ScreenerJob

SCAN = "/api/screener/scan"
UNIVERSE = {"kind": "symbols", "symbols": ["AAA", "BBB", "CCC"]}


class CountingProvider(NullProvider):
    """Records every upstream call (the screener API must make none)."""

    def __init__(self) -> None:
        self.calls: list[str] = []

    def history(self, *args: Any, **kw: Any) -> Any:
        self.calls.append("history")
        return super().history(*args, **kw)

    def symbol_info(self, symbol: str) -> dict[str, Any]:
        self.calls.append("symbol_info")
        return super().symbol_info(symbol)

    def search(self, query: str, limit: int) -> list[dict[str, Any]]:
        self.calls.append("search")
        return []

    def quotes(self, symbols: list[str]) -> list[dict[str, Any]]:
        self.calls.append("quotes")
        return []


class ScreenProvider(CountingProvider):
    """A provider with the optional `ScreenInfoProvider` capability (Yahoo, demo)."""

    def screen_fields(self, symbols: list[str]) -> list[dict[str, Any]]:
        self.calls.append("screen_fields")
        return []

    def info(self, symbol: str) -> dict[str, Any]:
        self.calls.append("info")
        return {}


def engine_of(client: TestClient) -> Engine:
    engine: Engine = client.app.state.engine  # type: ignore[attr-defined]
    return engine


def session_of(client: TestClient) -> Session:
    return Session(engine_of(client))


def make_client(tmp_path: Path, provider: CountingProvider) -> TestClient:
    return TestClient(create_app(provider=provider, database_url=f"sqlite:///{tmp_path}/s.db"))


@pytest.fixture(autouse=True)
def fresh_cache() -> None:
    routes._scan_cache.clear()


@pytest.fixture
def provider() -> ScreenProvider:
    return ScreenProvider()


@pytest.fixture
def client(
    tmp_path: Path, provider: ScreenProvider, monkeypatch: pytest.MonkeyPatch
) -> Iterator[TestClient]:
    # The real job derives the target session from the wall clock; pin it to the fixtures' day.
    monkeypatch.setattr(ScreenerJob, "target_date", lambda self, now=None: TARGET)
    with make_client(tmp_path, provider) as c:
        with session_of(c) as s:
            seed(s)
        provider.calls.clear()
        yield c


def seed(s: Session) -> None:
    for i, sym in enumerate(["AAA", "BBB", "CCC"], start=1):
        add_symbol(s, sym, 9000 + i)
    add_snap(s, "AAA", last=110.0, rsi14=72.0, prev_rsi14=68.0, cross_state=1, perf_1m=10.0)
    add_snap(s, "BBB", last=50.0, rsi14=28.0, prev_rsi14=33.0, cross_state=-1, perf_1m=-5.0)
    add_snap(s, "CCC")
    add_fund(s, "AAA", mcap=5e9, sector="Technology")
    s.commit()


@contextmanager
def fake_stack(client: TestClient, **attrs: Any) -> Iterator[SimpleNamespace]:
    """Swap the installed stack for one that has (or lacks) a `screener` job."""
    state = client.app.state  # type: ignore[attr-defined]
    real = state.market_stack
    state.market_stack = SimpleNamespace(**attrs)
    try:
        yield state.market_stack
    finally:
        state.market_stack = real


def scan(client: TestClient, **kw: Any) -> Any:
    body = {"universe": UNIVERSE, "filter": None, **kw}
    return client.post(SCAN, json=body)


def rule(field: str, op: str, value: Any) -> dict[str, Any]:
    return {"op": "and", "rules": [{"field": field, "op": op, "value": value}]}


# ------------------------------------------------------------------- fields


def test_fields_lists_every_field(client: TestClient) -> None:
    res = client.get("/api/screener/fields")
    assert res.status_code == 200
    assert res.headers["cache-control"] == "private, no-cache"
    body = res.json()
    assert body["version"] == 1 and len(body["fields"]) == len(FIELDS)
    by = {f["id"]: f for f in body["fields"]}
    assert set(by["rsi14"]) == {
        "id",
        "category",
        "type",
        "unit",
        "dimension",
        "ops",
        "crossable",
        "available",
        "enumValues",
    }
    assert by["rsi14"]["crossable"] is True and by["last"]["crossable"] is True
    assert by["smaCross"]["enumValues"] == ["golden", "death"]
    assert by["cls"]["enumValues"] == ["stocks", "etfs", "crypto", "commodities"]
    assert all(f["available"] for f in body["fields"])


def test_fundamental_fields_unavailable_without_screen_info(tmp_path: Path) -> None:
    with make_client(tmp_path, CountingProvider()) as c:
        by = {f["id"]: f for f in c.get("/api/screener/fields").json()["fields"]}
        off = {i for i, f in by.items() if not f["available"]}
        assert off == {
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
        res = c.post(SCAN, json={"universe": UNIVERSE, "filter": rule("mcap", ">", 1)})
        assert res.status_code == 422
        assert res.json()["detail"] == {
            "code": "field_unavailable",
            "message": "mcap is not available from this data source",
            "path": "filter.rules[0].field",
        }
        assert scan(c, filter=rule("rsi14", ">", 1)).status_code == 200


# --------------------------------------------------------------------- scan


def test_scan_returns_rows_and_headers(client: TestClient, provider: ScreenProvider) -> None:
    with session_of(client) as s:
        add_run(s)
        s.commit()
    res = scan(
        client,
        filter=rule("rsi14", ">", 20),
        sort={"field": "rsi14", "dir": "asc"},
        fields=["last", "smaCross", "mcap"],
    )
    assert res.status_code == 200
    assert res.headers["cache-control"] == "private, no-cache"
    assert res.headers["etag"].startswith('"')
    body = res.json()
    assert body["total"] == 2 and body["asOf"] == "2026-11-05" and body["provider"] == "yahoo"
    assert body["coverage"] == {"universe": 3, "withSnapshot": 3}
    assert body["offset"] == 0 and body["limit"] == 100
    assert [r["symbol"] for r in body["rows"]] == ["BBB", "AAA"]
    assert body["rows"][1] == {
        "symbol": "AAA",
        "name": "AAA Inc",
        "cls": "stocks",
        "group": "Tech",
        "exchange": "NASDAQ",
        "stale": False,
        "values": {"last": 110.0, "smaCross": "golden", "mcap": 5e9},
    }
    assert provider.calls == []


def test_scan_etag_and_304(client: TestClient) -> None:
    first = scan(client, filter=rule("rsi14", ">", 20))
    etag = first.headers["etag"]
    again = scan(client, filter=rule("rsi14", ">", 20))
    assert again.headers["etag"] == etag and again.content == first.content

    for header in (etag, f"W/{etag}", f'"nope", {etag}', "*"):
        res = client.post(
            SCAN,
            json={"universe": UNIVERSE, "filter": rule("rsi14", ">", 20)},
            headers={"If-None-Match": header},
        )
        assert res.status_code == 304, header
        assert res.content == b"" and res.headers["etag"] == etag
    stale = client.post(
        SCAN,
        json={"universe": UNIVERSE, "filter": rule("rsi14", ">", 20)},
        headers={"If-None-Match": '"other"'},
    )
    assert stale.status_code == 200

    # A different request has a different ETag, and its tag does not revalidate this one.
    other = scan(client, filter=rule("rsi14", ">", 21))
    assert other.headers["etag"] != etag
    # Equivalent requests (defaults spelled out, key order) share an ETag.
    spelled = client.post(
        SCAN,
        json={
            "limit": 100,
            "offset": 0,
            "sort": {"dir": "desc", "field": "avgDollarVol30"},
            "filter": rule("rsi14", ">", 20),
            "universe": UNIVERSE,
        },
    )
    assert spelled.headers["etag"] == etag


def test_scan_etag_changes_with_the_data(client: TestClient) -> None:
    etag = scan(client).headers["etag"]
    with session_of(client) as s:
        s.add(
            ScreenerRun(
                kind="snapshot",
                trigger="manual",
                provider="yahoo",
                target_date=TARGET,
                status="done",
                total=1,
                done=1,
                failed=0,
                tokens=1,
                started_at=NOW,
            )
        )
        s.commit()
    after_run = scan(client).headers["etag"]
    assert after_run != etag
    with session_of(client) as s:
        s.get(ScreenerSnapshot, "BBB").last = 51.0  # type: ignore[union-attr]
        s.get(ScreenerSnapshot, "BBB").computed_at = datetime(2026, 11, 6, 13, tzinfo=UTC)  # type: ignore[union-attr]
        s.commit()
    assert scan(client).headers["etag"] != after_run
    # A provider switch wipes the tables: cached scans must not outlive them.
    before_wipe = scan(client)
    with session_of(client) as s:
        s.execute(delete(ScreenerSnapshot))
        s.execute(delete(ScreenerFundamental))
        s.commit()
    after = scan(client)
    assert after.headers["etag"] != before_wipe.headers["etag"]
    assert after.json()["coverage"]["withSnapshot"] == 0


def test_scan_etag_changes_when_a_watchlist_or_list_member_is_deleted(client: TestClient) -> None:
    with session_of(client) as s:
        for wid in ("w1", "w2"):
            s.add(
                Watchlist(
                    id=wid,
                    name=wid,
                    items=[{"type": "symbol", "symbol": "AAA"}],
                    revision=1,
                    created_at=NOW,
                    updated_at=NOW,
                )
            )
        s.commit()
    put = client.put(
        "/api/screener/lists/mine",
        json={"name": "Mine", "asOf": "2026-11", "symbols": ["AAA", "BBB", "CCC"]},
    )
    assert put.status_code == 200
    before = scan(client).headers["etag"]
    with session_of(client) as s:  # a delete leaves every updated-at stamp as it was
        s.delete(s.get(Watchlist, "w2"))
        s.commit()
    after_watchlist = scan(client).headers["etag"]
    assert after_watchlist != before
    with session_of(client) as s:
        s.execute(delete(ScreenerListMember).where(ScreenerListMember.symbol == "CCC"))
        s.commit()
    assert scan(client).headers["etag"] != after_watchlist


def test_scan_lru_serves_repeats_without_recomputing(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls = 0
    real = routes.run_scan

    def counting(*args: Any, **kw: Any) -> Any:
        nonlocal calls
        calls += 1
        return real(*args, **kw)

    monkeypatch.setattr(routes, "run_scan", counting)
    for _ in range(3):
        assert scan(client, filter=rule("last", ">", 1)).status_code == 200
    assert calls == 1
    for i in range(routes.SCAN_CACHE_SIZE):
        assert scan(client, filter=rule("last", ">", 2 + i)).status_code == 200
    assert calls == 1 + routes.SCAN_CACHE_SIZE
    assert scan(client, filter=rule("last", ">", 1)).status_code == 200  # evicted: recomputed
    assert calls == 2 + routes.SCAN_CACHE_SIZE
    assert scan(client, filter=rule("last", ">", 1)).status_code == 200
    assert calls == 2 + routes.SCAN_CACHE_SIZE


def test_scan_errors(client: TestClient) -> None:
    cases = [
        (rule("nope", ">", 1), "unknown_field", "filter.rules[0].field"),
        (rule("last", "~", 1), "bad_op", "filter.rules[0].op"),
        (rule("last", ">", "x"), "bad_value", "filter.rules[0].value"),
        (rule("last", ">", {"field": "rsi14"}), "bad_value", "filter.rules[0].value.field"),
    ]
    for filter, code, path in cases:
        res = scan(client, filter=filter)
        assert res.status_code == 422, code
        detail = res.json()["detail"]
        assert set(detail) == {"code", "message", "path"}
        assert (detail["code"], detail["path"]) == (code, path)
    deep = {"op": "and", "rules": [{"op": "or", "rules": rule("last", ">", 1)["rules"]}]}
    deeper = {"op": "and", "rules": [deep]}
    assert scan(client, filter=deep).status_code == 200
    res = scan(client, filter=deeper)
    assert res.status_code == 422 and res.json()["detail"]["code"] == "too_complex"
    many = {"op": "and", "rules": [rule("last", ">", i)["rules"][0] for i in range(51)]}
    assert scan(client, filter=many).json()["detail"]["code"] == "too_complex"
    # Shape errors are plain request validation errors.
    for body in (
        {"universe": {"kind": "class", "cls": "bonds"}},
        {"universe": UNIVERSE, "limit": 501},
        {"universe": UNIVERSE, "limit": 0},
        {"universe": UNIVERSE, "offset": -1},
        {"universe": UNIVERSE, "sort": {"field": "last", "dir": "up"}},
        {},
    ):
        assert client.post(SCAN, json=body).status_code == 422, body
    # A missing list or watchlist is a 404.
    for universe, code in (
        ({"kind": "list", "id": "nolist"}, "unknown_list"),
        ({"kind": "watchlist", "id": "nowl"}, "unknown_watchlist"),
    ):
        res = scan(client, universe=universe)
        assert res.status_code == 404 and res.json()["detail"]["code"] == code


def test_invalid_scans_run_no_sql(client: TestClient) -> None:
    statements: list[str] = []

    def record(conn: Any, cursor: Any, statement: str, *args: Any) -> None:
        statements.append(statement)

    engine = engine_of(client)
    event.listen(engine, "before_cursor_execute", record)
    try:
        inj = "last; DROP TABLE screener_snapshots; --"
        for body in (
            {"universe": UNIVERSE, "filter": rule(inj, ">", 1)},
            {"universe": UNIVERSE, "filter": rule("last", inj, 1)},
            {"universe": UNIVERSE, "sort": {"field": inj, "dir": "asc"}},
            {"universe": UNIVERSE, "sort": {"field": "last", "dir": inj}},
            {"universe": UNIVERSE, "fields": [inj]},
            {"universe": {"kind": "list", "id": inj}},
            {"universe": {"kind": "watchlist", "id": inj}},
            {"universe": {"kind": "class", "cls": inj}},
            {"universe": {"kind": "symbols", "symbols": [inj]}},
        ):
            assert client.post(SCAN, json=body).status_code == 422, body
        assert [sql for sql in statements if "screener" in sql] == []
    finally:
        event.remove(engine, "before_cursor_execute", record)


def test_scan_universes_by_http(client: TestClient) -> None:
    with session_of(client) as s:
        s.add(
            Watchlist(
                id="w1",
                name="W",
                items=[{"type": "symbol", "symbol": "BBB"}],
                revision=1,
                created_at=NOW,
                updated_at=NOW,
            )
        )
        s.commit()
    got = scan(client, universe={"kind": "watchlist", "id": "w1"}).json()
    assert [r["symbol"] for r in got["rows"]] == ["BBB"]
    assert (
        client.put(
            "/api/screener/lists/mine",
            json={"name": "Mine", "asOf": "2026-11", "symbols": ["aaa", "CCC"]},
        ).status_code
        == 200
    )
    got = scan(
        client, universe={"kind": "list", "id": "mine"}, sort={"field": "last", "dir": "asc"}
    ).json()
    assert [r["symbol"] for r in got["rows"]] == ["AAA", "CCC"]
    stocks = scan(client, universe={"kind": "class", "cls": "stocks"}, limit=500).json()
    assert stocks["coverage"]["universe"] == len(uv.class_symbols("stocks"))


# ----------------------------------------------------------------- universe


def test_universe_endpoint(client: TestClient) -> None:
    res = client.get("/api/screener/universe", params={"cls": "stocks"})
    assert res.status_code == 200
    etag = f'"{uv.bundle_hash()}"'
    assert res.headers["etag"] == etag and res.headers["cache-control"] == "private, no-cache"
    body = res.json()
    assert body["cls"] == "stocks" and body["capKind"] == "mcap" and body["groupLabel"] == "sector"
    assert len(body["symbols"]) == len(uv.class_symbols("stocks"))
    assert {"symbol", "name", "rank", "group"} <= set(body["symbols"][0])
    for header in (etag, f"W/{etag}"):
        cached = client.get(
            "/api/screener/universe", params={"cls": "etfs"}, headers={"If-None-Match": header}
        )
        assert cached.status_code == 304 and cached.content == b""
    changed = client.get(
        "/api/screener/universe", params={"cls": "etfs"}, headers={"If-None-Match": '"old"'}
    )
    assert changed.status_code == 200 and changed.json()["cls"] == "etfs"
    for params in ({"cls": "bonds"}, {}, {"cls": "x'; DROP TABLE screener_symbols; --"}):
        assert client.get("/api/screener/universe", params=params).status_code == 422


# -------------------------------------------------------------------- lists


def test_lists_crud(client: TestClient) -> None:
    listed = client.get("/api/screener/lists").json()
    by = {item["id"]: item for item in listed}
    assert {"sp500", "ndx100"} <= set(by)
    assert set(by["sp500"]) == {"id", "name", "kind", "asOf", "source", "count"}
    assert by["sp500"]["kind"] == "index" and by["sp500"]["source"] == "bundled"
    bundled_count = by["sp500"]["count"]

    put = client.put(
        "/api/screener/lists/mine",
        json={"name": "  Mine ", "asOf": "2026-11", "symbols": ["aapl", "msft", "AAPL"]},
    )
    assert put.status_code == 200
    assert put.json() == {
        "id": "mine",
        "name": "Mine",
        "kind": "custom",
        "asOf": "2026-11",
        "source": "upload",
        "count": 2,
    }
    assert {i["id"] for i in client.get("/api/screener/lists").json()} >= {"mine", "sp500"}

    override = client.put(
        "/api/screener/lists/sp500",
        json={"name": "My S&P", "asOf": "2026-11-01", "symbols": ["AAPL"]},
    )
    assert override.status_code == 200
    assert override.json()["kind"] == "index" and override.json()["source"] == "upload"
    assert override.json()["count"] == 1

    reverted = client.delete("/api/screener/lists/sp500")
    assert (reverted.status_code, reverted.json()) == (200, {"status": "reverted"})
    assert client.delete("/api/screener/lists/sp500").json() == {"status": "unchanged"}
    back = {i["id"]: i for i in client.get("/api/screener/lists").json()}["sp500"]
    assert back["source"] == "bundled" and back["count"] == bundled_count

    removed = client.delete("/api/screener/lists/mine")
    assert (removed.status_code, removed.json()) == (200, {"status": "removed"})
    assert client.delete("/api/screener/lists/mine").status_code == 404
    assert client.delete("/api/screener/lists/never").status_code == 404


def test_list_put_errors(client: TestClient) -> None:
    def put(list_id: str, **kw: Any) -> Any:
        body = {"name": "L", "asOf": "2026-11", "symbols": ["AAPL"], **kw}
        return client.put(f"/api/screener/lists/{list_id}", json=body)

    cases = [
        (put("ok", symbols=["AAPL; DROP"]), "bad_symbol"),
        (put("ok", name="  "), "bad_name"),
        (put("ok", asOf="11/2026"), "bad_as_of"),
        (put("bad%20id"), "bad_id"),
        (put("ok", symbols=[f"S{i}" for i in range(1501)]), "too_many_symbols"),
    ]
    for res, code in cases:
        assert res.status_code == 422, code
        assert res.json()["detail"]["code"] == code
    assert client.put("/api/screener/lists/ok", json={"name": "x"}).status_code == 422
    assert "ok" not in {i["id"] for i in client.get("/api/screener/lists").json()}


# ------------------------------------------------------------------- status


class FakeJob:
    def __init__(self, **runtime: Any) -> None:
        self._runtime = {
            "enabled": True,
            "supported": True,
            "reason": None,
            "running": None,
            "nextRunAt": "2026-11-06T22:15:00+00:00",
            "ratePerMin": 24.0,
            **runtime,
        }
        self.triggered: list[str] = []
        self.raises: Exception | None = None

    def runtime(self) -> dict[str, Any]:
        return self._runtime

    def target_date(self, now: datetime | None = None) -> date:
        return TARGET

    def trigger(self, kind: str) -> int:
        if self.raises is not None:
            raise self.raises
        self.triggered.append(kind)
        return 41


def seed_status(client: TestClient) -> None:
    with session_of(client) as s:
        s.execute(delete(ScreenerSnapshot))
        s.execute(delete(ScreenerFundamental))
        s.execute(delete(ScreenerSymbol))
        for i, sym in enumerate(["S1", "S2", "S3", "S4", "S5", "S6"], start=1):
            add_symbol(s, sym, i)
        s.flush()
        s.get(ScreenerSymbol, "S5").tombstoned_at = NOW  # type: ignore[union-attr]
        s.get(ScreenerSymbol, "S4").fail_count = 2  # type: ignore[union-attr]
        add_snap(s, "S1", last=1.0)
        add_snap(s, "S2", last=1.0)
        add_snap(s, "S3", date(2026, 11, 3), last=1.0)
        add_snap(s, "S5", last=1.0)  # tombstoned: not counted
        add_fund(s, "S1", quote_at=datetime(2026, 11, 5, 23, tzinfo=UTC))
        for kind, tokens, day in (("snapshot", 33, 4), ("snapshot", 42, 5), ("fundamentals", 9, 5)):
            s.add(
                ScreenerRun(
                    kind=kind,
                    trigger="schedule",
                    provider="yahoo",
                    target_date=date(2026, 11, day),
                    status="done",
                    total=5,
                    done=5,
                    failed=0,
                    tokens=tokens,
                    started_at=datetime(2026, 11, day, 22, tzinfo=UTC),
                    finished_at=NOW if (kind, day) == ("snapshot", 5) else None,
                )
            )
        s.add(
            ScreenerRun(
                kind="snapshot",
                trigger="manual",
                provider="yahoo",
                target_date=date(2026, 11, 5),
                status="running",
                total=5,
                done=1,
                failed=0,
                tokens=1,
                started_at=datetime(2026, 11, 6, 9, tzinfo=UTC),
            )
        )
        for ts in (1, 2, 3):
            s.add(
                Bar(
                    symbol="S1",
                    interval="1d",
                    prepost=False,
                    ts=ts,
                    open=1,
                    high=1,
                    low=1,
                    close=1,
                    adj_close=1,
                    volume=1,
                )  # fmt: skip
            )
        s.commit()


def test_status_with_job(client: TestClient, provider: ScreenProvider) -> None:
    seed_status(client)
    job = FakeJob(
        running={
            "runId": 7,
            "kind": "snapshot",
            "done": 10,
            "total": 100,
            "startedAt": datetime(2026, 11, 6, 9, tzinfo=UTC),
            "etaS": 120.5,
        }
    )
    with fake_stack(client, screener=job):
        res = client.get("/api/screener/status")
    assert res.status_code == 200
    assert res.headers["cache-control"] == "private, no-cache"
    body = res.json()
    assert body == {
        "enabled": True,
        "supported": True,
        "reason": None,
        "provider": "custom",
        "asOf": "2026-11-05",
        "computedAt": NOW.isoformat(),
        "fundamentalsAsOf": "2026-11-05",
        "coverage": {"tracked": 5, "fresh": 2, "stale": 1, "failed": 1, "tombstoned": 1},
        "running": {
            "runId": 7,
            "kind": "snapshot",
            "done": 10,
            "total": 100,
            "startedAt": "2026-11-06T09:00:00+00:00",
            "etaS": 120.5,
        },
        "nextRunAt": "2026-11-06T22:15:00+00:00",
        "budget": {"ratePerMin": 24.0, "tokensLastRun": 42},
        "barsRows": 3,
    }
    assert provider.calls == []


def test_status_bars_rows_is_cached(client: TestClient) -> None:
    seed_status(client)

    def rows() -> int:
        return int(client.get("/api/screener/status").json()["barsRows"])

    assert rows() == 3
    with session_of(client) as s:
        s.execute(delete(Bar))
        s.commit()
    assert rows() == 3  # served from the 10-minute cache, no count(*) over bars
    routes_state = client.app.state  # type: ignore[attr-defined]
    stamp, version, value = routes_state.screener_bars_rows
    routes_state.screener_bars_rows = (stamp - routes.BARS_ROWS_TTL_S - 1, version, value)
    assert rows() == 0  # the cache expired
    with session_of(client) as s:
        s.add(
            Bar(
                symbol="S1",
                interval="1d",
                prepost=False,
                ts=9,
                open=1,
                high=1,
                low=1,
                close=1,
                adj_close=1,
                volume=1,
            )  # fmt: skip
        )
        s.execute(update(ScreenerSnapshot).values(computed_at=NOW + timedelta(hours=1)))
        s.commit()
    assert rows() == 1  # a new snapshot batch ends the cache early


def test_status_reasons(client: TestClient) -> None:
    with fake_stack(client):  # a stack without a screener job
        body = client.get("/api/screener/status").json()
    assert body["enabled"] is False and body["supported"] is False
    assert body["reason"] == "disabled" and body["running"] is None and body["nextRunAt"] is None
    assert body["budget"] == {"ratePerMin": 24.0, "tokensLastRun": None}
    assert body["coverage"]["fresh"] == 3 and body["coverage"]["stale"] == 0
    assert set(body) == {
        "enabled",
        "supported",
        "reason",
        "provider",
        "asOf",
        "computedAt",
        "fundamentalsAsOf",
        "coverage",
        "running",
        "nextRunAt",
        "budget",
        "barsRows",
    }

    with session_of(client) as s:
        s.execute(delete(ScreenerSnapshot))
        s.commit()
    with fake_stack(client, screener=FakeJob()):
        body = client.get("/api/screener/status").json()
    assert body["reason"] == "first_run" and body["asOf"] is None and body["enabled"] is True
    with fake_stack(client, screener=FakeJob(supported=False, reason="provider_unsupported")):
        body = client.get("/api/screener/status").json()
    assert body["supported"] is False and body["reason"] == "provider_unsupported"


def test_status_stays_first_run_until_a_snapshot_run_finishes(client: TestClient) -> None:
    """Snapshot rows appear while the first run is still going; `asOf` must not."""
    running = {"runId": 1, "kind": "snapshot", "done": 3, "total": 800}
    with session_of(client) as s:  # the fixture holds snapshots of AAA, BBB, CCC
        add_run(s, "running", finished_at=None)
        add_run(s, "failed")
        add_run(s, "done", kind="fundamentals")
        s.commit()
    with fake_stack(client, screener=FakeJob(running=running)):
        body = client.get("/api/screener/status").json()
    assert body["reason"] == "first_run" and body["running"]["runId"] == 1
    assert body["asOf"] is None and body["computedAt"] is None
    assert body["coverage"]["fresh"] == 3  # the counts are live
    with session_of(client) as s:
        add_run(s, "partial", TARGET, finished_at=datetime(2026, 11, 6, 3, tzinfo=UTC))
        s.commit()
    with fake_stack(client, screener=FakeJob()):
        body = client.get("/api/screener/status").json()
    assert body["reason"] is None and body["asOf"] == "2026-11-05"
    assert body["computedAt"] == "2026-11-06T03:00:00+00:00"


# --------------------------------------------------------------------- runs


def test_runs(client: TestClient) -> None:
    job = FakeJob()
    with fake_stack(client, screener=job):
        res = client.post("/api/screener/runs", json={"kind": "snapshot"})
        assert (res.status_code, res.json()) == (202, {"runId": 41})
        res = client.post("/api/screener/runs", json={"kind": "fundamentals"})
        assert res.status_code == 202 and job.triggered == ["snapshot", "fundamentals"]
        job.raises = routes.RunInProgress()
        res = client.post("/api/screener/runs", json={"kind": "snapshot"})
        assert res.status_code == 409 and res.json()["detail"] == {
            "code": "run_in_progress",
            "message": "a run is already in progress",
        }
        job.raises = routes.RunInProgress(
            "snapshots already done for 2026-11-05; retry after 10 min"
        )
        res = client.post("/api/screener/runs", json={"kind": "snapshot"})
        assert res.status_code == 409
        assert res.json()["detail"] == {
            "code": "run_in_progress",
            "message": "snapshots already done for 2026-11-05; retry after 10 min",
        }
        job.raises = None
        for body in ({"kind": "weekly"}, {"kind": "snapshot", "x": 1}, {"kind": 1}):
            assert client.post("/api/screener/runs", json=body).status_code == 422
        assert job.triggered == ["snapshot", "fundamentals"]

    with fake_stack(client):
        res = client.post("/api/screener/runs", json={"kind": "snapshot"})
        assert res.status_code == 503 and res.json()["detail"]["code"] == "disabled"
    off = FakeJob(enabled=False, reason="disabled")
    with fake_stack(client, screener=off):
        assert client.post("/api/screener/runs", json={"kind": "snapshot"}).status_code == 503
    assert off.triggered == []


# ----------------------------------------------------------------- snapshot


def test_snapshot_endpoint(client: TestClient, provider: ScreenProvider) -> None:
    res = client.get("/api/screener/snapshot", params={"symbols": "aaa, BBB,nope,AAA"})
    assert res.status_code == 200
    assert res.headers["cache-control"] == "private, no-cache"
    body = res.json()
    assert set(body) == {"asOf", "rows"} and body["asOf"] == "2026-11-05"
    assert set(body["rows"]) == {"AAA", "BBB"}  # NOPE is untracked
    assert body["rows"]["AAA"]["rsi14"] == 72.0 and body["rows"]["AAA"]["smaCross"] == "golden"
    assert body["rows"]["AAA"]["mcap"] == 5e9 and body["rows"]["BBB"]["mcap"] is None
    assert body["rows"]["AAA"]["perf1m"] == 10.0
    assert "name" not in body["rows"]["AAA"] and "perfYtd" in body["rows"]["AAA"]
    assert provider.calls == []

    syms = ",".join(f"S{i}" for i in range(routes.MAX_SNAPSHOT_SYMBOLS))
    assert client.get("/api/screener/snapshot", params={"symbols": syms}).status_code == 200
    syms += ",EXTRA"
    assert client.get("/api/screener/snapshot", params={"symbols": syms}).status_code == 422
    # The web client sends 200 symbols of up to 32 characters per request.
    longest = ",".join(f"{'L' * 29}{i:03d}" for i in range(routes.MAX_SNAPSHOT_SYMBOLS))
    assert len(longest) > 4000
    assert client.get("/api/screener/snapshot", params={"symbols": longest}).status_code == 200
    for bad in ("", " , ", "AAA;DROP", "A B"):
        assert client.get("/api/screener/snapshot", params={"symbols": bad}).status_code == 422
    assert client.get("/api/screener/snapshot").status_code == 422


def test_screener_endpoints_never_call_the_provider(
    client: TestClient, provider: ScreenProvider
) -> None:
    client.get("/api/screener/universe", params={"cls": "crypto"})
    client.get("/api/screener/lists")
    client.get("/api/screener/fields")
    client.get("/api/screener/status")
    client.get("/api/screener/snapshot", params={"symbols": "AAA,BBB"})
    scan(client, filter=rule("mcap", ">", 1), fields=["last", "mcap", "sector"])
    scan(client, universe={"kind": "class", "cls": "stocks"})
    client.put("/api/screener/lists/x", json={"name": "x", "asOf": "2026-11", "symbols": ["AAA"]})
    client.delete("/api/screener/lists/x")
    assert provider.calls == []


def test_import_checks_screen_webhook_urls_like_creating_a_screen(client: TestClient) -> None:
    spec = {
        "schemaVersion": 1,
        "universe": {"kind": "class", "cls": "stocks"},
        "sort": {"field": "last", "dir": "desc"},
    }

    def bundle(url: str) -> dict[str, Any]:
        alert = {
            "enabled": True,
            "notify": {"webhook": True, "telegram": False, "email": False, "webhookUrl": url},
        }
        return {
            "version": 1,
            "app": "tickerglass",
            "screens": [{"id": "s1", "name": "S", "spec": spec, "alert": alert}],
        }

    private = client.post("/api/import", json=bundle("http://127.0.0.1/hook"))
    assert private.status_code == 422 and "webhookUrl" in private.text and "s1" in private.text
    dry = client.post("/api/import?dryRun=true", json=bundle("http://127.0.0.1/hook"))
    assert dry.status_code == 422
    assert client.get("/api/screener/screens").json() == []  # nothing was imported
    ok = client.post("/api/import", json=bundle("https://example.com/hook"))
    assert ok.status_code == 200, ok.text
    assert ok.json()["screens"]["created"] == 1
