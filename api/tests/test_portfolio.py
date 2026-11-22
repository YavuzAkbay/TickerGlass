"""Portfolio, transactions, broker import, trade journal, screenshots (design/portfolio.md)."""

import base64
import json
from typing import Any

import pytest
from fastapi.testclient import TestClient

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 32
WEBP = b"RIFF\x24\x00\x00\x00WEBPVP8 " + b"\x00" * 24


def mk_portfolio(client: TestClient, **kw: Any) -> dict[str, Any]:
    res = client.post("/api/portfolios", json={"name": "Main", **kw})
    assert res.status_code == 201, res.text
    out: dict[str, Any] = res.json()
    return out


def buy(**kw: Any) -> dict[str, Any]:
    return {
        "kind": "buy",
        "time": "2026-01-05T15:00:00Z",
        "symbol": "AAPL",
        "quantity": 10,
        "price": 100.5,
        "currency": "USD",
        **kw,
    }


def post_tx(client: TestClient, pid: str, **kw: Any) -> dict[str, Any]:
    res = client.post(f"/api/portfolios/{pid}/transactions", json=buy(**kw))
    assert res.status_code == 201, res.text
    out: dict[str, Any] = res.json()
    return out


# --------------------------------------------------------------- portfolios


def test_portfolio_crud_and_conflict(client: TestClient) -> None:
    assert client.get("/api/portfolios").json() == []
    p = mk_portfolio(client)
    assert p["name"] == "Main" and p["baseCurrency"] == "USD" and p["benchmark"] == "SPY"
    assert p["costMethod"] == "fifo" and p["revision"] == 1
    q = mk_portfolio(client, name=" Eur ", baseCurrency="eur", benchmark=None, costMethod="average")
    assert (q["name"], q["baseCurrency"], q["benchmark"], q["costMethod"]) == (
        "Eur",
        "EUR",
        None,
        "average",
    )
    assert [x["id"] for x in client.get("/api/portfolios").json()] == [p["id"], q["id"]]
    assert client.get(f"/api/portfolios/{p['id']}").json()["name"] == "Main"

    url = f"/api/portfolios/{p['id']}"
    res = client.put(url, json={"name": "Renamed", "revision": 1})
    assert res.status_code == 200 and res.json()["revision"] == 2
    # Omitted settings are kept.
    assert res.json()["benchmark"] == "SPY" and res.json()["baseCurrency"] == "USD"
    res = client.put(url, json={"name": "Stale", "revision": 1})
    assert res.status_code == 409 and res.json()["detail"]["current"]["name"] == "Renamed"
    res = client.put(url, json={"name": "Forced", "benchmark": None, "costMethod": "average"})
    assert res.status_code == 200 and res.json()["revision"] == 3
    assert res.json()["benchmark"] is None and res.json()["costMethod"] == "average"
    res = client.put(url, json={"name": "Forced", "benchmark": " qqq "})
    assert res.json()["benchmark"] == "QQQ"

    assert client.put("/api/portfolios/nope", json={"name": "x"}).status_code == 404
    assert client.get("/api/portfolios/nope").status_code == 404
    for bad in (
        {"name": ""},
        {"name": "x" * 81},
        {"name": "x", "baseCurrency": "US"},
        {"name": "x", "baseCurrency": "U$D"},
        {"name": "x", "costMethod": "lifo"},
        {"name": "x", "extra": 1},
    ):
        assert client.post("/api/portfolios", json=bad).status_code == 422, bad
    assert client.delete(url).status_code == 204
    assert client.get(url).status_code == 404


# ------------------------------------------------------------- transactions

GOOD: list[dict[str, Any]] = [
    {"kind": "buy", "symbol": "AAPL", "quantity": 1, "price": 0},
    {"kind": "sell", "symbol": "AAPL", "quantity": 1, "price": 2, "fee": 1.5},
    {"kind": "dividend", "symbol": "AAPL", "amount": 5, "fee": 0.75},
    {"kind": "dividend", "symbol": "AAPL", "amount": 5, "fee": 5},
    {"kind": "interest", "amount": 2, "fee": 0.5},
    {"kind": "split", "symbol": "AAPL", "quantity": 0.1},
    {"kind": "split", "symbol": "AAPL", "quantity": 4},
    {"kind": "fee", "amount": 3},
    {"kind": "fee", "symbol": "AAPL", "amount": 3},
    {"kind": "interest", "amount": 1},
    {"kind": "cashIn", "amount": 1000},
    {"kind": "cashOut", "amount": 1000},
]

