"""Record real Twelve Data responses as test fixtures.

Run from `api/`: `uv run python scripts/record_twelvedata.py`.

Reads TWELVEDATA_API_KEY from the repository's root `.env` (or the environment), calls a fixed
schedule of endpoints within a Basic plan's budget (8 credits per rolling minute, 800 per day) and
writes `tests/fixtures/twelvedata/<name>.json` as
`{"request": {path, params}, "status", "headers": {credit headers only}, "body"}`.
The key is sent in the `Authorization: apikey <key>` header, never in the URL, is scrubbed from
every saved file (the script asserts it is absent) and is never printed. Stdlib only.
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "api" / "tests" / "fixtures" / "twelvedata"
BASE_URL = "https://api.twelvedata.com"
PER_MINUTE = 8
MINUTE_GAP_S = 65
KEPT_HEADERS = ("api-credits-used", "api-credits-left", "content-type", "retry-after")
TRIM_ROWS = 300


def load_key() -> str:
    key = os.environ.get("TWELVEDATA_API_KEY", "").strip()
    env_file = ROOT / ".env"
    if not key and env_file.exists():
        for line in env_file.read_text().splitlines():
            name, sep, value = line.strip().partition("=")
            if sep and name.strip() == "TWELVEDATA_API_KEY":
                key = value.strip().strip("'\"")
    if not key:
        sys.exit("TWELVEDATA_API_KEY is not set (root .env or environment)")
    return key


class Recorder:
    def __init__(self, key: str) -> None:
        self.key = key
        self.left: int | None = None
        self.spent = 0
        self.unexpected: list[str] = []
        self.rows: list[tuple[str, int, str, str, int]] = []

    def scrub(self, text: str) -> str:
        return text.replace(self.key, "<REDACTED>")

    def call(
        self,
        name: str,
        path: str,
        params: dict[str, str],
        *,
        est: int = 1,
        expect: tuple[int, ...] = (200,),
        auth: str | None = None,
        save: bool = True,
    ) -> dict[str, Any]:
        if self.left is not None and self.left < est:
            print(f"  (credits left {self.left} < {est}: waiting for a new minute)", flush=True)
            time.sleep(MINUTE_GAP_S)
            self.left = None
        # An explicit `auth` is only for deliberate invalid-credential probes.
        header = auth if auth is not None else f"apikey {self.key}"
        url = f"{BASE_URL}{path}?{urllib.parse.urlencode(params)}"
        request = urllib.request.Request(
            url, headers={"Authorization": header, "User-Agent": "tickerglass-recorder/1.0"}
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                status, raw, headers = response.status, response.read(), response.headers
        except urllib.error.HTTPError as error:
            status, raw, headers = error.code, error.read(), error.headers
        text = raw.decode("utf-8", errors="replace")
        try:
            body: Any = json.loads(text)
        except ValueError:
            body = {"_raw": text}
        kept = {k: headers[k] for k in KEPT_HEADERS if headers.get(k) is not None}
        used, left = kept.get("api-credits-used", "?"), kept.get("api-credits-left", "?")
        if left.isdigit():
            self.left = int(left)
        if used.isdigit():
            self.spent += int(used)
        fixture = {
            "request": {"path": path, "params": params},
            "status": status,
            "headers": kept,
            "body": body,
        }
        if save:
            self.write(name, fixture)
        flag = "" if status in expect else "  UNEXPECTED"
        print(f"{name}: HTTP {status} used={used} left={left}{flag}", flush=True)
        self.rows.append((name, status, used, left, len(text)))
        if status not in expect:
            self.unexpected.append(name)
        if status == 401 and auth is None:
            sys.exit(f"401 for {name}: Authorization header rejected; stopping (no fallback).")
        return fixture

    def write(self, name: str, fixture: dict[str, Any]) -> None:
        text = self.scrub(json.dumps(fixture, indent=2, ensure_ascii=False)) + "\n"
        assert self.key not in text, f"key present in {name}"
        FIXTURES.mkdir(parents=True, exist_ok=True)
        (FIXTURES / f"{name}.json").write_text(text)


def minute_pause(label: str) -> None:
    print(f"--- waiting {MINUTE_GAP_S}s before {label}", flush=True)
    time.sleep(MINUTE_GAP_S)


def record_minute_1(rec: Recorder) -> None:
    rec.call("api_usage_start", "/api_usage", {})
    daily = {"interval": "1day", "outputsize": "5"}
    rec.call("time_series_1day_aapl", "/time_series", {"symbol": "AAPL", **daily})
    rec.call(
        "time_series_1week_aapl",
        "/time_series",
        {"symbol": "AAPL", "interval": "1week", "outputsize": "5"},
    )
    page = rec.call(
        "time_series_1min_aapl",
        "/time_series",
        {"symbol": "AAPL", "interval": "1min", "outputsize": "5000", "order": "desc"},
        save=False,
    )
    save_paged_minutes(rec, page)
    rec.call("symbol_search_aapl", "/symbol_search", {"symbol": "AAPL", "outputsize": "5"})
    rec.call("symbol_search_brk", "/symbol_search", {"symbol": "BRK", "outputsize": "10"})
    rec.call(
        "time_series_notfound",
        "/time_series",
        {"symbol": "ZZZZNOTREAL", "interval": "1day", "outputsize": "5"},
        expect=(200, 400, 404),
    )
    rec.call(
        "time_series_bad_interval",
        "/time_series",
        {"symbol": "AAPL", "interval": "7min", "outputsize": "5"},
        expect=(400,),
    )


def save_paged_minutes(rec: Recorder, page: dict[str, Any]) -> None:
    """Save the 1min fixture trimmed to TRIM_ROWS and a synthetic page 2 built from older rows."""
    body = page["body"]
    values = body.get("values") if isinstance(body, dict) else None
    if not isinstance(values, list):
        rec.write("time_series_1min_aapl", page)
        return
    total = len(values)
    first = {**page, "body": {**body, "values": values[:TRIM_ROWS]}}
    first["_trimmed"] = {"original_rows": total, "kept_rows": min(total, TRIM_ROWS)}
    rec.write("time_series_1min_aapl", first)
    older = values[TRIM_ROWS : 2 * TRIM_ROWS]
    if older:
        second = {
            "_synthetic": True,
            "_note": (
                f"Not a real response: rows {TRIM_ROWS}-{TRIM_ROWS + len(older) - 1} of the "
                "outputsize=5000 page, shaped as the page a client gets when it repeats the "
                "request with end_date set to the oldest datetime of page 1."
            ),
            "request": {
                "path": page["request"]["path"],
                "params": {
                    **page["request"]["params"],
                    "end_date": values[TRIM_ROWS - 1]["datetime"],
                },
            },
            "status": 200,
            "headers": page["headers"],
            "body": {**body, "values": older},
        }
        rec.write("time_series_1min_aapl_page2_synthetic", second)
    print(f"  1min rows returned: {total}", flush=True)


def record_minute_2(rec: Recorder) -> None:
    rec.call(
        "quote_batch",
        "/quote",
        {"symbol": "AAPL,MSFT,VOD:LSE,ZZZZNOTREAL"},
        est=4,
    )
    rec.call("quote_aapl", "/quote", {"symbol": "AAPL"})
    rec.call(
        "time_series_vod_exchange",
        "/time_series",
        {"symbol": "VOD", "exchange": "LSE", "interval": "1day", "outputsize": "3"},
        expect=(200, 400, 403, 404),
    )
    rec.call(
        "time_series_brkb",
        "/time_series",
        {"symbol": "BRK.B", "interval": "1day", "outputsize": "2"},
        expect=(200, 400, 404),
    )


def record_minute_3(rec: Recorder) -> None:
    gated = (200, 400, 403)
    rec.call("dividends_aapl", "/dividends", {"symbol": "AAPL"}, est=8, expect=gated)
    rec.call("profile_aapl", "/profile", {"symbol": "AAPL"}, est=8, expect=gated)
    # Deliberately invalid credential (not the real key) to record the 401 shape.
    rec.call(
        "error_401",
        "/time_series",
        {"symbol": "AAPL", "interval": "1day", "outputsize": "1"},
        expect=(401,),
        auth="apikey invalid-key-for-fixture",
    )


def record_minute_4(rec: Recorder) -> None:
    """Ask for more credits than a minute allows (9 symbols vs 8) to record a real 429."""
    symbols = "AAPL,MSFT,GOOG,AMZN,META,NVDA,TSLA,IBM,KO"
    rec.call("error_429", "/quote", {"symbol": symbols}, est=PER_MINUTE, expect=(200, 429))
    rec.call("api_usage_after_429", "/api_usage", {}, est=1, expect=(200, 429))


def record_extras(rec: Recorder) -> None:
    """Event endpoints used by the provider's `events` capability (run with `--extras`)."""
    ok = (200, 400, 403, 404)
    rec.call("splits_aapl", "/splits", {"symbol": "AAPL", "range": "last"}, est=4, expect=ok)
    rec.call("earnings_aapl", "/earnings", {"symbol": "AAPL", "outputsize": "2"}, est=4, expect=ok)


def main() -> None:
    rec = Recorder(load_key())
    if "--extras" in sys.argv:
        record_extras(rec)
        return
    print("minute 1", flush=True)
    record_minute_1(rec)
    minute_pause("minute 2")
    rec.left = None
    record_minute_2(rec)
    minute_pause("minute 3")
    rec.left = None
    record_minute_3(rec)
    if rec.unexpected:
        print(f"skipping minute 4, unexpected results: {rec.unexpected}")
    else:
        minute_pause("minute 4 (forced 429)")
        rec.left = None
        record_minute_4(rec)
    minute_pause("final /api_usage")
    rec.left = None
    rec.call("api_usage_end", "/api_usage", {})
    print(f"credits spent (sum of api-credits-used headers, per-minute counters): {rec.spent}")
    print(f"unexpected: {rec.unexpected or 'none'}")


if __name__ == "__main__":
    main()
