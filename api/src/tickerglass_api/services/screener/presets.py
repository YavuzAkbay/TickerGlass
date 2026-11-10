"""Built-in screens offered by `GET /api/screener/presets` (docs/design/server-screener.md §4).

Each `spec` is a valid `ScreenSpec` (JSON form): the stock universe, one filter group and a
sort. They are templates only: the client saves a copy as a screen to keep or alert on it.
"""

from typing import Any


def _spec(rules: list[dict[str, Any]], sort_field: str, sort_dir: str) -> dict[str, Any]:
    return {
        "schemaVersion": 1,
        "universe": {"kind": "class", "cls": "stocks"},
        "filter": {"op": "and", "rules": rules},
        "sort": {"field": sort_field, "dir": sort_dir},
    }


PRESETS: list[dict[str, Any]] = [
    {
        "id": "oversold-large-caps",
        "name": "Oversold large caps",
        "spec": _spec(
            [
                {"field": "rsi14", "op": "<", "value": 30},
                {"field": "mcap", "op": ">", "value": 10e9},
            ],
            "rsi14",
            "asc",
        ),
    },
    {
        "id": "golden-cross-5d",
        "name": "Golden cross in the last 5 days",
        "spec": _spec(
            [
                {"field": "smaCross", "op": "=", "value": "golden"},
                {"field": "daysSinceCross", "op": "<=", "value": 5},
            ],
            "daysSinceCross",
            "asc",
        ),
    },
    {
        "id": "new-52w-highs",
        "name": "New 52-week highs",
        "spec": _spec([{"field": "newHi52", "op": "=", "value": True}], "mcap", "desc"),
    },
    {
        "id": "unusual-volume",
        "name": "Unusual volume",
        "spec": _spec([{"field": "relVol", "op": ">", "value": 2}], "relVol", "desc"),
    },
    {
        "id": "above-sma200-near-high",
        "name": "Above SMA 200, near the 52-week high",
        "spec": _spec(
            [
                {"field": "pctVsSma200", "op": ">", "value": 0},
                {"field": "pctOffHi52", "op": ">", "value": -5},
            ],
            "pctOffHi52",
            "desc",
        ),
    },
    {
        "id": "high-dividend",
        "name": "High dividend yield",
        "spec": _spec([{"field": "divYield", "op": ">", "value": 4}], "divYield", "desc"),
    },
]
