"""The provider assembles annual and quarterly statements from yfinance frames."""

from typing import Any

import pandas as pd
import pytest
import yfinance as yf

from tickerglass_api.providers.base import SymbolNotFound
from tickerglass_api.providers.yahoo import YahooProvider


def _frame(rows: dict[str, list[float]], periods: list[str]) -> pd.DataFrame:
    """A statement frame: one column per period, one row index entry per line item."""
    return pd.DataFrame(
        {p: [values[i] for values in rows.values()] for i, p in enumerate(periods)},
        index=list(rows),
    )


class StubTicker:
    """Just enough of yfinance's Ticker for fundamentals()."""

    def __init__(self, symbol: str) -> None:
        self.symbol = symbol

    info: dict[str, Any] = {"quoteType": "EQUITY", "longName": "Stub Corp"}
    income_stmt = _frame({"Total Revenue": [100.0, 90.0]}, ["2024-12-31", "2023-12-31"])
    balance_sheet = _frame({"Total Debt": [5.0, 4.0]}, ["2024-12-31", "2023-12-31"])
    cashflow = _frame({"Operating Cash Flow": [7.0, 6.0]}, ["2024-12-31", "2023-12-31"])
    quarterly_income_stmt = _frame({"Total Revenue": [30.0]}, ["2024-09-30"])
    quarterly_balance_sheet = _frame({"Total Debt": [2.0]}, ["2024-09-30"])
    quarterly_cashflow = _frame({"Operating Cash Flow": [3.0]}, ["2024-09-30"])


@pytest.fixture
def provider(monkeypatch: pytest.MonkeyPatch) -> YahooProvider:
    monkeypatch.setattr(yf, "Ticker", StubTicker)
    return YahooProvider(min_interval=0, retries=1)


def test_fundamentals_assembles_annual_and_quarterly(provider: YahooProvider) -> None:
    out = provider.fundamentals("AAPL")
    assert out["info"]["longName"] == "Stub Corp"
    fin = out["financials"]
    assert fin["income"]["periods"] == ["2024-12-31", "2023-12-31"]
    assert fin["income"]["rows"]["Total Revenue"] == [100.0, 90.0]
    assert fin["balance"]["rows"]["Total Debt"] == [5.0, 4.0]
    quarterly = fin["quarterly"]
    assert quarterly["income"]["periods"] == ["2024-09-30"]
    assert quarterly["income"]["rows"]["Total Revenue"] == [30.0]
    assert quarterly["balance"]["rows"]["Total Debt"] == [2.0]
    assert quarterly["cashflow"]["rows"]["Operating Cash Flow"] == [3.0]


def test_all_statements_empty_is_unknown(
    provider: YahooProvider, monkeypatch: pytest.MonkeyPatch
) -> None:
    for name in (
        "income_stmt",
        "balance_sheet",
        "cashflow",
        "quarterly_income_stmt",
        "quarterly_balance_sheet",
        "quarterly_cashflow",
    ):
        monkeypatch.setattr(StubTicker, name, pd.DataFrame())
    monkeypatch.setattr(StubTicker, "info", {"quoteType": None})
    with pytest.raises(SymbolNotFound):
        provider.fundamentals("NOPE")
