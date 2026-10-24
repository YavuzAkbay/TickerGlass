"""Golden cases for the financials group: src/builtins/groups/financials.ts.

All cases run on the daily series with the shared statements fixture
(`fund-fin.json`, written next to the CSVs by golden.py): 24 quarters ending
2024-09-30 plus 7 annual periods ending 2023-12-31, with simple linear line
items so every reference below is plain numpy.

References are the definitions' documented semantics: a bar shows the value
of the last period that ended at or before it; TTM sums each quarter with the
three before it; growth divides by the same quarter one year earlier.
"""

from __future__ import annotations

import datetime as dt
import json

import numpy as np

from golden_common import DAILY, Cases, nans

FUND_FILE = "fund-fin.json"


def quarter_end(y: int, q: int) -> dt.date:
    """Calendar end of year `y` quarter `q` (1..4)."""
    first_of_next = dt.date(y, 3 * q + 1, 1) if q < 4 else dt.date(y + 1, 1, 1)
    return first_of_next - dt.timedelta(days=1)


def quarter_ends(last: tuple[int, int], count: int) -> list[dt.date]:
    y, q = last
    out = []
    for _ in range(count):
        out.append(quarter_end(y, q))
        q -= 1
        if q == 0:
            y, q = y - 1, 4
    return list(reversed(out))


# 24 quarterly periods ending 2024-09-30, and 7 annual periods ending 2023-12-31.
Q_DATES = quarter_ends((2024, 3), 24)
A_DATES = [dt.date(y, 12, 31) for y in range(2017, 2024)]
K = np.arange(24, dtype=np.float64)
Y = np.arange(7, dtype=np.float64)

QUARTERLY = {
    "income": {
        "periods": Q_DATES,
        "rows": {
            "Total Revenue": 1000.0 * (K + 1),
            "Gross Profit": 400.0 * (K + 1),
            "Operating Income": 200.0 * (K + 1),
            "Net Income": 100.0 * (K + 1),
            "Diluted EPS": (K + 1),
            "Diluted Average Shares": np.full(24, 100.0),
        },
    },
    "balance": {
        "periods": Q_DATES,
        "rows": {
            "Current Assets": 1000.0 + 100.0 * K,
            "Cash And Cash Equivalents": 500.0 + 50.0 * K,
            "Current Liabilities": 500.0 + 50.0 * K,
            "Total Debt": 2000.0 + 100.0 * K,
            "Stockholders Equity": 5000.0 + np.cumsum(100.0 * (K + 1)),
            "Ordinary Shares Number": np.full(24, 100.0),
        },
    },
    "cashflow": {
        "periods": Q_DATES,
        "rows": {
            "Operating Cash Flow": 120.0 * (K + 1),
            "Capital Expenditure": -50.0 * (K + 1),
        },
    },
}

ANNUAL = {
    "income": {
        "periods": A_DATES,
        "rows": {
            "Total Revenue": 4000.0 * (Y + 1),
            "Gross Profit": 1600.0 * (Y + 1),
            "Operating Income": 800.0 * (Y + 1),
            "Net Income": 400.0 * (Y + 1),
            "Diluted EPS": 4.0 * (Y + 1),
            "Diluted Average Shares": np.full(7, 100.0),
        },
    },
    "balance": {
        "periods": A_DATES,
        "rows": {
            "Current Assets": 1000.0 + 1000.0 * Y,
            "Cash And Cash Equivalents": 500.0 + 500.0 * Y,
            "Current Liabilities": 500.0 + 500.0 * Y,
            "Total Debt": 2000.0 + 1000.0 * Y,
            "Stockholders Equity": 5000.0 + np.cumsum(400.0 * (Y + 1)),
            "Ordinary Shares Number": np.full(7, 100.0),
        },
    },
    "cashflow": {
        "periods": A_DATES,
        "rows": {
            "Operating Cash Flow": 480.0 * (Y + 1),
            "Capital Expenditure": -200.0 * (Y + 1),
        },
    },
}


def jsonable(statements: dict) -> dict:
    def stmt(s: dict) -> dict:
        return {
            "periods": [d.isoformat() for d in s["periods"]],
            "rows": {
                k: [float(x) for x in v] for k, v in s["rows"].items()
            },
        }

    return {k: stmt(v) for k, v in statements.items()}


# The JSON fixture shared by the golden script and the TypeScript harness.
FUNDAMENTALS = {FUND_FILE: {"quarterly": jsonable(QUARTERLY), "annual": jsonable(ANNUAL)}}


# --------------------------------------------------------- numpy references


def _unix(dates: list[dt.date]) -> np.ndarray:
    return np.array(
        [dt.datetime(d.year, d.month, d.day, tzinfo=dt.timezone.utc).timestamp() for d in dates]
    )


def row(basis: dict, kind: str, name: str) -> tuple[np.ndarray, np.ndarray]:
    stmt = basis[kind]
    return _unix(stmt["periods"]), np.asarray(stmt["rows"][name], dtype=np.float64)


def ffill(periods: np.ndarray, values: np.ndarray, times: np.ndarray) -> np.ndarray:
    """Value of the last period ending at or before each bar time."""
    idx = np.searchsorted(periods, times, side="right") - 1
    out = nans(len(times))
    ok = idx >= 0
    out[ok] = values[idx[ok]]
    return out


