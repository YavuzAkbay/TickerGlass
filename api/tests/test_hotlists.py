"""Hotlists API: kinds and ordering on fixture snapshots, no upstream calls, validation."""

from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session
from test_screener_query import TARGET, add_run, add_snap
from test_screener_routes import ScreenProvider, make_client, session_of

from tickerglass_api.services.screener import universe as uv
from tickerglass_api.services.screener.hotlists import KINDS
from tickerglass_api.services.screener.job import ScreenerJob

URL = "/api/screener/hotlists"
#: Fixture rows a..f are the first six bundled stocks, in this order.
LETTERS = "abcdef"


@pytest.fixture
def symbols() -> list[str]:
    return uv.class_symbols("stocks")[:6]


@pytest.fixture
def provider() -> ScreenProvider:
    return ScreenProvider()


@pytest.fixture
def client(
    tmp_path: Path,
    provider: ScreenProvider,
    symbols: list[str],
    monkeypatch: pytest.MonkeyPatch,
) -> Iterator[TestClient]:
    monkeypatch.setattr(ScreenerJob, "target_date", lambda self, now=None: TARGET)
    with make_client(tmp_path, provider) as c:
        with session_of(c) as s:
            seed(s, symbols)
        provider.calls.clear()
        yield c


def seed(s: Session, sym: list[str]) -> None:
    a, b, c, d, e, f = sym
    add_snap(
        s, a, last=100.0, chg1d_pct=3.0, gap_pct=1.5, rel_vol=3.2, rsi14=75.0,
        avg_dollar_vol30=5e9, new_hi52=True, pct_off_hi52=0.0, new_lo52=False,
        cross_state=1, days_since_cross=2,
    )  # fmt: skip
    add_snap(
        s, b, last=50.0, chg1d_pct=-4.0, gap_pct=-2.5, rel_vol=2.0, rsi14=25.0,
        avg_dollar_vol30=9e9, new_hi52=False, new_lo52=True, pct_off_lo52=0.0,
        cross_state=-1, days_since_cross=1,
    )  # fmt: skip
    add_snap(
        s, c, last=20.0, chg1d_pct=8.0, gap_pct=4.0, rel_vol=1.0, rsi14=71.0,
        avg_dollar_vol30=1e9, new_hi52=True, pct_off_hi52=-1.0, new_lo52=False,
        cross_state=1, days_since_cross=9,
    )  # fmt: skip
    add_snap(
        s, d, last=10.0, chg1d_pct=-1.0, gap_pct=-0.5, rel_vol=5.0, rsi14=28.0,
        avg_dollar_vol30=2e9, new_hi52=False, new_lo52=True, pct_off_lo52=2.0,
        cross_state=1, days_since_cross=5,
    )  # fmt: skip
    add_snap(s, e)  # all-null snapshot: never listed
    add_snap(s, f, last=5.0, chg1d_pct=0.0, gap_pct=0.0, rel_vol=1.9, rsi14=50.0)
    s.commit()


def get(client: TestClient, kind: str, **params: Any) -> Any:
    return client.get(URL, params={"kind": kind, **params})


def letters(client: TestClient, symbols: list[str], kind: str, **params: Any) -> str:
    res = get(client, kind, **params)
    assert res.status_code == 200, res.text
    return "".join(LETTERS[symbols.index(r["symbol"])] for r in res.json()["rows"])


def test_every_kind_is_registered() -> None:
    assert set(KINDS) == {
        "gainers", "losers", "active", "unusualVolume", "newHighs", "newLows",
        "oversold", "overbought", "gapUp", "gapDown", "goldenCross",
    }  # fmt: skip


def test_empty_before_the_first_run(client: TestClient, provider: ScreenProvider) -> None:
    res = get(client, "gainers")
    assert res.status_code == 200
    assert res.json() == {"kind": "gainers", "asOf": None, "universe": "stocks", "rows": []}
    assert provider.calls == []


@pytest.mark.parametrize(
    ("kind", "expected"),
    [
        ("gainers", "ca"),
        ("losers", "bd"),
        ("active", "badc"),  # 9e9, 5e9, 2e9, 1e9
        ("unusualVolume", "dab"),
        ("newHighs", "ac"),
        ("newLows", "bd"),
        ("oversold", "bd"),
        ("overbought", "ac"),
        ("gapUp", "ca"),
        ("gapDown", "bd"),
        ("goldenCross", "ad"),
    ],
)
def test_kind_filter_and_order(
    client: TestClient, symbols: list[str], kind: str, expected: str
) -> None:
    with session_of(client) as s:
        add_run(s)
        s.commit()
    assert letters(client, symbols, kind) == expected


def test_row_shape_and_value(
    client: TestClient, symbols: list[str], provider: ScreenProvider
) -> None:
    with session_of(client) as s:
        add_run(s)
        s.commit()
    res = get(client, "unusualVolume", limit=2)
    assert res.headers["cache-control"] == "private, no-cache"
    body = res.json()
    assert body["asOf"] == TARGET.isoformat() and body["universe"] == "stocks"
    assert [r["value"] for r in body["rows"]] == [5.0, 3.2]
    first = body["rows"][0]
    assert first.keys() == {"symbol", "name", "value", "last", "chg1d"}
    assert (first["symbol"], first["last"], first["chg1d"]) == (symbols[3], 10.0, -1.0)
    assert provider.calls == []


def test_list_and_class_universes(client: TestClient, symbols: list[str]) -> None:
    with session_of(client) as s:
        add_run(s)
        s.commit()
    assert letters(client, symbols, "gainers", universe="etfs") == ""
    first = client.get("/api/screener/lists").json()[0]["id"]
    assert get(client, "gainers", universe=f"list:{first}").status_code == 200
    assert get(client, "gainers", universe="list:nope").status_code == 404


def test_validation(client: TestClient) -> None:
    assert get(client, "bogus").status_code == 422
    assert client.get(URL).status_code == 422
    assert get(client, "gainers", universe="watchlist:x").status_code == 422
    for bad in ("list:bad id", "list:a/b", "list:" + "x" * 37, "list:a\n", "list:"):
        assert get(client, "gainers", universe=bad).status_code == 422, bad
    assert get(client, "gainers", limit=51).status_code == 422
    assert get(client, "gainers", limit=0).status_code == 422
    assert get(client, "gainers", limit=50).status_code == 200


def test_etag_and_304(client: TestClient) -> None:
    with session_of(client) as s:
        add_run(s)
        s.commit()
    first = get(client, "gainers")
    etag = first.headers["etag"]
    for header in (etag, f"W/{etag}", "*"):
        res = client.get(URL, params={"kind": "gainers"}, headers={"If-None-Match": header})
        assert res.status_code == 304 and res.content == b""
    assert get(client, "losers").headers["etag"] != etag
    assert get(client, "gainers", limit=5).headers["etag"] != etag
