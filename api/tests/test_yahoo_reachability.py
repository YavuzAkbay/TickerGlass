"""An empty answer from yfinance is "unknown symbol" only when Yahoo can be reached."""

from typing import Any

import pandas as pd
import pytest
import yfinance as yf
import yfinance.data
from curl_cffi.requests import exceptions as curl_exc

from tickerglass_api.providers.base import SymbolNotFound, UpstreamUnavailable
from tickerglass_api.providers.yahoo import YahooProvider


class EmptyTicker:
    """yfinance's behaviour when the time zone lookup fails: an empty frame, no metadata."""

    def __init__(self, symbol: str) -> None:
        self.history_metadata: dict[str, Any] = {}
        self.fast_info: dict[str, Any] = {}

    def history(self, **_: Any) -> pd.DataFrame:
        return pd.DataFrame()


def _session(fail: bool) -> Any:
    calls: list[str] = []

    class Session:
        def get(self, url: str, timeout: float) -> object:
            calls.append(url)
            if fail:
                raise curl_exc.ConnectionError("Failed to perform, curl: (7) CONNECT tunnel failed")
            return object()

    class FakeData:
        _session = Session()

    return FakeData, calls


@pytest.fixture
def provider(monkeypatch: pytest.MonkeyPatch) -> YahooProvider:
    monkeypatch.setattr("tickerglass_api.providers.yahoo.time.sleep", lambda _: None)
    monkeypatch.setattr(yf, "Ticker", EmptyTicker)
    return YahooProvider(min_interval=0, retries=1)


def test_unreachable_yahoo_is_unavailable_not_unknown(
    monkeypatch: pytest.MonkeyPatch, provider: YahooProvider
) -> None:
    data, calls = _session(fail=True)
    monkeypatch.setattr(yfinance.data, "YfData", data)
    with pytest.raises(UpstreamUnavailable, match="Yahoo unreachable"):
        provider.history("AAPL", "1d", None, None, False)
    with pytest.raises(UpstreamUnavailable):
        provider.symbol_info("AAPL")
    assert calls  # probed (with one retry per call)


def test_reachable_yahoo_with_no_data_stays_unknown(
    monkeypatch: pytest.MonkeyPatch, provider: YahooProvider
) -> None:
    data, calls = _session(fail=False)
    monkeypatch.setattr(yfinance.data, "YfData", data)
    assert provider.history("NOPE", "1d", None, None, False).empty
    with pytest.raises(SymbolNotFound):
        provider.symbol_info("NOPE")
    assert len(calls) == 2