def ttm(values: np.ndarray) -> np.ndarray:
    """Sum of each quarter and the three before it (NaN until four are known)."""
    out = np.full(len(values), np.nan)
    for k in range(3, len(values)):
        out[k] = float(np.sum(values[k - 3 : k + 1]))
    return out


def yoy(values: np.ndarray) -> np.ndarray:
    """Percent change against the value four quarters earlier."""
    out = np.full(len(values), np.nan)
    for k in range(4, len(values)):
        base = values[k - 4]
        if base != 0:
            out[k] = (values[k] - base) / abs(base) * 100.0
    return out


def cases() -> list:
    out = Cases()
    T = DAILY.time
    C = DAILY.close
    q, a = QUARTERLY, ANNUAL

    q_rev_p, q_rev = row(q, "income", "Total Revenue")
    q_net_p, q_net = row(q, "income", "Net Income")
    q_eps_p, q_eps = row(q, "income", "Diluted EPS")
    q_gross_p, q_gross = row(q, "income", "Gross Profit")
    q_op_p, q_op = row(q, "income", "Operating Income")
    q_ocf_p, q_ocf = row(q, "cashflow", "Operating Cash Flow")
    q_capex_p, q_capex = row(q, "cashflow", "Capital Expenditure")
    q_debt_p, q_debt = row(q, "balance", "Total Debt")
    q_cash_p, q_cash = row(q, "balance", "Cash And Cash Equivalents")
    q_ca_p, q_ca = row(q, "balance", "Current Assets")
    q_cl_p, q_cl = row(q, "balance", "Current Liabilities")
    q_eq_p, q_eq = row(q, "balance", "Stockholders Equity")
    q_sh_p, q_sh = row(q, "balance", "Ordinary Shares Number")
    q_ttm_rev = ttm(q_rev)
    q_ttm_net = ttm(q_net)
    q_ttm_eps = ttm(q_eps)
    q_ttm_ocf = ttm(q_ocf)
    q_ttm_fcf = ttm(q_ocf + q_capex)
    a_rev_p, a_rev = row(a, "income", "Total Revenue")

    def add(name, inputs, outputs):
        out.add(name, inputs, "numpy", outputs, bars=DAILY, fund=FUND_FILE)

    def palette(g: np.ndarray) -> np.ndarray:
        return np.where(g >= 0, 1.0, 0.0)

    add("fin-revenue", {}, {"revenue": ffill(q_rev_p, q_rev, T), "ttm": ffill(q_rev_p, q_ttm_rev, T)})
    add(
        "fin-revenue-annual",
        {"period": "Annual", "ttm": False},
        # The TTM plot exists as an output; on the annual basis it stays empty.
        {"revenue": ffill(a_rev_p, a_rev, T), "ttm": nans(len(T))},
    )
    add("fin-net-income", {}, {"netIncome": ffill(q_net_p, q_net, T), "ttm": ffill(q_net_p, q_ttm_net, T)})
    add("fin-eps", {}, {"eps": ffill(q_eps_p, q_eps, T), "ttm": ffill(q_eps_p, q_ttm_eps, T)})
    add("fin-gross-margin", {}, {"margin": ffill(q_rev_p, q_gross / q_rev * 100.0, T)})
    add("fin-operating-margin", {}, {"margin": ffill(q_rev_p, q_op / q_rev * 100.0, T)})
    add("fin-net-margin", {}, {"margin": ffill(q_rev_p, q_net / q_rev * 100.0, T)})
    g_rev, g_net = yoy(q_rev), yoy(q_net)
    add(
        "fin-revenue-growth",
        {},
        {
            "growth": ffill(q_rev_p, g_rev, T),
            "growth.color": palette(ffill(q_rev_p, g_rev, T)),
        },
    )
    add(
        "fin-net-income-growth",
        {},
        {
            "growth": ffill(q_net_p, g_net, T),
            "growth.color": palette(ffill(q_net_p, g_net, T)),
        },
    )
    add("fin-ocf", {}, {"ocf": ffill(q_ocf_p, q_ocf, T), "ttm": ffill(q_ocf_p, q_ttm_ocf, T)})
    add(
        "fin-fcf",
        {},
        {
            "fcf": ffill(q_ocf_p, q_ocf + q_capex, T),
            "ttm": ffill(q_ocf_p, q_ttm_fcf, T),
        },
    )
    add("fin-debt-cash", {}, {"debt": ffill(q_debt_p, q_debt, T), "cash": ffill(q_cash_p, q_cash, T)})
    add("fin-debt-equity", {}, {"ratio": ffill(q_debt_p, q_debt / q_eq, T)})
    add("fin-current-ratio", {}, {"ratio": ffill(q_ca_p, q_ca / q_cl, T)})
    add("fin-roe", {}, {"roe": ffill(q_net_p, ttm(q_net) / q_eq * 100.0, T)})
    add("fin-bvps", {}, {"bvps": ffill(q_eq_p, q_eq / q_sh, T)})

    eps_bars = ffill(q_eps_p, q_ttm_eps, T)
    add("fin-pe", {}, {"pe": np.where(eps_bars > 0, C / eps_bars, np.nan)})
    rps_bars = ffill(q_rev_p, q_ttm_rev, T) / ffill(q_sh_p, q_sh, T)
    add("fin-ps", {}, {"ps": np.where(rps_bars > 0, C / rps_bars, np.nan)})
    bvps_bars = ffill(q_eq_p, q_eq / q_sh, T)
    add("fin-pb", {}, {"pb": np.where(bvps_bars > 0, C / bvps_bars, np.nan)})
    return out.items