BAD: list[tuple[dict[str, Any], str]] = [
    ({"kind": "buy", "quantity": 1, "price": 1}, "symbol is required"),
    ({"kind": "buy", "symbol": "A", "price": 1}, "quantity is required"),
    ({"kind": "buy", "symbol": "A", "quantity": 0, "price": 1}, "quantity must be > 0"),
    ({"kind": "buy", "symbol": "A", "quantity": -1, "price": 1}, "quantity must be > 0"),
    ({"kind": "buy", "symbol": "A", "quantity": 1}, "price is required"),
    ({"kind": "sell", "symbol": "A", "quantity": 1, "price": -1}, "price must be >= 0"),
    ({"kind": "buy", "symbol": "A", "quantity": 1, "price": 1, "amount": 5}, "amount must be null"),
    ({"kind": "dividend", "symbol": "A", "amount": 0}, "amount must be > 0"),
    ({"kind": "dividend", "symbol": "A"}, "amount is required"),
    ({"kind": "dividend", "symbol": "A", "amount": 1, "quantity": 1}, "quantity must be null"),
    ({"kind": "dividend", "amount": 1}, "symbol is required"),
    ({"kind": "split", "symbol": "A", "quantity": 0}, "quantity must be > 0"),
    ({"kind": "split", "symbol": "A", "quantity": 2, "price": 1}, "price must be null"),
    ({"kind": "split", "symbol": "A", "quantity": 2, "amount": 1}, "amount must be null"),
    ({"kind": "fee", "amount": 3, "quantity": 1}, "quantity must be null"),
    ({"kind": "fee"}, "amount is required"),
    ({"kind": "interest", "symbol": "A", "amount": 1}, "symbol must be null"),
    ({"kind": "interest", "amount": -1}, "amount must be > 0"),
    ({"kind": "cashIn", "symbol": "A", "amount": 1}, "symbol must be null"),
    ({"kind": "cashOut", "amount": 1, "price": 1}, "price must be null"),
    ({"kind": "buy", "symbol": "A", "quantity": 1, "price": 1, "fee": -1}, "fee"),
    ({"kind": "dividend", "symbol": "A", "amount": 5, "fee": 5.01}, "fee must be <= amount"),
    ({"kind": "interest", "amount": 2, "fee": 3}, "fee must be <= amount"),
    ({"kind": "cashIn", "amount": 10, "fee": 1}, "fee must be 0"),
    ({"kind": "cashOut", "amount": 10, "fee": 1}, "fee must be 0"),
    ({"kind": "split", "symbol": "A", "quantity": 2, "fee": 1}, "fee must be 0"),
    ({"kind": "fee", "amount": 3, "fee": 1}, "fee must be 0"),
    ({"kind": "buy", "symbol": "A", "quantity": 1, "price": 1, "currency": "us"}, "currency"),
    ({"kind": "buy", "symbol": "A", "quantity": 1, "price": 1, "note": "x" * 2001}, "note"),
    ({"kind": "gift", "symbol": "A"}, "kind"),
    ({"kind": "buy", "symbol": "A", "quantity": 1, "price": 1, "source": "manual"}, "source"),
    ({"kind": "buy", "symbol": "A", "quantity": 1, "price": 1, "time": "yesterday"}, "time"),
]


@pytest.mark.parametrize("fields", GOOD, ids=lambda f: f["kind"])
def test_tx_kinds_accept(client: TestClient, fields: dict[str, Any]) -> None:
    pid = mk_portfolio(client)["id"]
    body = {"time": "2026-02-01T10:00:00+02:00", "currency": "usd", **fields}
    res = client.post(f"/api/portfolios/{pid}/transactions", json=body)
    assert res.status_code == 201, res.text
    tx = res.json()
    assert tx["kind"] == fields["kind"] and tx["source"] == "manual" and tx["revision"] == 1
    assert tx["currency"] == "USD" and tx["time"].startswith("2026-02-01T08:00:00")
    assert tx["fee"] == fields.get("fee", 0) and tx["importBatch"] is None
    assert tx["portfolioId"] == pid


@pytest.mark.parametrize(("fields", "msg"), BAD, ids=[f"{i}" for i in range(len(BAD))])
def test_tx_kinds_reject(client: TestClient, fields: dict[str, Any], msg: str) -> None:
    pid = mk_portfolio(client)["id"]
    body = {"time": "2026-02-01T10:00:00Z", "currency": "USD", **fields}
    res = client.post(f"/api/portfolios/{pid}/transactions", json=body)
    assert res.status_code == 422, res.text
    assert msg in res.text
    # Same rules on update.
    tx = post_tx(client, pid)
    assert client.put(f"/api/transactions/{tx['id']}", json=body).status_code == 422


def test_tx_missing_currency_and_unknown_portfolio(client: TestClient) -> None:
    pid = mk_portfolio(client)["id"]
    body = buy()
    del body["currency"]
    assert client.post(f"/api/portfolios/{pid}/transactions", json=body).status_code == 422
    assert client.post("/api/portfolios/nope/transactions", json=buy()).status_code == 404
    assert client.get("/api/portfolios/nope/transactions").status_code == 404


def test_tx_list_order_filter_and_symbol_normalized(client: TestClient) -> None:
    pid = mk_portfolio(client)["id"]
    late = post_tx(client, pid, time="2026-03-01T00:00:00Z", symbol=" msft ")
    early = post_tx(client, pid, time="2026-01-01T00:00:00Z")
    mid = post_tx(client, pid, time="2026-02-01T00:00:00Z", symbol="aapl")
    assert late["symbol"] == "MSFT"
    url = f"/api/portfolios/{pid}/transactions"
    assert [t["id"] for t in client.get(url).json()] == [early["id"], mid["id"], late["id"]]
    only = client.get(url, params={"symbol": "msft"}).json()
    assert [t["id"] for t in only] == [late["id"]]
    assert client.get(url, params={"symbol": "NOPE"}).json() == []
    other = mk_portfolio(client, name="Other")["id"]
    assert client.get(f"/api/portfolios/{other}/transactions").json() == []


