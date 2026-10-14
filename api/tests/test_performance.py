from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import pandas as pd
import pytest
from fastapi.testclient import TestClient

from investopen_api.app import create_app
from investopen_api.providers.base import BAR_COLUMNS, ProviderError, SymbolNotFound
from investopen_api.services.performance import compute_performance

NY = "America/New_York"
KEYS = ["1W", "1M", "3M", "6M", "YTD", "1Y", "5Y"]


def midnight(d: date, tz: str) -> int:
    """Unix seconds of local midnight (how yfinance stamps daily bars)."""
    return int(datetime(d.year, d.month, d.day, tzinfo=ZoneInfo(tz)).timestamp())


def frame(bars: list[tuple[date, float]], tz: str = NY) -> pd.DataFrame:
    rows = [(midnight(d, tz), c, c, c, c, c, 1.0) for d, c in bars]
    return pd.DataFrame(rows, columns=BAR_COLUMNS)


def weekdays(start: date, end: date) -> list[date]:
    out, d = [], start
    while d <= end:
        if d.weekday() < 5:
            out.append(d)
        d += timedelta(days=1)
    return out


def by_key(result: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {p["key"]: p for p in result["periods"]}


def test_period_order_and_hand_computed_value() -> None:
    df = frame([(date(2025, 10, 6), 226.1), (date(2025, 10, 13), 231.5)])
    res = compute_performance(df, NY)
    assert [p["key"] for p in res["periods"]] == KEYS
    assert res["timezone"] == NY
    assert res["asOf"] == 1760328000  # 2025-10-13 00:00 EDT
    assert res["last"] == 231.5
    w = by_key(res)["1W"]
    assert w["baseTime"] == 1759723200  # 2025-10-06 00:00 EDT
    assert w["baseClose"] == 226.1
    # (231.5 / 226.1 - 1) * 100 = 5.4 / 226.1 * 100
    assert w["changePercent"] == pytest.approx(2.3883237505528, rel=1e-12)
    # 1M target 2025-09-13 precedes all history.
    for key in ["1M", "3M", "6M", "YTD", "1Y", "5Y"]:
        assert by_key(res)[key] == {
            "key": key,
            "baseTime": None,
            "baseClose": None,
            "changePercent": None,
        }


def test_weekend_target_picks_friday() -> None:
    # Weekday bars plus a newest bar on Sunday 12 Oct: 1W target = Sunday 5 Oct.
    days = weekdays(date(2025, 9, 1), date(2025, 10, 10))
    bars = [(d, 100.0 + i) for i, d in enumerate(days)] + [(date(2025, 10, 12), 150.0)]
    res = by_key(compute_performance(frame(bars), NY))
    closes = dict(bars)
    assert res["1W"]["baseTime"] == midnight(date(2025, 10, 3), NY)  # Friday
    assert res["1W"]["baseClose"] == closes[date(2025, 10, 3)]
    # 1M target = Friday 12 Sep, an exact hit.
    assert res["1M"]["baseTime"] == midnight(date(2025, 9, 12), NY)


def test_monday_month_target_on_saturday_picks_friday() -> None:
    days = weekdays(date(2025, 9, 1), date(2025, 10, 13))
    bars = [(d, 50.0 + i) for i, d in enumerate(days)]
    res = by_key(compute_performance(frame(bars), NY))
    # 13 Oct - 1 month = Saturday 13 Sep -> Friday 12 Sep.
    assert res["1M"]["baseTime"] == midnight(date(2025, 9, 12), NY)
    assert res["1M"]["baseClose"] == dict(bars)[date(2025, 9, 12)]


def test_31_march_month_clamps_to_end_of_february() -> None:
    # 2025: 31 Mar - 1M = 28 Feb (a Friday, a bar exists that day).
    bars = [(date(2025, 2, 27), 90.0), (date(2025, 2, 28), 80.0), (date(2025, 3, 31), 100.0)]
    res = by_key(compute_performance(frame(bars), NY))
    assert res["1M"]["baseTime"] == midnight(date(2025, 2, 28), NY)
    assert res["1M"]["changePercent"] == pytest.approx(25.0)

    # 2024 (leap year, daily bars incl. weekends): 31 Mar - 1M = 29 Feb, not 2 Mar.
    bars = [(date(2024, 2, 28), 70.0), (date(2024, 2, 29), 80.0), (date(2024, 3, 1), 90.0)]
    bars.append((date(2024, 3, 31), 120.0))
    res = by_key(compute_performance(frame(bars), NY))
    assert res["1M"]["baseTime"] == midnight(date(2024, 2, 29), NY)
    assert res["1M"]["changePercent"] == pytest.approx(50.0)


def test_ytd_on_first_trading_day_uses_prior_year_last_close() -> None:
    bars = [(date(2024, 12, 30), 190.0), (date(2024, 12, 31), 200.0), (date(2025, 1, 2), 210.0)]
    res = by_key(compute_performance(frame(bars), NY))
    assert res["YTD"]["baseTime"] == midnight(date(2024, 12, 31), NY)
    assert res["YTD"]["changePercent"] == pytest.approx(5.0)

    # 31 Dec 2022 was a Saturday: base is Friday 30 Dec.
    bars = [(date(2022, 12, 29), 10.0), (date(2022, 12, 30), 8.0), (date(2023, 1, 3), 10.0)]
    res = by_key(compute_performance(frame(bars), NY))
    assert res["YTD"]["baseTime"] == midnight(date(2022, 12, 30), NY)
    assert res["YTD"]["changePercent"] == pytest.approx(25.0)


def test_ytd_null_without_prior_year_bar() -> None:
    bars = [(date(2025, 1, 2), 10.0), (date(2025, 1, 3), 11.0)]
    assert by_key(compute_performance(frame(bars), NY))["YTD"]["changePercent"] is None


def test_three_month_history_gives_null_long_periods() -> None:
    days = weekdays(date(2025, 7, 14), date(2025, 10, 14))
    bars = [(d, 100.0 + i) for i, d in enumerate(days)]
    res = by_key(compute_performance(frame(bars), NY))
    # 14 Oct - 3M = Monday 14 Jul, the first bar: exact boundary is included.
    assert res["3M"]["baseTime"] == midnight(date(2025, 7, 14), NY)
    assert res["3M"]["baseClose"] == 100.0
    for key in ["6M", "YTD", "1Y", "5Y"]:
        assert res[key]["baseTime"] is None
        assert res[key]["changePercent"] is None
    assert res["1W"]["changePercent"] is not None


def test_five_year_and_one_year() -> None:
    bars = [
        (date(2020, 10, 14), 20.0),
        (date(2024, 10, 14), 80.0),
        (date(2025, 10, 14), 100.0),
    ]
    res = by_key(compute_performance(frame(bars), NY))
    assert res["1Y"]["changePercent"] == pytest.approx(25.0)
    assert res["5Y"]["changePercent"] == pytest.approx(400.0)
    # One day short of five years -> null, never "since inception".
    bars[0] = (date(2020, 10, 15), 20.0)
    assert by_key(compute_performance(frame(bars), NY))["5Y"]["changePercent"] is None


def test_tokyo_dates_use_exchange_timezone() -> None:
    tz = "Asia/Tokyo"
    bars = [(date(2025, 12, 31), 1000.0), (date(2026, 1, 1), 1100.0)]
    df = frame(bars, tz)
    # JST midnight is 15:00 UTC on the previous day.
    assert df["ts"].iloc[-1] == 1767193200  # 2025-12-31T15:00:00Z
    res = by_key(compute_performance(df, tz))
    assert res["YTD"]["baseTime"] == 1767106800  # 2025-12-30T15:00:00Z = 31 Dec JST
    assert res["YTD"]["changePercent"] == pytest.approx(10.0)
    # Read in UTC, the newest bar falls on 31 Dec 2025 and YTD has no base.
    assert by_key(compute_performance(df, "UTC"))["YTD"]["changePercent"] is None


@pytest.mark.parametrize(
    ("newest", "base"),
    [
        (date(2025, 11, 10), date(2025, 10, 10)),  # EST newest, EDT base (fall back)
        (date(2025, 3, 10), date(2025, 2, 10)),  # EDT newest, EST base (spring forward)
    ],
)
def test_dst_boundary_maps_midnight_bars_exactly(newest: date, base: date) -> None:
    # Bars on the day before the target too: an off-by-one-hour mapping of local
    # midnight (fixed offset) would pick that one instead.
    before = base - timedelta(days=1)
    bars = [(before, 40.0), (base, 50.0), (newest, 60.0)]
    df = frame(bars, NY)
    assert midnight(newest, NY) - midnight(base, NY) != (newest - base).days * 86400
    res = by_key(compute_performance(df, NY))
    assert res["1M"]["baseTime"] == midnight(base, NY)
    assert res["1M"]["changePercent"] == pytest.approx(20.0)


def test_non_positive_base_gives_null_change() -> None:
    bars = [(date(2025, 10, 6), 0.0), (date(2025, 10, 13), 5.0)]
    w = by_key(compute_performance(frame(bars), NY))["1W"]
    assert w["baseClose"] == 0.0
    assert w["changePercent"] is None


def test_unsorted_input_and_empty_frame() -> None:
    df = frame([(date(2025, 10, 13), 110.0), (date(2025, 10, 6), 100.0)])
    res = compute_performance(df, NY)
    assert res["last"] == 110.0
    assert by_key(res)["1W"]["changePercent"] == pytest.approx(10.0)
    with pytest.raises(ValueError):
        compute_performance(pd.DataFrame(columns=BAR_COLUMNS), NY)


class FakeProvider:
    """Minimal provider: daily bars for a few symbols, meta with a configurable tz."""

    def __init__(self, frames: dict[str, pd.DataFrame], meta: dict[str, Any]) -> None:
        self.frames = frames
        self.meta = meta

    def history(
        self,
        symbol: str,
        interval: str,
        start: datetime | None,
        end: datetime | None,
        prepost: bool,
    ) -> pd.DataFrame:
        df = self.frames.get(symbol) if interval == "1d" else None
        if df is None:
            return pd.DataFrame(columns=BAR_COLUMNS)
        if start is not None:
            df = df[df["ts"] >= int(start.timestamp())]
        if end is not None:
            df = df[df["ts"] < int(end.timestamp())]
        return df.reset_index(drop=True)

    def symbol_info(self, symbol: str) -> dict[str, Any]:
        info = self.meta.get(symbol)
        if isinstance(info, Exception):
            raise info
        if info is None:
            raise SymbolNotFound(symbol)
        return dict(info)

    def search(self, query: str, limit: int) -> list[dict[str, Any]]:
        return []


def test_performance_route(tmp_path: Path) -> None:
    tokyo = frame([(date(2025, 12, 31), 1000.0), (date(2026, 1, 1), 1100.0)], "Asia/Tokyo")
    fake = FakeProvider(
        {"AAPL": frame([(date(2025, 10, 6), 226.1), (date(2025, 10, 13), 231.5)]), "7203.T": tokyo},
        {
            "AAPL": {"symbol": "AAPL", "timezone": NY},
            "7203.T": ProviderError("meta down"),
        },
    )
    app = create_app(provider=fake, database_url=f"sqlite:///{tmp_path}/p.db")
    with TestClient(app) as client:
        res = client.get("/api/performance/aapl")
        assert res.status_code == 200
        body = res.json()
        assert body["symbol"] == "AAPL"
        assert body["timezone"] == NY
        assert body["asOf"] == 1760328000
        assert body["last"] == 231.5
        assert [p["key"] for p in body["periods"]] == KEYS
        assert body["periods"][0]["baseClose"] == 226.1
        assert body["periods"][0]["changePercent"] == pytest.approx(2.3883237505528)
        assert body["periods"][1]["changePercent"] is None

        # Meta failure falls back to UTC (so the JST 1 Jan bar reads as 31 Dec).
        body = client.get("/api/performance/7203.T").json()
        assert body["timezone"] == "UTC"
        assert body["periods"][4]["changePercent"] is None

        res = client.get("/api/performance/NOPE")
        assert res.status_code == 404
        assert "detail" in res.json()
