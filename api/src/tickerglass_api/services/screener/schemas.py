"""Wire models of the screener API (docs/design/server-screener.md §4, frozen).

JSON is camelCase (`alias_generator`), Python attributes snake_case; models accept both
(`populate_by_name`) and routes serialize by alias. Structural limits that need a path in the
error (rule depth, rule count, unknown fields or operators) are checked by `query.py`, which
raises `ScanError`; the models only guarantee shapes.
"""

from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Discriminator, Field, Tag, field_validator
from pydantic.alias_generators import to_camel

from .universe import SYMBOL_RE

ScreenerClass = Literal["stocks", "etfs", "crypto", "commodities"]
Category = Literal["meta", "price", "performance", "technical", "volume", "fundamental"]
FieldType = Literal["number", "percent", "money", "int", "bool", "enum", "date", "string"]

MAX_SYMBOLS = 1000
MAX_RULES = 50
MAX_DEPTH = 2
MAX_LIMIT = 500
DEFAULT_LIMIT = 100
MAX_FIELDS = 60
LIST_ID_PATTERN = r"^[A-Za-z0-9_-]{1,36}$"
ID_PATTERN = r"^[A-Za-z0-9_.:-]{1,36}$"

Scalar = bool | int | float | str | None


class Camel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class StrictCamel(Camel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")


# ---------------------------------------------------------------- universe


class ClassUniverse(StrictCamel):
    kind: Literal["class"]
    cls: ScreenerClass


class ListUniverse(StrictCamel):
    kind: Literal["list"]
    id: str = Field(pattern=LIST_ID_PATTERN)


class WatchlistUniverse(StrictCamel):
    kind: Literal["watchlist"]
    id: str = Field(pattern=ID_PATTERN)


class SymbolsUniverse(StrictCamel):
    kind: Literal["symbols"]
    symbols: list[str] = Field(max_length=MAX_SYMBOLS)

    @field_validator("symbols")
    @classmethod
    def _clean(cls, value: list[str]) -> list[str]:
        out: list[str] = []
        for raw in value:
            sym = raw.strip().upper()
            if not SYMBOL_RE.match(sym):
                raise ValueError(f"invalid symbol: {raw!r}")
            out.append(sym)
        return list(dict.fromkeys(out))


Universe = Annotated[
    ClassUniverse | ListUniverse | WatchlistUniverse | SymbolsUniverse, Field(discriminator="kind")
]


# ------------------------------------------------------------------ filter


class Rule(StrictCamel):
    """`op` and `field` are plain strings here: `query.py` checks them against the field
    registry and reports `unknown_field` / `bad_op` / `bad_value` with a path. `value` is a
    number, `{field}`, `[lo, hi]`, a string list, a boolean or `{field, pct}`."""

    field: str = Field(max_length=64)
    op: str = Field(max_length=64)
    value: Any = None


class FormulaRule(StrictCamel):
    """`{formula, op, value}` (design §10): an arithmetic expression over numeric fields
    compared with a number (`>`, `<`, `>=`, `<=`) or a `[lo, hi]` range (`between`).
    `query.py`/`formula.py` parse and check it (codes bad_formula, unknown_field,
    field_unavailable, too_complex with a character `offset`)."""

    #: Generous shape bound; the 200-character limit is reported as `too_complex`.
    formula: str = Field(max_length=2000)
    op: str = Field(max_length=64)
    value: Any = None


def _node_kind(value: Any) -> str:
    """Discriminates a filter node: a group has `rules`, a formula rule `formula`."""
    if isinstance(value, dict):
        if "rules" in value:
            return "group"
        return "formula" if "formula" in value else "rule"
    if isinstance(value, Group):
        return "group"
    return "formula" if isinstance(value, FormulaRule) else "rule"


Node = Annotated[
    Annotated[Rule, Tag("rule")]
    | Annotated["FormulaRule", Tag("formula")]
    | Annotated["Group", Tag("group")],
    Discriminator(_node_kind),
]


class Group(StrictCamel):
    op: Literal["and", "or"]
    rules: list[Node]


class Sort(StrictCamel):
    field: str = Field(max_length=64)
    dir: Literal["asc", "desc"] = "desc"


class ScanRequest(StrictCamel):
    universe: Universe
    filter: Group | None = None
    sort: Sort = Sort(field="avgDollarVol30", dir="desc")
    limit: int = Field(default=DEFAULT_LIMIT, ge=1, le=MAX_LIMIT)
    offset: int = Field(default=0, ge=0)
    fields: list[str] | None = Field(default=None, max_length=MAX_FIELDS)


# ---------------------------------------------------------------- response


class Coverage(Camel):
    universe: int
    with_snapshot: int


class ScanRow(Camel):
    symbol: str
    name: str
    cls: str
    group: str
    exchange: str | None
    stale: bool
    values: dict[str, Scalar]


class ScanResponse(Camel):
    as_of: str | None
    computed_at: str | None
    provider: str
    total: int
    offset: int
    limit: int
    coverage: Coverage
    rows: list[ScanRow]


# ------------------------------------------------------------------ fields


class FieldDef(Camel):
    id: str
    category: Category
    type: FieldType
    unit: str | None
    dimension: str
    ops: list[str]
    crossable: bool
    available: bool
    enum_values: list[str] | None


class FieldsResponse(Camel):
    version: Literal[1] = 1
    fields: list[FieldDef]


# ------------------------------------------------------------------ status


class StatusCoverage(Camel):
    tracked: int
    fresh: int
    stale: int
    failed: int
    tombstoned: int


class StatusRunning(Camel):
    run_id: int
    kind: str
    done: int
    total: int
    started_at: str | None
    eta_s: float | None


class StatusBudget(Camel):
    rate_per_min: float
    tokens_last_run: int | None


class StatusResponse(Camel):
    enabled: bool
    supported: bool
    #: disabled | provider_unsupported | first_run | null
    reason: str | None
    provider: str
    as_of: str | None
    computed_at: str | None
    fundamentals_as_of: str | None
    coverage: StatusCoverage
    running: StatusRunning | None
    next_run_at: str | None
    budget: StatusBudget
    bars_rows: int


class RunRequest(StrictCamel):
    kind: Literal["snapshot", "fundamentals"] = "snapshot"


class RunResponse(Camel):
    run_id: int


class SnapshotResponse(Camel):
    as_of: str | None
    rows: dict[str, dict[str, Scalar]]


class ListSummary(Camel):
    id: str
    name: str
    kind: str
    as_of: str
    source: str
    count: int


class ListPut(StrictCamel):
    name: str
    as_of: str
    symbols: list[str]


Group.model_rebuild()
