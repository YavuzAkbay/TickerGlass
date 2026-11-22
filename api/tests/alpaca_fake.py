"""An Alpaca server for tests: a `Send` answering from the hand-built responses in
`tests/fixtures/alpaca/` (documented shapes, not recordings), so nothing touches the network."""

import json
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlsplit

FIXTURES = Path(__file__).parent / "fixtures" / "alpaca"

Answer = tuple[int, dict[str, str], Any]


def record(name: str) -> dict[str, Any]:
    data: dict[str, Any] = json.loads((FIXTURES / f"{name}.json").read_text())
    return data


def body_of(name: str) -> Any:
    return record(name)["body"]


def error(status: int, name: str) -> Answer:
    rec = record(name)
    return status, rec["headers"], rec["body"]


def _bar(t: str, base: float) -> dict[str, Any]:
    return {
        "t": t,
        "o": base,
        "h": base + 2,
        "l": base - 2,
        "c": base + 1,
        "v": 1000,
        "n": 10,
        "vw": base,
    }


def weekly_rows() -> list[dict[str, Any]]:
    """Six weekly bars (Mondays 2026-09-21 .. 2026-10-26, EDT)."""
    days = ["09-21", "09-28", "10-05", "10-12", "10-19", "10-26"]
    return [_bar(f"2026-{d}T04:00:00Z", 330 + i) for i, d in enumerate(days)]


def monthly_rows() -> list[dict[str, Any]]:
    """Ten monthly bars, January to October 2026 (New York midnight: 05:00Z until the March
    change to summer time, 04:00Z after)."""
    return [
        _bar(f"2026-{m:02d}-01T{'05' if m < 3 else '04'}:00:00Z", 100 + m) for m in range(1, 11)
    ]


def quarterly_rows() -> list[dict[str, Any]]:
    return [_bar(f"2026-{m:02d}-01T0{5 if m < 3 else 4}:00:00Z", 100 + m) for m in (1, 4, 7, 10)]


class FakeAlpaca:
    """Callable `Send`. `calls` records (path, params, request headers); `answers` maps a path
    to a function `(params) -> (status, headers, body)` replacing the default route; `limit`
    (limit, remaining) adds the `X-RateLimit-*` headers a real server sends. Both hosts (data
    and trading) are served; `paths()` names the path only."""

    def __init__(self, limit: tuple[int, int] | None = None) -> None:
        self.calls: list[tuple[str, dict[str, str], Mapping[str, str]]] = []
        self.urls: list[str] = []
        self.limit = limit
        self.answers: dict[str, Callable[[dict[str, str]], Answer]] = {}

    def paths(self) -> list[str]:
        return [path for path, _, _ in self.calls]

    def __call__(
        self, url: str, headers: Mapping[str, str], timeout: float
    ) -> tuple[int, Mapping[str, str], bytes]:
        parts = urlsplit(url)
        params = dict(parse_qsl(parts.query))
        self.urls.append(url)
        self.calls.append((parts.path, params, dict(headers)))
        handler = self.answers.get(parts.path)
        if handler is not None:
            status, head, body = handler(params)
        else:
            status, head, body = self.route(parts.path, params)
        head = {k: v for k, v in head.items() if not k.startswith("x-ratelimit")}
        if self.limit is not None:
            head["x-ratelimit-limit"], head["x-ratelimit-remaining"] = map(str, self.limit)
        return status, head, json.dumps(body).encode()

    # -- default route ------------------------------------------------------------------

    def route(self, path: str, params: dict[str, str]) -> Answer:
        if path == "/v2/stocks/bars" or path.endswith("/crypto/us/bars"):
            return self._bars(params)
        if path == "/v2/stocks/snapshots":
            return self._snapshots("snapshots_stocks", params)
        if path.endswith("/crypto/us/snapshots"):
            return self._snapshots("snapshots_crypto", params)
        if path == "/v2/assets":
            name = "assets_crypto" if params.get("asset_class") == "crypto" else "assets_us_equity"
            return 200, {}, body_of(name)
        return 404, {}, {"message": f"unknown endpoint {path}"}

    @staticmethod
    def _bars(params: dict[str, str]) -> Answer:
        symbol, timeframe = params["symbols"], params["timeframe"]
        known = {"AAPL", "BRK.B", "BTC/USD"}
        if symbol not in known:
            return 200, {}, {"bars": None, "next_page_token": None}
        if timeframe == "1Day":
            rows = list(body_of("bars_1day_aapl")["bars"]["AAPL"])
            if params.get("adjustment") == "all":  # dividend-adjusted: a little lower
                rows = [{**r, "c": round(r["c"] * 0.99, 4)} for r in rows]
        elif timeframe == "1Week":
            rows = weekly_rows()
        elif timeframe == "1Month":
            rows = monthly_rows()
        elif timeframe == "3Month":
            rows = quarterly_rows()
        else:  # every intraday frame is served from the one-minute rows
            rows = list(body_of("bars_1min_aapl")["bars"]["AAPL"])
        start, end = params.get("start", ""), params.get("end", "9999")
        rows = [r for r in rows if start <= r["t"] < end]
        if params.get("sort") == "desc":
            rows.reverse()
        return 200, {}, {"bars": {symbol: rows} if rows else {}, "next_page_token": None}

    @staticmethod
    def _snapshots(name: str, params: dict[str, str]) -> Answer:
        body = body_of(name)
        wrapped = "snapshots" in body
        entries = body["snapshots"] if wrapped else body
        found = {s: entries[s] for s in params["symbols"].split(",") if s in entries}
        return 200, {}, {"snapshots": found} if wrapped else found