def test_tx_put_delete_and_external_id(client: TestClient) -> None:
    pid = mk_portfolio(client)["id"]
    a = post_tx(client, pid, externalId="e1", note="  hi  ")
    assert a["externalId"] == "e1" and a["note"] == "hi"
    dup = client.post(f"/api/portfolios/{pid}/transactions", json=buy(externalId="e1"))
    assert dup.status_code == 409 and dup.json()["detail"]["current"]["id"] == a["id"]
    # Same externalId in another portfolio is fine.
    other = mk_portfolio(client, name="Other")["id"]
    post_tx(client, other, externalId="e1")
    b = post_tx(client, pid, externalId="e2")

    url = f"/api/transactions/{a['id']}"
    res = client.put(url, json=buy(quantity=3, externalId="e1", revision=1))
    assert res.status_code == 200 and res.json()["revision"] == 2 and res.json()["quantity"] == 3
    assert res.json()["source"] == "manual"
    stale = client.put(url, json=buy(quantity=9, externalId="e1", revision=1))
    assert stale.status_code == 409 and stale.json()["detail"]["current"]["quantity"] == 3
    clash = client.put(url, json=buy(externalId="e2"))
    assert clash.status_code == 409 and clash.json()["detail"]["current"]["id"] == b["id"]
    # Absent externalId keeps the stored value; an explicit null clears it.
    kept = client.put(url, json=buy(quantity=4))
    assert kept.status_code == 200 and kept.json()["externalId"] == "e1"
    assert kept.json()["quantity"] == 4
    assert client.put(url, json=buy(externalId=None)).json()["externalId"] is None
    assert client.put(url, json=buy()).json()["externalId"] is None
    assert (
        client.post(f"/api/portfolios/{pid}/transactions", json=buy(externalId="e1")).status_code
        == 201
    )
    assert client.put("/api/transactions/nope", json=buy()).status_code == 404
    assert client.delete(url).status_code == 204
    assert client.delete(url).status_code == 404


# ------------------------------------------------------------------- import


def test_import_dry_run_dedupe_and_undo(client: TestClient) -> None:
    pid = mk_portfolio(client)["id"]
    url = f"/api/portfolios/{pid}/transactions/import"
    post_tx(client, pid, externalId="x1")
    rows = [
        buy(externalId="x1"),  # exists
        buy(externalId="x2"),
        buy(externalId="x2", quantity=5),  # repeated inside the payload
        buy(externalId="x3"),
        buy(),  # no externalId -> never deduplicated
        buy(),
    ]
    body = {"transactions": rows, "source": "import:ibkr"}

    dry = client.post(url, json={**body, "dryRun": True})
    assert dry.status_code == 200
    assert dry.json() == {"batch": None, "created": 4, "skipped": 2, "errors": []}
    assert len(client.get(f"/api/portfolios/{pid}/transactions").json()) == 1

    res = client.post(url, json=body)
    assert res.status_code == 200
    out = res.json()
    assert out["created"] == 4 and out["skipped"] == 2 and out["errors"] == []
    batch = out["batch"]
    assert isinstance(batch, str) and batch
    txs = client.get(f"/api/portfolios/{pid}/transactions").json()
    imported = [t for t in txs if t["importBatch"] == batch]
    assert len(imported) == 4 and all(t["source"] == "import:ibkr" for t in imported)
    assert [t for t in txs if t["importBatch"] is None][0]["source"] == "manual"

    # Importing the same payload again only skips the rows with an externalId.
    again = client.post(url, json=body).json()
    assert again["created"] == 2 and again["skipped"] == 4 and again["batch"] != batch

    # Undo removes exactly one batch.
    undo = client.delete(f"/api/portfolios/{pid}/imports/{batch}")
    assert undo.status_code == 200 and undo.json() == {"deleted": 4}
    assert client.delete(f"/api/portfolios/{pid}/imports/{batch}").json() == {"deleted": 0}
    assert len(client.get(f"/api/portfolios/{pid}/transactions").json()) == 3
    assert client.delete("/api/portfolios/nope/imports/x").status_code == 404
    # A batch of another portfolio is untouched.
    other = mk_portfolio(client, name="Other")["id"]
    assert client.delete(f"/api/portfolios/{other}/imports/{again['batch']}").json() == {
        "deleted": 0
    }


def test_import_nothing_created_has_no_batch(client: TestClient) -> None:
    pid = mk_portfolio(client)["id"]
    url = f"/api/portfolios/{pid}/transactions/import"
    res = client.post(url, json={"transactions": [], "source": "import:generic"})
    assert res.status_code == 200
    assert res.json() == {"batch": None, "created": 0, "skipped": 0, "errors": []}


def test_import_invalid_row_is_atomic(client: TestClient) -> None:
    pid = mk_portfolio(client)["id"]
    url = f"/api/portfolios/{pid}/transactions/import"
    rows = [
        buy(externalId="ok"),
        {
            "kind": "interest",
            "symbol": "A",
            "amount": 1,
            "time": "2026-01-01T00:00:00Z",
            "currency": "USD",
        },
        buy(quantity=-1),
        buy(extra=True),
        buy(),
    ]
    res = client.post(url, json={"transactions": rows, "source": "import:ibkr"})
    assert res.status_code == 422
    errors = res.json()["detail"]["errors"]
    assert [e["index"] for e in errors] == [1, 2, 3]
    assert "symbol must be null" in errors[0]["message"]
    assert "quantity must be > 0" in errors[1]["message"]
    assert all(isinstance(e["message"], str) for e in errors)
    assert client.get(f"/api/portfolios/{pid}/transactions").json() == []
    # dryRun reports the same errors.
    res = client.post(url, json={"transactions": rows, "source": "import:ibkr", "dryRun": True})
    assert res.status_code == 422


@pytest.mark.parametrize(
    "source", ["manual", "import:", "import:a b", "ibkr", "import:" + "x" * 33]
)
def test_import_source_must_be_import_id(client: TestClient, source: str) -> None:
    pid = mk_portfolio(client)["id"]
    res = client.post(
        f"/api/portfolios/{pid}/transactions/import",
        json={"transactions": [buy()], "source": source},
    )
    assert res.status_code == 422


