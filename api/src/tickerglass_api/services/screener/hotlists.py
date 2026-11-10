"""Hotlists: ranked top-N views over the stored screener snapshots (docs/screener.md).

A hotlist is a fixed `ScanRequest` per kind (a filter, a sort and one metric to show), run by
`query.run_scan`. Database only; the web panel overlays live prices on the symbols itself.
"""

import re
from dataclasses import dataclass
from datetime import UTC, date, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel
from sqlalchemy.orm import Session

from ...settings import Settings
from .query import run_scan
from .schemas import LIST_ID_PATTERN, ScanRequest

HotlistKind = Literal[
    "gainers",
    "losers",
    "active",
    "unusualVolume",
    "newHighs",
    "newLows",
    "oversold",
    "overbought",
    "gapUp",
    "gapDown",
    "goldenCross",
]
MAX_LIMIT = 50
DEFAULT_LIMIT = 20
_LIST_ID = re.compile(LIST_ID_PATTERN)
CLASSES: tuple[str, ...] = ("stocks", "etfs", "crypto", "commodities")


@dataclass(frozen=True)
class KindSpec:
    #: Field shown as the row's `value` (and the sort key unless `sort` says otherwise).
    value: str
    dir: Literal["asc", "desc"]
    #: `(field, op, value)` rules, ANDed.
    rules: tuple[tuple[str, str, Any], ...] = ()


KINDS: dict[str, KindSpec] = {
    "gainers": KindSpec("chg1d", "desc", (("chg1d", ">", 0),)),
    "losers": KindSpec("chg1d", "asc", (("chg1d", "<", 0),)),
    "active": KindSpec("avgDollarVol30", "desc", (("avgDollarVol30", ">", 0),)),
    "unusualVolume": KindSpec("relVol", "desc", (("relVol", ">=", 2),)),
    "newHighs": KindSpec("pctOffHi52", "desc", (("newHi52", "=", True),)),
    "newLows": KindSpec("pctOffLo52", "asc", (("newLo52", "=", True),)),
    "oversold": KindSpec("rsi14", "asc", (("rsi14", "<", 30),)),
    "overbought": KindSpec("rsi14", "desc", (("rsi14", ">", 70),)),
    "gapUp": KindSpec("gapPct", "desc", (("gapPct", ">", 0),)),
    "gapDown": KindSpec("gapPct", "asc", (("gapPct", "<", 0),)),
    "goldenCross": KindSpec(
        "daysSinceCross", "asc", (("smaCross", "=", "golden"), ("daysSinceCross", "<=", 5))
    ),
}


class HotlistRow(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    symbol: str
    name: str
    value: float | None
    last: float | None
    chg1d: float | None = Field(alias="chg1d")


class HotlistResponse(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    kind: str
    as_of: str | None
    universe: str
    rows: list[HotlistRow]


def parse_universe(raw: str) -> dict[str, str] | None:
    """`stocks` | `etfs` | `crypto` | `commodities` | `list:<id>` as a `ScanRequest` universe,
    None when it is neither (a `list:` id that is not a valid list id included)."""
    if raw in CLASSES:
        return {"kind": "class", "cls": raw}
    if raw.startswith("list:") and _LIST_ID.fullmatch(raw[5:]):
        return {"kind": "list", "id": raw[5:]}
    return None


def build_request(kind: str, universe: dict[str, str], limit: int) -> ScanRequest:
    spec = KINDS[kind]
    fields = list(dict.fromkeys(["last", "chg1d", spec.value]))
    return ScanRequest.model_validate(
        {
            "universe": universe,
            "filter": {
                "op": "and",
                "rules": [{"field": f, "op": op, "value": v} for f, op, v in spec.rules],
            }
            if spec.rules
            else None,
            "sort": {"field": spec.value, "dir": spec.dir},
            "limit": limit,
            "fields": fields,
        }
    )


def _num(value: object) -> float | None:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    return float(value)


def run_hotlist(
    session: Session,
    kind: str,
    universe_raw: str,
    universe: dict[str, str],
    limit: int,
    *,
    settings: Settings,
    now: datetime | None = None,
    target: date | None = None,
) -> HotlistResponse:
    """The top `limit` rows of `kind`. Empty with `asOf: None` while no snapshot run has
    finished. Raises `ScanError` / `UniverseNotFound` like `run_scan`."""
    req = build_request(kind, universe, limit)
    result = run_scan(
        session,
        req,
        settings=settings,
        now=now or datetime.now(UTC),
        fundamentals=False,
        target=target,
    )
    spec = KINDS[kind]
    rows = (
        []
        if result.as_of is None
        else [
            HotlistRow(
                symbol=r.symbol,
                name=r.name,
                value=_num(r.values.get(spec.value)),
                last=_num(r.values.get("last")),
                chg1d=_num(r.values.get("chg1d")),
            )
            for r in result.rows
        ]
    )
    return HotlistResponse(kind=kind, as_of=result.as_of, universe=universe_raw, rows=rows)


__all__ = ["KINDS", "HotlistKind", "HotlistResponse", "parse_universe", "run_hotlist"]
