"""Screener universe: JSON bundle, seeding, tracked set, lists, migration
(docs/design/server-screener.md)."""

import json
import shutil
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from fastapi.testclient import TestClient
from sqlalchemy import Engine, create_engine, func, inspect, select
from sqlalchemy.orm import Session
from test_userdata import alembic_config

from tickerglass_api.app import create_app
from tickerglass_api.db import Base, make_engine, run_migrations
from tickerglass_api.models import (
    AppMeta,
    ScreenerFundamental,
    ScreenerList,
    ScreenerListMember,
    ScreenerSnapshot,
    ScreenerSymbol,
    Watchlist,
)
from tickerglass_api.providers.demo import DemoProvider
from tickerglass_api.services.cache_source import ensure_cache_source
from tickerglass_api.services.screener import universe as uv
from tickerglass_api.settings import Settings

NOW = datetime(2026, 11, 6, 12, 0, tzinfo=UTC)
COUNTS = {"stocks": 496, "etfs": 162, "crypto": 57, "commodities": 53}
#: ETFs that are in both `etfs` and `commodities`.
DUPLICATES = 19
UNIQUE = sum(COUNTS.values()) - DUPLICATES


def settings(**kw: Any) -> Settings:
    return Settings(_env_file=None, **kw)  # type: ignore[call-arg]


@pytest.fixture
def engine(tmp_path: Path) -> Engine:
    url = f"sqlite:///{tmp_path}/u.db"
    run_migrations(url)
    return make_engine(url)


@pytest.fixture
def session(engine: Engine):  # type: ignore[no-untyped-def]
    with Session(engine) as s:
        yield s


