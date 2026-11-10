"""Registry of the screener's fields (ids frozen in docs/design/server-screener.md §4).

Each `FieldSpec` binds a field id to its SQL column (a whitelist: the scan SQL only ever
contains columns from here), its comparison `dimension` (a `{field}` operand must share it),
the operators it accepts and, for crossable fields, the column holding the previous session's
value. Fundamental fields come from `screener_fundamentals` and are unavailable when the
active provider cannot serve them (`provider_has_screen_info`).
"""

import math
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from sqlalchemy import BigInteger, ColumnElement, bindparam, case

from ...models import ScreenerFundamental, ScreenerSnapshot, ScreenerSymbol
from .schemas import Category, FieldDef, FieldType

_snap = ScreenerSnapshot.__table__.c
_fund = ScreenerFundamental.__table__.c
_sym = ScreenerSymbol.__table__.c

#: Name of the bound parameter `run_scan` sets to the current unix time (`daysToEarnings`).
NOW_PARAM = "now_ts"

CMP = (">", "<", ">=", "<=")
CROSS = ("crossesAbove", "crossesBelow")
PCT = ("abovePct", "belowPct")
CROSS_STATES = {"golden": 1, "death": -1}
CLASSES = ("stocks", "etfs", "crypto", "commodities")

Output = Callable[[Any], Any]


@dataclass(frozen=True)
class FieldSpec:
    id: str
    category: Category
    type: FieldType
    unit: str | None
    dimension: str
    ops: tuple[str, ...]
    column: ColumnElement[Any]
    prev_column: ColumnElement[Any] | None = None
    #: Allowed values of an enum field, as the API spells them.
    enum_values: tuple[str, ...] | None = None
    #: API spelling -> stored value, for an enum stored as a number.
    codes: dict[str, int] | None = None
    #: Comes from `screener_fundamentals` (needs a provider with `screen_fields`/`info`).
    fundamental: bool = False
    #: Converts a stored value for the response.
    output: Output | None = None

    @property
    def crossable(self) -> bool:
        return self.prev_column is not None

    @property
    def numeric(self) -> bool:
        return self.type in ("number", "percent", "money", "int", "date")

    def definition(self, *, fundamentals: bool) -> FieldDef:
        return FieldDef(
            id=self.id,
            category=self.category,
            type=self.type,
            unit=self.unit,
            dimension=self.dimension,
            ops=list(self.ops),
            crossable=self.crossable,
            available=fundamentals or not self.fundamental,
            enum_values=list(self.enum_values) if self.enum_values else None,
        )


def _finite(value: Any) -> Any:
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value


def _cross_name(value: Any) -> str | None:
    return {1: "golden", -1: "death"}.get(value) if value is not None else None