def test_import_row_cap_and_unknown_portfolio(client: TestClient) -> None:
    pid = mk_portfolio(client)["id"]
    row = buy()
    url = f"/api/portfolios/{pid}/transactions/import"
    res = client.post(url, json={"transactions": [row] * 20_001, "source": "import:generic"})
    assert res.status_code == 422
    res = client.post(
        "/api/portfolios/nope/transactions/import",
        json={"transactions": [], "source": "import:generic"},
    )
    assert res.status_code == 404


def test_tx_seq_orders_same_timestamp_rows(client: TestClient) -> None:
    pid = mk_portfolio(client)["id"]
    url = f"/api/portfolios/{pid}/transactions"
    first = post_tx(client, pid)
    sell = {**buy(), "kind": "sell", "price": 101}
    second = client.post(url, json=sell).json()
    third = post_tx(client, pid, quantity=3)
    other = mk_portfolio(client, name="Other")["id"]
    assert post_tx(client, other)["seq"] == 1  # numbered per portfolio
    assert [t["seq"] for t in (first, second, third)] == [1, 2, 3]
    # Insertion order wins over id order whatever the ids are.
    assert [t["id"] for t in client.get(url).json()] == [first["id"], second["id"], third["id"]]
    # Update keeps seq; a new row goes after the highest one even once rows are deleted.
    put = client.put(f"/api/transactions/{second['id']}", json=sell)
    assert put.json()["seq"] == 2
    client.delete(f"/api/transactions/{third['id']}")
    assert post_tx(client, pid)["seq"] == 3
    assert [t["seq"] for t in client.get(url).json()] == [1, 2, 3]


def test_import_seq_is_consecutive_in_payload_order(client: TestClient) -> None:
    pid = mk_portfolio(client)["id"]
    url = f"/api/portfolios/{pid}/transactions"
    post_tx(client, pid, time="2026-01-01T00:00:00Z")
    rows = [
        buy(externalId="a"),
        {**buy(), "kind": "sell", "price": 110, "externalId": "b"},
        buy(externalId="a"),  # skipped duplicate: leaves no gap
        buy(externalId="c", quantity=2),
        buy(time="2025-12-31T00:00:00Z", externalId="d"),
    ]
    res = client.post(f"{url}/import", json={"transactions": rows, "source": "import:ibkr"})
    assert res.json()["created"] == 4
    txs = client.get(url).json()
    assert [(t["externalId"], t["seq"]) for t in txs] == [
        ("d", 5),
        (None, 1),
        ("a", 2),
        ("b", 3),
        ("c", 4),
    ]
    assert [t["kind"] for t in txs if t["time"].startswith("2026-01-05")] == ["buy", "sell", "buy"]