@pytest.fixture
def data_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A private copy of the bundle that tests may edit."""
    dst = tmp_path / "screener_data"
    shutil.copytree(uv._DATA_DIR, dst)
    monkeypatch.setattr(uv, "_DATA_DIR", dst)
    return dst


def write(path: Path, doc: Any) -> None:
    """Edit a bundle file; the loaded bundle is cached per directory."""
    path.write_text(json.dumps(doc))
    uv._load.cache_clear()


def count(session: Session, model: Any) -> int:
    return session.scalar(select(func.count()).select_from(model)) or 0


def watchlist(session: Session, wid: str, symbols: list[str]) -> None:
    session.add(
        Watchlist(
            id=wid,
            name=wid,
            items=[{"type": "symbol", "symbol": s} for s in symbols],
            revision=1,
            created_at=NOW,
            updated_at=NOW,
        )
    )
    session.flush()


# ------------------------------------------------------------------- bundle


def test_bundle_counts_and_shape() -> None:
    b = uv.bundle()
    assert {c: len(r) for c, r in b.classes.items()} == COUNTS
    for cls, rows in b.classes.items():
        symbols = [r.symbol for r in rows]
        assert len(set(symbols)) == len(symbols), cls
        assert all(uv.SYMBOL_RE.match(s) for s in symbols), cls
        assert [r.rank for r in rows] == list(range(1, len(rows) + 1))
    assert set(b.lists) == {"sp500", "ndx100"}
    stocks = {r.symbol for r in b.classes["stocks"]}
    for lst in b.lists.values():
        assert set(lst.symbols) <= stocks and len(set(lst.symbols)) == len(lst.symbols)
        assert lst.as_of == "2026-01" and len(lst.symbols) > 50


def test_bundle_content_checks() -> None:
    """Data-quality guards ported from the retired TS dataset tests."""
    b = uv.bundle()
    stocks = {r.symbol: r for r in b.classes["stocks"]}
    # DFS (Capital One, May 2025), IPG (Omnicom, Nov 2025), SKX (3G Capital, Sep 2025),
    # FI (Fiserv trades as FISV on Nasdaq since Nov 2025).
    for gone in ("DFS", "IPG", "SKX", "FI"):
        assert gone not in stocks, gone
    for sym, exchange in (
        ("ES", "NYSE"),
        ("NSC", "NYSE"),
        ("PGR", "NYSE"),
        ("AAPL", "NASDAQ"),
        ("ORLY", "NASDAQ"),
    ):
        assert stocks[sym].exchange == exchange, sym
    assert all((r.cap or 0) > 0 for r in stocks.values())
    futures = [r for r in b.classes["commodities"] if r.symbol.endswith("=F")]
    assert futures and all(not r.cap for r in futures)
    for rows in b.classes.values():
        assert all(len(r.name) > 1 and len(r.group) > 1 for r in rows)


def test_universe_payload_mirrors_ts_universe(session: Session) -> None:
    stocks = uv.universe_payload(session, "stocks")
    assert stocks["cls"] == "stocks"
    assert stocks["groupLabel"] == "sector" and stocks["capKind"] == "mcap"
    assert stocks["symbols"][0] == {
        "symbol": "NVDA",
        "name": "NVIDIA",
        "group": "Technology",
        "exchange": "NASDAQ",
        "cap": 4400,
        "rank": 1,
    }
    assert [s["rank"] for s in stocks["symbols"]] == list(range(1, 497))
    assert stocks["groups"][0] == "Technology"
    assert len(set(stocks["groups"])) == len(stocks["groups"])
    assert set(stocks["exchanges"]) >= {"NASDAQ", "NYSE"}

    crypto = uv.universe_payload(session, "crypto")
    assert crypto["groupLabel"] == "group" and crypto["capKind"] == "mcap"
    assert "exchange" not in crypto["symbols"][0] and crypto["exchanges"] == []

    commodities = uv.universe_payload(session, "commodities")
    assert commodities["capKind"] == "aum" and len(commodities["symbols"]) == 53
    gold = commodities["symbols"][0]
    assert gold["symbol"] == "GC=F" and "cap" not in gold and gold["exchange"] == "COMEX"
    assert uv.universe_payload(session, "etfs")["groupLabel"] == "category"
    with pytest.raises(KeyError):
        uv.universe_payload(session, "bonds")


def test_bundle_hash_is_stable_and_tracks_content(data_dir: Path) -> None:
    h = uv.bundle_hash()
    assert h == uv.bundle_hash() and len(h) == 40
    doc = json.loads((data_dir / "crypto.json").read_text())
    doc["rows"][0][1] = "Bitcoin!"
    write(data_dir / "crypto.json", doc)
    assert uv.bundle_hash() != h


# ------------------------------------------------------------------ seeding


def test_seed_is_idempotent(session: Session) -> None:
    assert uv.seed_bundle(session, settings(), now=NOW) is True
    session.commit()
    assert count(session, ScreenerSymbol) == UNIQUE
    assert count(session, ScreenerList) == 2
    assert session.get(AppMeta, uv.BUNDLE_KEY).value == uv.bundle_hash()  # type: ignore[union-attr]
    # Overlapping ETFs are stored once, as etfs.
    assert session.get(ScreenerSymbol, "GLD").cls == "etfs"  # type: ignore[union-attr]
    assert session.get(ScreenerSymbol, "GC=F").cls == "commodities"  # type: ignore[union-attr]
    members = count(session, ScreenerListMember)

    # Local edits survive a second seed with the same hash.
    session.get(ScreenerSymbol, "AAPL").tombstoned_at = NOW  # type: ignore[union-attr]
    session.commit()
    assert uv.seed_bundle(session, settings(), now=NOW) is False
    assert session.get(ScreenerSymbol, "AAPL").tombstoned_at is not None  # type: ignore[union-attr]
    assert count(session, ScreenerSymbol) == UNIQUE
    assert count(session, ScreenerListMember) == members


def test_changed_bundle_reseeds_and_clears_tombstones_of_changed_symbols(
    session: Session, data_dir: Path
) -> None:
    uv.seed_bundle(session, settings(), now=NOW)
    for sym in ("AAPL", "MSFT", "BTC-USD", "GC=F"):
        row = session.get(ScreenerSymbol, sym)
        assert row is not None
        row.tombstoned_at, row.fail_count = NOW, 3
    session.commit()
    old_hash = uv.bundle_hash()

    stocks = json.loads((data_dir / "stocks.json").read_text())
    for r in stocks["rows"]:
        if r[0] == "AAPL":
            r[1] = "Apple Inc."  # name changed
    dropped = stocks["rows"].pop(-1)[0]  # last stock leaves the bundle
    stocks["rows"].insert(0, ["NEWCO", "NewCo", "Technology", "NASDAQ", 5000])  # shifts ranks
    write(data_dir / "stocks.json", stocks)
    lists = json.loads((data_dir / "lists/ndx100.json").read_text())
    lists["symbols"].append("NEWCO")
    write(data_dir / "lists/ndx100.json", lists)

    assert uv.bundle_hash() != old_hash
    assert uv.seed_bundle(session, settings(), now=NOW) is True
    session.commit()

    aapl, msft = session.get(ScreenerSymbol, "AAPL"), session.get(ScreenerSymbol, "MSFT")
    assert aapl and aapl.name == "Apple Inc." and aapl.tombstoned_at is None
    assert aapl.fail_count == 0 and aapl.rank == 3  # ranks shifted by the new first row
    # Only rank moved: the tombstone stays.
    assert msft and msft.tombstoned_at is not None and msft.rank == 4
    for sym in ("BTC-USD", "GC=F"):
        assert session.get(ScreenerSymbol, sym).tombstoned_at is not None  # type: ignore[union-attr]
    new = session.get(ScreenerSymbol, "NEWCO")
    assert new and new.rank == 1 and new.source == "bundled" and new.cap_static == 5000
    gone = session.get(ScreenerSymbol, dropped)
    assert gone and gone.source == "custom" and gone.rank >= uv.CUSTOM_RANK_BASE
    assert session.get(AppMeta, uv.BUNDLE_KEY).value == uv.bundle_hash()  # type: ignore[union-attr]
    assert "NEWCO" in (uv.list_symbols(session, "ndx100") or [])


def test_reseed_keeps_uploaded_lists(session: Session, data_dir: Path) -> None:
    uv.seed_bundle(session, settings(), now=NOW)
    uv.put_list(session, "sp500", "My S&P", "2026-06", ["AAPL", "msft"], now=NOW)
    session.commit()
    doc = json.loads((data_dir / "lists/sp500.json").read_text())
    doc["symbols"] = doc["symbols"][:10]
    write(data_dir / "lists/sp500.json", doc)
    assert uv.seed_bundle(session, settings(), now=NOW) is True
    assert uv.list_symbols(session, "sp500") == ["AAPL", "MSFT"]
    lst = session.get(ScreenerList, "sp500")
    assert lst and lst.source == "upload" and lst.name == "My S&P"
    # Reverting follows the new bundle content.
    assert uv.delete_list(session, "sp500", now=NOW) == "reverted"
    assert len(uv.list_symbols(session, "sp500") or []) == 10


# ------------------------------------------------------------- tracked set


def test_tracked_default_is_bundle_in_rank_order(session: Session) -> None:
    uv.seed_bundle(session, settings(), now=NOW)
    tracked = uv.tracked_symbols(session, settings())
    assert len(tracked) == UNIQUE and len(set(tracked)) == UNIQUE
    # Rank 1 of every class first (class order breaks the tie), then rank 2, ...
    assert tracked[:5] == ["NVDA", "SPY", "BTC-USD", "GC=F", "AAPL"]
    assert "GLD" in tracked


def test_tracked_cap_cuts_in_rank_order(session: Session) -> None:
    uv.seed_bundle(session, settings(), now=NOW)
    tracked = uv.tracked_symbols(session, settings(screener_max_symbols=10))
    assert tracked == [
        "NVDA", "SPY", "BTC-USD", "GC=F", "AAPL", "VOO", "ETH-USD", "SI=F", "MSFT", "IVV",
    ]  # fmt: skip
    assert uv.tracked_symbols(session, settings(screener_max_symbols=0)) == []


def test_tracked_skips_tombstoned(session: Session) -> None:
    uv.seed_bundle(session, settings(), now=NOW)
    session.get(ScreenerSymbol, "AAPL").tombstoned_at = NOW  # type: ignore[union-attr]
    session.flush()
    tracked = uv.tracked_symbols(session, settings(screener_max_symbols=6))
    assert "AAPL" not in tracked and len(tracked) == 6 and tracked[4] == "VOO"


def test_tracked_adds_watchlist_symbols_as_custom_rows(session: Session) -> None:
    uv.seed_bundle(session, settings(), now=NOW)
    watchlist(session, "w1", ["AAPL", "zzzz", "BRK-B", "bad symbol!", "NEWIPO"])
    session.add(  # sections are ignored
        Watchlist(
            id="w2",
            name="w2",
            items=[{"type": "section", "id": "s", "title": "T", "collapsed": False}],
            revision=1,
            created_at=NOW,
            updated_at=NOW,
        )
    )
    session.flush()
    tracked = uv.tracked_symbols(session, settings())
    assert len(tracked) == UNIQUE + 2
    assert tracked[-2:] == ["ZZZZ", "NEWIPO"] and "BAD SYMBOL!" not in tracked
    row = session.get(ScreenerSymbol, "ZZZZ")
    assert row and row.source == "custom" and row.cls == "stocks" and row.name == "ZZZZ"
    assert row.rank >= uv.CUSTOM_RANK_BASE
    # Stable on a second call; no duplicate rows.
    assert uv.tracked_symbols(session, settings()) == tracked
    assert count(session, ScreenerSymbol) == UNIQUE + 2

    off = uv.tracked_symbols(session, settings(screener_include_watchlists=False))
    assert len(off) == UNIQUE and "ZZZZ" not in off
    # The cap holds the bundle and lists; watchlist symbols have their own allowance on top.
    capped = uv.tracked_symbols(session, settings(screener_max_symbols=UNIQUE))
    assert len(capped) == UNIQUE + 2 and capped[-2:] == ["ZZZZ", "NEWIPO"]


def test_tracked_includes_list_members_and_guesses_class(session: Session) -> None:
    uv.seed_bundle(session, settings(), now=NOW)
    uv.put_list(session, "mine", "Mine", "2026-11", ["AAPL", "DOGE2-USD", "XYZ=F", "ABCD"], now=NOW)
    tracked = uv.tracked_symbols(session, settings(screener_include_watchlists=False))
    assert tracked[-3:] == ["ABCD", "DOGE2-USD", "XYZ=F"]
    cls = {s: session.get(ScreenerSymbol, s).cls for s in tracked[-3:]}  # type: ignore[union-attr]
    assert cls == {"DOGE2-USD": "crypto", "XYZ=F": "commodities", "ABCD": "stocks"}
    # A custom symbol that is no longer referenced drops out.
    assert uv.delete_list(session, "mine") == "removed"
    assert "ABCD" not in uv.tracked_symbols(session, settings())


def test_tracked_watchlist_symbols_are_not_starved_by_list_only_customs(
    session: Session,
) -> None:
    uv.seed_bundle(session, settings(), now=NOW)
    cap = UNIQUE + 30
    custom = [f"LST{i}" for i in range(60)]  # list-only: 60 wanted, 30 fit under the cap
    uv.put_list(session, "big", "Big", "2026-11", custom, now=NOW)
    watchlist(session, "w1", ["WL1", "WL2", "AAPL"])
    session.flush()
    tracked = uv.tracked_symbols(session, settings(screener_max_symbols=cap))
    assert {"WL1", "WL2"} <= set(tracked)
    assert len([s for s in tracked if s.startswith("LST")]) == 30
    assert len(tracked) == cap + 2 and len(set(tracked)) == len(tracked)
    # Without watchlists the cap alone applies.
    off = uv.tracked_symbols(
        session, settings(screener_max_symbols=cap, screener_include_watchlists=False)
    )
    assert len(off) == cap and "WL1" not in off


def test_tracked_watchlist_allowance_is_bounded(session: Session) -> None:
    uv.seed_bundle(session, settings(), now=NOW)
    wanted = [f"W{i:03d}" for i in range(uv.WATCHLIST_ALLOWANCE + 25)]
    watchlist(session, "w1", wanted)
    session.flush()
    tracked = uv.tracked_symbols(session, settings())
    extra = [s for s in tracked if s.startswith("W") and s in wanted]
    assert extra == wanted[: uv.WATCHLIST_ALLOWANCE]  # first seen first
    # A bundled watchlist symbol the cap cut still gets in through the allowance.
    assert "MSFT" not in uv.tracked_symbols(session, settings(screener_max_symbols=5))
    watchlist(session, "w2", ["MSFT"])
    session.flush()
    assert "MSFT" in uv.tracked_symbols(session, settings(screener_max_symbols=5))


# -------------------------------------------------------------------- lists


def test_list_lists_and_override_and_revert(session: Session) -> None:
    uv.seed_bundle(session, settings(), now=NOW)
    lists = uv.list_lists(session)
    assert [(x["id"], x["kind"], x["source"], x["asOf"]) for x in lists] == [
        ("ndx100", "index", "bundled", "2026-01"),
        ("sp500", "index", "bundled", "2026-01"),
    ]
    assert lists[1]["count"] == len(uv.bundle().lists["sp500"].symbols)
    assert lists[0]["name"] == "Nasdaq-100"

    out = uv.put_list(session, "sp500", "S&P 500 (mine)", "2026-10", ["aapl", "AAPL", "MSFT"])
    assert out == {
        "id": "sp500", "name": "S&P 500 (mine)", "kind": "index", "asOf": "2026-10",
        "source": "upload", "count": 2,
    }  # fmt: skip
    assert uv.list_symbols(session, "sp500") == ["AAPL", "MSFT"]

    assert uv.delete_list(session, "sp500") == "reverted"
    lst = session.get(ScreenerList, "sp500")
    assert lst and lst.source == "bundled" and lst.name == "S&P 500"
    assert uv.list_symbols(session, "sp500") == sorted(uv.bundle().lists["sp500"].symbols)
    assert uv.delete_list(session, "sp500") == "unchanged"
    assert uv.delete_list(session, "nope") == "missing"


def test_custom_list_crud(session: Session) -> None:
    out = uv.put_list(session, "my-list_1", "Mine", "2026-11-06", ["NVDA"])
    assert out["kind"] == "custom" and out["source"] == "upload" and out["count"] == 1
    out = uv.put_list(session, "my-list_1", "Renamed", "2026-11", ["NVDA", "AMD"])
    assert out["name"] == "Renamed" and out["count"] == 2 and out["kind"] == "custom"
    assert [x["id"] for x in uv.list_lists(session)] == ["my-list_1"]
    assert uv.delete_list(session, "my-list_1") == "removed"
    assert count(session, ScreenerListMember) == 0 and uv.list_symbols(session, "my-list_1") is None


@pytest.mark.parametrize(
    ("args", "code"),
    [
        (("bad id", "N", "2026-01", ["A"]), "bad_id"),
        (("x" * 37, "N", "2026-01", ["A"]), "bad_id"),
        (("ok", "  ", "2026-01", ["A"]), "bad_name"),
        (("ok", "n" * 201, "2026-01", ["A"]), "bad_name"),
        (("ok", "N", "Jan 2026", ["A"]), "bad_as_of"),
        (("ok", "N", "2026-01", ["A", "no good"]), "bad_symbol"),
        (("ok", "N", "2026-01", [""]), "bad_symbol"),
        (("ok", "N", "2026-01", ["A" * 33]), "bad_symbol"),
        (("ok", "N", "2026-01", [f"S{i}" for i in range(1501)]), "too_many_symbols"),
    ],
)
def test_put_list_validation(session: Session, args: tuple[Any, ...], code: str) -> None:
    with pytest.raises(uv.ListError) as exc:
        uv.put_list(session, *args)
    assert exc.value.code == code
    assert count(session, ScreenerList) == 0


def test_put_list_accepts_the_maximum(session: Session) -> None:
    out = uv.put_list(session, "big", "Big", "2026-01", [f"S{i}" for i in range(1500)])
    assert out["count"] == 1500


# ---------------------------------------------------------- app, cache, migration


def test_app_startup_seeds_the_bundle(tmp_path: Path) -> None:
    url = f"sqlite:///{tmp_path}/a.db"
    with TestClient(create_app(provider=DemoProvider(), database_url=url)) as client:
        engine = client.app.state.engine  # type: ignore[attr-defined]
        with Session(engine) as s:
            assert count(s, ScreenerSymbol) == UNIQUE
            assert s.get(AppMeta, uv.BUNDLE_KEY).value == uv.bundle_hash()  # type: ignore[union-attr]
    with (
        TestClient(create_app(provider=DemoProvider(), database_url=url)) as client,
        Session(client.app.state.engine) as s,  # type: ignore[attr-defined]
    ):
        assert count(s, ScreenerSymbol) == UNIQUE


def test_provider_switch_wipes_snapshots_and_fundamentals_only(engine: Engine) -> None:
    ensure_cache_source(engine, "yahoo")
    with Session(engine) as s, s.begin():
        uv.seed_bundle(s, settings(), now=NOW)
        s.add(
            ScreenerSnapshot(
                symbol="AAPL",
                provider="yahoo",
                as_of_date=NOW.date(),
                bar_ts=1,
                computed_at=NOW,
                bars_count=250,
                last=1.0,
            )  # fmt: skip
        )
        s.add(ScreenerFundamental(symbol="AAPL", provider="yahoo", mcap=1.0))
    assert ensure_cache_source(engine, "twelvedata") is True
    with Session(engine) as s:
        assert count(s, ScreenerSnapshot) == 0 and count(s, ScreenerFundamental) == 0
        assert count(s, ScreenerSymbol) == UNIQUE and count(s, ScreenerList) == 2


SCREENER_TABLES = {
    "screener_symbols",
    "screener_lists",
    "screener_list_members",
    "screener_snapshots",
    "screener_fundamentals",
    "screener_runs",
    "job_leases",
    "screens",
    "screen_states",
}


def test_migration_up_down_matches_models(tmp_path: Path) -> None:
    url = f"sqlite:///{tmp_path}/m.db"
    cfg = alembic_config(url)
    engine = create_engine(url)
    command.upgrade(cfg, "5d2a7f3c9e18")
    assert not set(inspect(engine).get_table_names()) & SCREENER_TABLES
    command.upgrade(cfg, "head")
    assert set(inspect(engine).get_table_names()) >= SCREENER_TABLES
    with engine.connect() as conn:
        assert compare_metadata(MigrationContext.configure(conn), Base.metadata) == []
    snap_cols = {c["name"] for c in inspect(engine).get_columns("screener_snapshots")}
    assert {"as_of_date", "rsi14", "prev_sma200", "cross_state", "days_since_cross"} <= snap_cols
    assert len(snap_cols) == 42

    command.downgrade(cfg, "5d2a7f3c9e18")
    tables = set(inspect(engine).get_table_names())
    assert not tables & SCREENER_TABLES and "app_meta" in tables
    command.upgrade(cfg, "head")
    assert set(inspect(engine).get_table_names()) >= SCREENER_TABLES
    engine.dispose()


def test_deleting_a_list_or_screen_cascades(engine: Engine) -> None:
    with Session(engine) as s, s.begin():
        uv.put_list(s, "tmp", "Tmp", "2026-01", ["AAPL", "MSFT"])
    with Session(engine) as s, s.begin():
        s.delete(s.get(ScreenerList, "tmp"))
    with Session(engine) as s:
        assert count(s, ScreenerListMember) == 0