def _build() -> dict[str, FieldSpec]:
    out: dict[str, FieldSpec] = {}

    def add(spec: FieldSpec) -> None:
        out[spec.id] = spec

    def meta(fid: str, col: ColumnElement[Any], values: tuple[str, ...] | None = None) -> None:
        add(
            FieldSpec(
                fid,
                "meta",
                "enum" if values else "string",
                None,
                "string",
                ("=", "in"),
                col,
                enum_values=values,
            )
        )

    def num(
        fid: str,
        category: Category,
        ftype: FieldType,
        dimension: str,
        col: ColumnElement[Any],
        *,
        unit: str | None = None,
        prev: ColumnElement[Any] | None = None,
        extra: tuple[str, ...] = (),
        fundamental: bool = False,
        output: Output | None = None,
    ) -> None:
        ops = CMP + ("between",) + extra + (CROSS if prev is not None else ())
        add(
            FieldSpec(
                fid,
                category,
                ftype,
                unit,
                dimension,
                ops,
                col,
                prev,
                fundamental=fundamental,
                output=output,
            )
        )

    def flag(fid: str, col: ColumnElement[Any]) -> None:
        add(FieldSpec(fid, "price", "bool", None, "bool", ("=",), col))

    meta("name", _sym.name)
    meta("cls", _sym.cls, CLASSES)
    meta("group", _sym.grp)
    meta("exchange", _sym.exchange)

    P = "price"
    PCTCH = "percent-change"
    num("last", "price", "number", P, _snap.last, extra=PCT, prev=_snap.prev_last)
    num("chg1d", "price", "percent", PCTCH, _snap.chg1d_pct, unit="%")
    num("gapPct", "price", "percent", PCTCH, _snap.gap_pct, unit="%")
    num("volume", "volume", "number", "volume", _snap.volume, extra=PCT)
    num("avgVol30", "volume", "number", "volume", _snap.avg_vol30, extra=PCT)
    num("relVol", "volume", "number", "ratio", _snap.rel_vol)
    num(
        "avgDollarVol30",
        "volume",
        "money",
        "money",
        _snap.avg_dollar_vol30,
        unit="ccy",  # close * volume in each symbol's own quote currency, not converted
        extra=PCT,
    )
    for fid, col in (
        ("perf1w", _snap.perf_1w),
        ("perf1m", _snap.perf_1m),
        ("perf3m", _snap.perf_3m),
        ("perf6m", _snap.perf_6m),
        ("perfYtd", _snap.perf_ytd),
        ("perf1y", _snap.perf_1y),
    ):
        num(fid, "performance", "percent", PCTCH, col, unit="%")
    num("rsi14", "technical", "number", "oscillator", _snap.rsi14, prev=_snap.prev_rsi14)
    num("sma20", "technical", "number", P, _snap.sma20, extra=PCT, prev=_snap.prev_sma20)
    num("sma50", "technical", "number", P, _snap.sma50, extra=PCT, prev=_snap.prev_sma50)
    num("sma200", "technical", "number", P, _snap.sma200, extra=PCT, prev=_snap.prev_sma200)
    num("pctVsSma20", "technical", "percent", PCTCH, _snap.pct_vs_sma20, unit="%")
    num("pctVsSma50", "technical", "percent", PCTCH, _snap.pct_vs_sma50, unit="%")
    num("pctVsSma200", "technical", "percent", PCTCH, _snap.pct_vs_sma200, unit="%")
    num("hi52", "price", "number", P, _snap.hi52, extra=PCT)
    num("lo52", "price", "number", P, _snap.lo52, extra=PCT)
    num("pctOffHi52", "price", "percent", PCTCH, _snap.pct_off_hi52, unit="%")
    num("pctOffLo52", "price", "percent", PCTCH, _snap.pct_off_lo52, unit="%")
    flag("newHi52", _snap.new_hi52)
    flag("newLo52", _snap.new_lo52)
    num("atr14", "technical", "number", P, _snap.atr14, extra=PCT)
    num("atrPct", "technical", "percent", PCTCH, _snap.atr_pct, unit="%")
    add(
        FieldSpec(
            "smaCross",
            "technical",
            "enum",
            None,
            "enum",
            ("=", "in"),
            _snap.cross_state,
            enum_values=tuple(CROSS_STATES),
            codes=CROSS_STATES,
            output=_cross_name,
        )
    )
    add(
        FieldSpec(
            "daysSinceCross",
            "technical",
            "int",
            "days",
            "int",
            CMP + ("between", "="),
            _snap.days_since_cross,
        )
    )

    num(
        "mcap", "fundamental", "money", "money", _fund.mcap, unit="USD", extra=PCT, fundamental=True
    )
    num("pe", "fundamental", "number", "ratio", _fund.pe, fundamental=True)
    num("fwdPe", "fundamental", "number", "ratio", _fund.fwd_pe, fundamental=True)
    num("eps", "fundamental", "number", "eps", _fund.eps_ttm, fundamental=True)
    num(
        "divYield", "fundamental", "percent", PCTCH, _fund.div_yield_pct, unit="%", fundamental=True
    )
    num("beta", "fundamental", "number", "ratio", _fund.beta, fundamental=True)
    for fid, col in (("sector", _fund.sector), ("industry", _fund.industry)):
        add(
            FieldSpec(
                fid,
                "fundamental",
                "string",
                None,
                "string",
                ("=", "in"),
                col,
                fundamental=True,
            )
        )
    num(
        "nextEarnings",
        "fundamental",
        "date",
        "date",
        _fund.next_earnings_ts,
        unit="unix_s",
        fundamental=True,
    )
    # Whole days, floored, computed in integer SQL (identical on SQLite and PostgreSQL, whose
    # integer `/` truncates toward zero, hence the CASE for the negative side): 7.5 days -> 7,
    # -0.5 days -> -1. So `= 7` matches exactly what the response shows.
    until = _fund.next_earnings_ts - bindparam(NOW_PARAM, type_=BigInteger)
    days_to = case((until >= 0, until // 86400), else_=-((-until + 86399) // 86400))
    add(
        FieldSpec(
            "daysToEarnings",
            "fundamental",
            "int",
            "days",
            "int",
            CMP + ("between", "="),
            days_to,
            fundamental=True,
        )
    )
    return out


FIELDS: dict[str, FieldSpec] = _build()
#: Default columns of a scan that names no `fields`.
DEFAULT_FIELDS = (
    "last",
    "chg1d",
    "volume",
    "relVol",
    "mcap",
    "pe",
    "perf1m",
    "perfYtd",
    "rsi14",
    "pctVsSma200",
    "pctOffHi52",
    "sector",
)


def convert(spec: FieldSpec, value: Any) -> Any:
    """A stored value as the API returns it (NaN/inf -> null, enum codes -> names)."""
    value = _finite(value)
    if value is None:
        return None
    return spec.output(value) if spec.output is not None else value


def provider_has_screen_info(provider: object) -> bool:
    """True if the (unwrapped) provider offers the optional `ScreenInfoProvider` capability
    (`screen_fields` and `info`): Yahoo and demo do, Twelve Data does not."""
    return callable(getattr(provider, "screen_fields", None)) and callable(
        getattr(provider, "info", None)
    )


def definitions(*, fundamentals: bool) -> list[FieldDef]:
    return [f.definition(fundamentals=fundamentals) for f in FIELDS.values()]