def test_import_body_is_capped_before_parsing(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from tickerglass_api.userdata import portfolio as pf

    pid = mk_portfolio(client)["id"]
    url = f"/api/portfolios/{pid}/transactions/import"
    body = json.dumps({"transactions": [buy(externalId="x")], "source": "import:ibkr"}).encode()
    headers = {"Content-Type": "application/json"}
    monkeypatch.setattr(pf, "MAX_IMPORT_BYTES", len(body) - 1)
    # Declared Content-Length is over the cap: 413, even though the body is not valid JSON.
    res = client.post(url, content=b"{" * len(body), headers=headers)
    assert res.status_code == 413, res.text
    # Chunked body without a length is cut off while reading.
    res = client.post(url, content=iter([body[:10], body[10:]]), headers=headers)
    assert res.status_code == 413, res.text
    assert client.get(f"/api/portfolios/{pid}/transactions").json() == []
    # At the cap it goes through.
    monkeypatch.setattr(pf, "MAX_IMPORT_BYTES", len(body))
    res = client.post(url, content=body, headers=headers)
    assert res.status_code == 200 and res.json()["created"] == 1


def test_import_default_cap_is_32_mb(client: TestClient) -> None:
    pid = mk_portfolio(client)["id"]
    big = b" " * (32 * 1024 * 1024 + 1)
    res = client.post(
        f"/api/portfolios/{pid}/transactions/import",
        content=big,
        headers={"Content-Type": "application/json"},
    )
    assert res.status_code == 413


# ------------------------------------------------------------------ journal


def mk_note(client: TestClient, symbol: str = "AAPL", kind: str = "journal") -> dict[str, Any]:
    body = {"symbol": symbol, "text": "thesis", "kind": kind}
    return client.post("/api/notes", json=body).json()  # type: ignore[no-any-return]


def test_journal_crud_and_note_link(client: TestClient) -> None:
    pid = mk_portfolio(client)["id"]
    tx = post_tx(client, pid)
    note = mk_note(client)
    url = f"/api/portfolios/{pid}/journal"
    assert client.get(url).json() == []

    res = client.post(
        url,
        json={
            "transactionId": tx["id"],
            "symbol": " aapl ",
            "noteId": note["id"],
            "setup": " Breakout ",
            "tags": ["a", " b ", "a", "", "c"],
            "stop": 95.5,
            "rMultiple": 2.5,
        },
    )
    assert res.status_code == 201, res.text
    e = res.json()
    assert e["transactionId"] == tx["id"] and e["noteId"] == note["id"] and e["symbol"] == "AAPL"
    assert e["setup"] == "Breakout" and e["tags"] == ["a", "b", "c"]
    assert e["stop"] == 95.5 and e["rMultiple"] == 2.5
    assert e["hasScreenshot"] is False and e["revision"] == 1 and e["portfolioId"] == pid

    bare = client.post(url, json={}).json()
    assert bare["tags"] == [] and bare["setup"] is None and bare["noteId"] is None
    assert [x["id"] for x in client.get(url).json()] == [e["id"], bare["id"]]

    put = f"/api/journal/{e['id']}"
    res = client.put(put, json={"noteId": note["id"], "setup": "Pullback", "revision": 1})
    assert res.status_code == 200 and res.json()["revision"] == 2
    assert res.json()["setup"] == "Pullback" and res.json()["transactionId"] is None
    assert res.json()["tags"] == [] and res.json()["stop"] is None
    stale = client.put(put, json={"setup": "x", "revision": 1})
    assert stale.status_code == 409 and stale.json()["detail"]["current"]["setup"] == "Pullback"
    assert client.put("/api/journal/nope", json={}).status_code == 404

    # Deleting the entry deletes its note.
    assert client.delete(put).status_code == 204
    assert client.get(f"/api/notes/{note['id']}").status_code == 404
    assert client.delete(put).status_code == 404
    assert [x["id"] for x in client.get(url).json()] == [bare["id"]]


def test_journal_put_deletes_replaced_note(client: TestClient) -> None:
    pid = mk_portfolio(client)["id"]
    first, second = mk_note(client), mk_note(client, "MSFT")
    entry = client.post(f"/api/portfolios/{pid}/journal", json={"noteId": first["id"]}).json()
    put = f"/api/journal/{entry['id']}"

    # Same note: kept.
    assert client.put(put, json={"noteId": first["id"], "setup": "a"}).status_code == 200
    assert client.get(f"/api/notes/{first['id']}").status_code == 200
    # Stale revision: 409 and nothing deleted.
    stale = client.put(put, json={"noteId": second["id"], "revision": 1})
    assert stale.status_code == 409
    assert client.get(f"/api/notes/{first['id']}").status_code == 200
    # Invalid new link: 422 and nothing deleted.
    assert client.put(put, json={"noteId": "nope"}).status_code == 422
    assert client.get(f"/api/notes/{first['id']}").status_code == 200
    # Switched to another note: the old one is deleted, the new one kept.
    res = client.put(put, json={"noteId": second["id"]})
    assert res.status_code == 200 and res.json()["noteId"] == second["id"]
    assert client.get(f"/api/notes/{first['id']}").status_code == 404
    assert client.get(f"/api/notes/{second['id']}").status_code == 200
    # Cleared: that one is deleted too.
    res = client.put(put, json={})
    assert res.status_code == 200 and res.json()["noteId"] is None
    assert client.get(f"/api/notes/{second['id']}").status_code == 404
    # No note before and after: fine.
    assert client.put(put, json={}).status_code == 200


def test_journal_link_validation(client: TestClient) -> None:
    pid = mk_portfolio(client)["id"]
    other = mk_portfolio(client, name="Other")["id"]
    foreign = post_tx(client, other)
    url = f"/api/portfolios/{pid}/journal"
    assert client.post(url, json={"noteId": "missing"}).status_code == 422
    # A Notes-panel note can't be linked (a journal entry owns and deletes its note).
    panel = mk_note(client, kind="note")
    assert client.post(url, json={"noteId": panel["id"]}).status_code == 422
    assert client.post(url, json={"transactionId": "missing"}).status_code == 422
    assert client.post(url, json={"transactionId": foreign["id"]}).status_code == 422
    e = client.post(url, json={}).json()
    put = f"/api/journal/{e['id']}"
    assert client.put(put, json={"transactionId": foreign["id"]}).status_code == 422
    assert client.put(put, json={"noteId": "missing"}).status_code == 422
    assert client.put(put, json={"noteId": panel["id"]}).status_code == 422
    assert client.get(f"/api/notes/{panel['id']}").status_code == 200
    assert client.post("/api/portfolios/nope/journal", json={}).status_code == 404
    for bad in (
        {"tags": ["x" * 41]},
        {"tags": [str(i) for i in range(21)]},
        {"setup": "x" * 81},
        {"stop": -1},
        {"unknown": 1},
    ):
        assert client.post(url, json=bad).status_code == 422, bad
    assert client.post(url, json={"tags": [str(i) for i in range(20)]}).status_code == 201


def test_tx_delete_nulls_journal_link_and_import_undo_too(client: TestClient) -> None:
    pid = mk_portfolio(client)["id"]
    tx = post_tx(client, pid)
    imp = client.post(
        f"/api/portfolios/{pid}/transactions/import",
        json={"transactions": [buy(externalId="i1")], "source": "import:ibkr"},
    ).json()
    imported_id = next(
        t["id"]
        for t in client.get(f"/api/portfolios/{pid}/transactions").json()
        if t["importBatch"] == imp["batch"]
    )
    url = f"/api/portfolios/{pid}/journal"
    e1 = client.post(url, json={"transactionId": tx["id"]}).json()
    e2 = client.post(url, json={"transactionId": imported_id}).json()
    assert client.delete(f"/api/transactions/{tx['id']}").status_code == 204
    assert client.delete(f"/api/portfolios/{pid}/imports/{imp['batch']}").json() == {"deleted": 1}
    entries = {x["id"]: x for x in client.get(url).json()}
    assert entries[e1["id"]]["transactionId"] is None
    assert entries[e2["id"]]["transactionId"] is None


def test_portfolio_delete_cascades(client: TestClient) -> None:
    pid = mk_portfolio(client)["id"]
    keep = mk_portfolio(client, name="Keep")["id"]
    tx = post_tx(client, pid)
    post_tx(client, keep)
    note = mk_note(client)
    spare = mk_note(client, "MSFT")
    e = client.post(
        f"/api/portfolios/{pid}/journal", json={"transactionId": tx["id"], "noteId": note["id"]}
    ).json()
    res = client.put(
        f"/api/journal/{e['id']}/screenshot", content=PNG, headers={"Content-Type": "image/png"}
    )
    assert res.status_code == 200
    kept_entry = client.post(f"/api/portfolios/{keep}/journal", json={}).json()

    assert client.delete(f"/api/portfolios/{pid}").status_code == 204
    assert client.get(f"/api/journal/{e['id']}/screenshot").status_code == 404
    assert client.put(f"/api/journal/{e['id']}", json={}).status_code == 404
    assert client.put(f"/api/transactions/{tx['id']}", json=buy()).status_code == 404
    assert client.get(f"/api/notes/{note['id']}").status_code == 404
    assert client.get(f"/api/notes/{spare['id']}").status_code == 200
    assert len(client.get(f"/api/portfolios/{keep}/transactions").json()) == 1
    assert [x["id"] for x in client.get(f"/api/portfolios/{keep}/journal").json()] == [
        kept_entry["id"]
    ]
    bundle = client.get("/api/export").json()
    assert [p["id"] for p in bundle["portfolios"]] == [keep]
    assert len(bundle["portfolioTransactions"]) == 1 and len(bundle["journalEntries"]) == 1


# -------------------------------------------------------------- screenshots


def test_screenshot_put_get_delete(client: TestClient) -> None:
    pid = mk_portfolio(client)["id"]
    e = client.post(f"/api/portfolios/{pid}/journal", json={}).json()
    url = f"/api/journal/{e['id']}/screenshot"
    assert client.get(url).status_code == 404
    assert client.delete(url).status_code == 404

    res = client.put(url, content=PNG, headers={"Content-Type": "image/png"})
    assert res.status_code == 200 and res.json()["hasScreenshot"] is True
    assert res.json()["revision"] == 1
    got = client.get(url)
    assert got.status_code == 200 and got.content == PNG
    assert got.headers["content-type"] == "image/png"
    assert got.headers["cache-control"] == "private, max-age=0"
    assert client.get(f"/api/portfolios/{pid}/journal").json()[0]["hasScreenshot"] is True

    # Replace with another type (parameters on the header are accepted).
    res = client.put(url, content=JPEG, headers={"Content-Type": "image/jpeg; charset=binary"})
    assert res.status_code == 200
    assert client.get(url).content == JPEG and client.get(url).headers["content-type"] == (
        "image/jpeg"
    )
    assert client.put(url, content=WEBP, headers={"Content-Type": "image/webp"}).status_code == 200

    assert client.delete(url).status_code == 204
    assert client.get(url).status_code == 404
    assert client.get(f"/api/portfolios/{pid}/journal").json()[0]["hasScreenshot"] is False


def test_screenshot_rejections(client: TestClient) -> None:
    pid = mk_portfolio(client)["id"]
    e = client.post(f"/api/portfolios/{pid}/journal", json={}).json()
    url = f"/api/journal/{e['id']}/screenshot"
    png = {"Content-Type": "image/png"}

    big = PNG + b"\x00" * (5 * 1024 * 1024)
    assert client.put(url, content=big, headers=png).status_code == 413
    ok = PNG + b"\x00" * (5 * 1024 * 1024 - len(PNG))
    assert client.put(url, content=ok, headers=png).status_code == 200

    assert client.put(url, content=PNG, headers={"Content-Type": "image/gif"}).status_code == 415
    assert client.put(url, content=PNG, headers={"Content-Type": "text/plain"}).status_code == 415
    assert client.put(url, content=PNG, headers={"Content-Type": "image/jpeg"}).status_code == 422
    assert client.put(url, content=b"not an image", headers=png).status_code == 422
    assert client.put(url, content=b"", headers=png).status_code == 422
    missing = client.put("/api/journal/nope/screenshot", content=PNG, headers=png)
    assert missing.status_code == 404
    # The stored screenshot survived every rejected upload.
    assert client.get(url).content == ok


# ------------------------------------------------------------------- bundle


def seed(client: TestClient) -> dict[str, Any]:
    p = mk_portfolio(client, baseCurrency="EUR", benchmark=None, costMethod="average")
    pid = p["id"]
    tx = post_tx(client, pid, externalId="e1", note="n")
    client.post(
        f"/api/portfolios/{pid}/transactions/import",
        json={"transactions": [buy(symbol="MSFT", externalId="e2")], "source": "import:ibkr"},
    )
    note = mk_note(client)
    entry = client.post(
        f"/api/portfolios/{pid}/journal",
        json={
            "transactionId": tx["id"],
            "noteId": note["id"],
            "tags": ["t"],
            "stop": 90,
            "setup": "s",
        },
    ).json()
    client.put(
        f"/api/journal/{entry['id']}/screenshot", content=PNG, headers={"Content-Type": "image/png"}
    )
    return {"pid": pid, "tx": tx, "note": note, "entry": entry}


def _stable(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Import resets `revision` / `updatedAt` (like every other imported section)."""
    return [{k: v for k, v in r.items() if k not in ("revision", "updatedAt")} for r in rows]


def snapshot(client: TestClient, pid: str) -> dict[str, Any]:
    entries = client.get(f"/api/portfolios/{pid}/journal").json()
    return {
        "portfolio": _stable([client.get(f"/api/portfolios/{pid}").json()]),
        "txs": _stable(client.get(f"/api/portfolios/{pid}/transactions").json()),
        "entries": _stable(entries),
        "shots": {
            e["id"]: client.get(f"/api/journal/{e['id']}/screenshot").content
            for e in entries
            if e["hasScreenshot"]
        },
        "notes": _stable(client.get("/api/notes", params={"kind": "all"}).json()),
    }


def test_bundle_export_shape_and_replace_round_trip(client: TestClient) -> None:
    ids = seed(client)
    pid = ids["pid"]
    before = snapshot(client, pid)
    bundle = client.get("/api/export").json()
    assert bundle["version"] == 1
    assert len(bundle["portfolios"]) == 1 and len(bundle["portfolioTransactions"]) == 2
    entry = bundle["journalEntries"][0]
    assert entry["screenshot"] == {"mime": "image/png", "data": base64.b64encode(PNG).decode()}
    assert entry["noteId"] == ids["note"]["id"] and entry["transactionId"] == ids["tx"]["id"]
    assert {t["source"] for t in bundle["portfolioTransactions"]} == {"manual", "import:ibkr"}

    # Mutate, then replace-import the exported bundle: everything is back, nothing extra.
    extra = mk_portfolio(client, name="Extra")["id"]
    post_tx(client, extra)
    client.delete(f"/api/portfolios/{pid}")
    res = client.post("/api/import", params={"mode": "replace", "confirm": True}, json=bundle)
    assert res.status_code == 200, res.text
    summary = res.json()
    assert summary["portfolios"] == {"created": 1, "updated": 0, "deleted": 1}
    assert summary["portfolioTransactions"] == {"created": 2, "updated": 0, "deleted": 1}
    assert summary["journalEntries"] == {"created": 1, "updated": 0, "deleted": 0}
    assert [p["id"] for p in client.get("/api/portfolios").json()] == [pid]
    after = snapshot(client, pid)
    assert after == before
    assert after["shots"][ids["entry"]["id"]] == PNG
    assert _stable(client.get("/api/export").json()["journalEntries"]) == _stable(
        bundle["journalEntries"]
    )

    # Merge of the same bundle updates in place (and keeps the screenshot).
    res = client.post("/api/import", json=bundle)
    assert res.json()["portfolios"] == {"created": 0, "updated": 1, "deleted": 0}
    assert res.json()["journalEntries"]["updated"] == 1
    assert snapshot(client, pid)["shots"] == before["shots"]


def test_bundle_replace_portfolios_only_clears_children(client: TestClient) -> None:
    ids = seed(client)
    res = client.post(
        "/api/import",
        params={"mode": "replace", "confirm": True},
        json={"version": 1, "app": "tickerglass", "portfolios": []},
    )
    assert res.status_code == 200
    assert res.json()["portfolios"]["deleted"] == 1
    assert res.json()["portfolioTransactions"]["deleted"] == 2
    assert res.json()["journalEntries"]["deleted"] == 1
    assert client.get("/api/portfolios").json() == []
    # The note belongs to the notes section, which was absent.
    assert client.get(f"/api/notes/{ids['note']['id']}").status_code == 200


def test_bundle_without_portfolio_keys_imports(client: TestClient) -> None:
    ids = seed(client)
    old = {"version": 1, "app": "tickerglass", "notes": [], "watchlists": []}
    res = client.post("/api/import", json=old)
    assert res.status_code == 200
    for key in ("portfolios", "portfolioTransactions", "journalEntries"):
        assert res.json()[key] == {"created": 0, "updated": 0, "deleted": 0}
    # Replace of other sections leaves portfolio data alone.
    res = client.post(
        "/api/import", params={"mode": "replace", "confirm": True}, json={**old, "notes": []}
    )
    assert res.status_code == 200
    assert len(client.get(f"/api/portfolios/{ids['pid']}/transactions").json()) == 2
    # The wiped note is unlinked from its entry, which survives.
    entry = client.get(f"/api/portfolios/{ids['pid']}/journal").json()[0]
    assert entry["noteId"] is None and entry["hasScreenshot"] is True


def test_bundle_dry_run_writes_nothing(client: TestClient) -> None:
    ids = seed(client)
    bundle = client.get("/api/export").json()
    client.delete(f"/api/portfolios/{ids['pid']}")
    res = client.post("/api/import", params={"dryRun": True}, json=bundle)
    assert res.status_code == 200 and res.json()["portfolios"]["created"] == 1
    assert client.get("/api/portfolios").json() == []


def test_bundle_rejects_bad_portfolio_data(client: TestClient) -> None:
    ids = seed(client)
    good = client.get("/api/export").json()
    base = {"version": 1, "app": "tickerglass"}
    tx = good["portfolioTransactions"][0]
    entry = good["journalEntries"][0]
    p = good["portfolios"][0]
    cases: dict[str, dict[str, Any]] = {
        "invalid kind fields": {"portfolioTransactions": [{**tx, "id": "z", "symbol": None}]},
        "dangling portfolio": {"portfolioTransactions": [{**tx, "id": "z", "portfolioId": "no"}]},
        "dup tx id": {"portfolioTransactions": [tx, tx]},
        "dup externalId": {
            "portfolioTransactions": [{**tx, "id": "z1"}, {**tx, "id": "z2"}],
        },
        "externalId used by another row": {
            "portfolioTransactions": [{**tx, "id": "other", "externalId": "e2"}]
        },
        "tx moves portfolios": {
            "portfolios": [{**p, "id": "p2"}],
            "portfolioTransactions": [{**tx, "portfolioId": "p2"}],
        },
        "entry dangling portfolio": {"journalEntries": [{**entry, "portfolioId": "no"}]},
        "entry foreign tx": {
            "portfolios": [{**p, "id": "p2"}],
            "journalEntries": [{**entry, "id": "j2", "portfolioId": "p2"}],
        },
        "bad screenshot": {
            "journalEntries": [{**entry, "screenshot": {"mime": "image/png", "data": "AAAA"}}]
        },
        "bad base64": {
            "journalEntries": [{**entry, "screenshot": {"mime": "image/png", "data": "***"}}]
        },
        "bad id": {"portfolios": [{**p, "id": "has space"}]},
        "dup portfolio": {"portfolios": [p, p]},
    }
    for name, extra in cases.items():
        res = client.post("/api/import", json={**base, **extra})
        assert res.status_code == 422, (name, res.status_code, res.text)
    # Rejected imports changed nothing.
    assert (
        client.get("/api/export").json()["portfolioTransactions"] == good["portfolioTransactions"]
    )
    assert ids["pid"] == good["portfolios"][0]["id"]


def test_bundle_unlinks_missing_note(client: TestClient) -> None:
    seed(client)
    bundle = client.get("/api/export").json()
    bundle["notes"] = []
    res = client.post("/api/import", params={"mode": "replace", "confirm": True}, json=bundle)
    assert res.status_code == 200
    entry = client.get("/api/export").json()["journalEntries"][0]
    assert entry["noteId"] is None


def _bundle_tx(tx: dict[str, Any], **kw: Any) -> dict[str, Any]:
    return {**tx, **kw}


def test_bundle_carries_seq_and_keeps_same_timestamp_order(client: TestClient) -> None:
    pid = mk_portfolio(client)["id"]
    a = post_tx(client, pid)
    b = client.post(
        f"/api/portfolios/{pid}/transactions", json={**buy(), "kind": "sell", "price": 101}
    ).json()
    c = post_tx(client, pid, quantity=7)
    bundle = client.get("/api/export").json()
    assert [(t["id"], t["seq"]) for t in bundle["portfolioTransactions"]] == [
        (a["id"], 1),
        (b["id"], 2),
        (c["id"], 3),
    ]
    # Bundle order is irrelevant when every row carries a seq: (time, seq) decides.
    shuffled = {**bundle, "portfolioTransactions": bundle["portfolioTransactions"][::-1]}
    res = client.post("/api/import", params={"mode": "replace", "confirm": True}, json=shuffled)
    assert res.status_code == 200, res.text
    listed = client.get(f"/api/portfolios/{pid}/transactions").json()
    assert [(t["id"], t["seq"]) for t in listed] == [(a["id"], 1), (b["id"], 2), (c["id"], 3)]
    # Merging into existing data renumbers above the portfolio's current maximum, in order.
    res = client.post("/api/import", json=shuffled)
    assert res.status_code == 200, res.text
    listed = client.get(f"/api/portfolios/{pid}/transactions").json()
    assert [(t["id"], t["seq"]) for t in listed] == [(a["id"], 4), (b["id"], 5), (c["id"], 6)]
    assert post_tx(client, pid)["seq"] == 7


def test_bundle_without_seq_uses_bundle_order(client: TestClient) -> None:
    pid = mk_portfolio(client)["id"]
    txs = [post_tx(client, pid, quantity=q) for q in (1, 2, 3)]
    bundle = client.get("/api/export").json()
    for t in bundle["portfolioTransactions"]:
        del t["seq"]
    order = [txs[2], txs[0], txs[1]]
    by_id = {t["id"]: t for t in bundle["portfolioTransactions"]}
    bundle["portfolioTransactions"] = [by_id[t["id"]] for t in order]
    res = client.post("/api/import", params={"mode": "replace", "confirm": True}, json=bundle)
    assert res.status_code == 200, res.text
    listed = client.get(f"/api/portfolios/{pid}/transactions").json()
    assert [(t["id"], t["seq"]) for t in listed] == [(t["id"], n) for n, t in enumerate(order, 1)]
    # A partly numbered bundle falls back to bundle order too.
    mixed = client.get("/api/export").json()
    mixed["portfolioTransactions"] = mixed["portfolioTransactions"][::-1]
    del mixed["portfolioTransactions"][0]["seq"]
    client.post("/api/import", params={"mode": "replace", "confirm": True}, json=mixed)
    listed = client.get(f"/api/portfolios/{pid}/transactions").json()
    assert [t["id"] for t in listed] == [t["id"] for t in mixed["portfolioTransactions"]]


def test_bundle_rejects_bad_seq(client: TestClient) -> None:
    seed(client)
    good = client.get("/api/export").json()
    tx = good["portfolioTransactions"][0]
    for bad in (0, -1, "x", 2**31):
        res = client.post(
            "/api/import",
            json={
                "version": 1,
                "app": "tickerglass",
                "portfolioTransactions": [{**tx, "seq": bad}],
            },
        )
        assert res.status_code == 422, bad


def test_bundle_import_decodes_each_screenshot_once(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from tickerglass_api.userdata import portfolio as pf

    seed(client)
    bundle = client.get("/api/export").json()
    calls: list[str] = []
    real = base64.b64decode

    def counting(s: Any, *args: Any, **kw: Any) -> bytes:
        calls.append(s)
        return real(s, *args, **kw)

    monkeypatch.setattr(pf.base64, "b64decode", counting)
    res = client.post("/api/import", json=bundle)  # merge: the entry exists with a screenshot
    assert res.status_code == 200, res.text
    assert len(calls) == 1
    calls.clear()
    res = client.post("/api/import", params={"mode": "replace", "confirm": True}, json=bundle)
    assert res.status_code == 200, res.text
    assert len(calls) == 1
