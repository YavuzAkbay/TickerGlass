"""Screener snapshot technicals (services/screener/technicals.py)."""

from datetime import UTC, date, datetime, time, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd
import pytest

from tickerglass_api.providers.base import BAR_COLUMNS
from tickerglass_api.services.screener import technicals as tech
from tickerglass_api.services.screener.technicals import (
    METRIC_COLUMNS,
    compute_snapshot,
    latest_completed_session,
    session_final_at,
    sma,
    wilder_atr,
    wilder_rsi,
)

GOLDEN = Path(__file__).resolve().parents[2] / "packages/indicators/test/golden"
NY = ZoneInfo("America/New_York")
TOL = 1e-6


def golden(name: str) -> pd.DataFrame:
    path = GOLDEN / name
    if not path.exists():
        pytest.skip(f"golden fixture {name} not available")
    with path.open() as f:
        first = f.readline()
    return pd.read_csv(path, skiprows=1 if first.startswith("#") else 0)


def assert_series(got: np.ndarray, want: pd.Series) -> None:
    expected = want.to_numpy(dtype=float)
    assert len(got) == len(expected)
    assert np.array_equal(np.isnan(got), np.isnan(expected))
    mask = ~np.isnan(expected)
    assert mask.sum() > 100
    assert np.max(np.abs(got[mask] - expected[mask])) < TOL


def bars_frame(name: str) -> pd.DataFrame:
    raw = golden(name)
    return pd.DataFrame(
        {
            "ts": raw["time"].astype("int64"),
            "open": raw["open"],
            "high": raw["high"],
            "low": raw["low"],
            "close": raw["close"],
            "adj_close": raw["close"],
            "volume": raw["volume"],
        }
    )[BAR_COLUMNS]


# ------------------------------------------------------------------- golden


def test_rsi_matches_golden() -> None:
    bars = bars_frame("bars.csv")
    assert_series(wilder_rsi(bars["close"].to_numpy(float)), golden("rsi.csv")["rsi"])


def test_atr_matches_golden() -> None:
    bars = bars_frame("bars.csv")
    got = wilder_atr(*(bars[c].to_numpy(float) for c in ("high", "low", "close")))
    assert_series(got, golden("atr.csv")["atr"])


def test_sma_matches_golden() -> None:
    hourly = bars_frame("bars.csv")["close"].to_numpy(float)
    assert_series(sma(hourly, 9), golden("sma.csv")["ma"])
    daily = bars_frame("bars-daily.csv")["close"].to_numpy(float)
    assert_series(sma(daily, 20), golden("sma-daily.csv")["ma"])


def test_snapshot_last_values_match_golden_series() -> None:
    bars = bars_frame("bars-daily.csv")
    now = datetime.fromtimestamp(int(bars["ts"].iloc[-1]), UTC) + timedelta(days=2)
    snap = compute_snapshot(bars, "UTC", now, target=now.date())
    close = bars["close"].to_numpy(float)
    want_sma20 = golden("sma-daily.csv")["ma"].to_numpy(float)
    assert snap["sma20"] == pytest.approx(want_sma20[-1], abs=TOL)
    assert snap["prev_sma20"] == pytest.approx(want_sma20[-2], abs=TOL)
    rsi = wilder_rsi(close)
    assert snap["rsi14"] == pytest.approx(rsi[-1], abs=TOL)
    assert snap["prev_rsi14"] == pytest.approx(rsi[-2], abs=TOL)
    atr = wilder_atr(*(bars[c].to_numpy(float) for c in ("high", "low", "close")))
    assert snap["atr14"] == pytest.approx(atr[-1], abs=TOL)
    assert snap["sma200"] == pytest.approx(close[-200:].mean(), abs=TOL)
    assert snap["bars_count"] == len(bars)


# -------------------------------------------------------------- hand fixtures


def daily(
    closes: list[float],
    *,
    end: date = date(2026, 11, 5),
    highs: list[float] | None = None,
    lows: list[float] | None = None,
    opens: list[float] | None = None,
    volumes: list[float] | None = None,
    tz: ZoneInfo = NY,
) -> pd.DataFrame:
    """One bar per weekday ending on `end`, stamped at local midnight."""
    days: list[date] = []
    d = end
    while len(days) < len(closes):
        if d.weekday() < 5:
            days.append(d)
        d -= timedelta(days=1)
    days.reverse()
    n = len(closes)
    return pd.DataFrame(
        {
            "ts": [int(datetime(x.year, x.month, x.day, tzinfo=tz).timestamp()) for x in days],
            "open": opens or closes,
            "high": highs or [c + 1 for c in closes],
            "low": lows or [c - 1 for c in closes],
            "close": closes,
            "adj_close": closes,
            "volume": volumes or [1000.0] * n,
        }
    )[BAR_COLUMNS]


AFTER_CLOSE = datetime(2026, 11, 5, 18, 0, tzinfo=NY)  # Thursday evening


def test_short_history_leaves_fields_null() -> None:
    snap = compute_snapshot(daily([10, 11, 12, 11, 13]), "America/New_York", AFTER_CLOSE)
    assert set(snap) == {*METRIC_COLUMNS, "bar_ts", "bars_count"}
    assert snap["last"] == 13
    assert snap["prev_close"] == 11
    assert snap["chg1d_pct"] == pytest.approx((13 - 11) / 11 * 100)
    for key in (
        "rsi14",
        "prev_rsi14",
        "sma20",
        "sma50",
        "sma200",
        "pct_vs_sma200",
        "hi52",
        "lo52",
        "new_hi52",
        "new_lo52",
        "atr14",
        "atr_pct",
        "avg_vol30",
        "rel_vol",
        "avg_dollar_vol30",
        "cross_state",
        "days_since_cross",
        "perf_1m",
        "perf_1y",
    ):
        assert snap[key] is None, key
    assert snap["perf_1w"] is None  # 5 bars do not reach back 7 calendar days


def test_single_bar() -> None:
    snap = compute_snapshot(daily([10]), "America/New_York", AFTER_CLOSE)
    assert snap["last"] == 10
    assert snap["prev_close"] is None
    assert snap["chg1d_pct"] is None
    assert snap["gap_pct"] is None


def test_no_completed_bar_raises() -> None:
    during = datetime(2026, 11, 5, 11, 0, tzinfo=NY)
    with pytest.raises(ValueError):
        compute_snapshot(daily([10]), "America/New_York", during)


def test_warmup_lengths() -> None:
    closes = [float(i % 7 + 10) for i in range(15)]
    snap = compute_snapshot(daily(closes), "America/New_York", AFTER_CLOSE)
    assert snap["rsi14"] is not None  # first RSI on the 15th bar
    assert snap["prev_rsi14"] is None
    assert snap["atr14"] is not None  # first ATR on the 14th bar
    snap = compute_snapshot(daily(closes[:14]), "America/New_York", AFTER_CLOSE)
    assert snap["rsi14"] is None
    assert snap["atr14"] is not None


def test_rsi_extremes_and_atr_hand_values() -> None:
    up = [float(10 + i) for i in range(20)]
    snap = compute_snapshot(daily(up), "America/New_York", AFTER_CLOSE)
    assert snap["rsi14"] == 100.0
    # high - low is 2 and |high - prev close| is 2 on every bar: ATR is 2.
    assert snap["atr14"] == pytest.approx(2.0)
    assert snap["atr_pct"] == pytest.approx(2.0 / 29 * 100)
    down = list(reversed(up))
    assert compute_snapshot(daily(down), "America/New_York", AFTER_CLOSE)["rsi14"] == 0.0


def test_rsi_hand_value() -> None:
    # 14 changes: seven +1, seven -1 -> avg gain = avg loss -> 50; then +2 on bar 16.
    closes = [10.0]
    for i in range(14):
        closes.append(closes[-1] + (1 if i % 2 == 0 else -1))
    closes.append(closes[-1] + 2)
    snap = compute_snapshot(daily(closes), "America/New_York", AFTER_CLOSE)
    assert snap["prev_rsi14"] == pytest.approx(50.0)
    gain = (0.5 * 13 + 2) / 14
    loss = 0.5 * 13 / 14
    assert snap["rsi14"] == pytest.approx(100 - 100 / (1 + gain / loss))


def test_volume_fields_exclude_today() -> None:
    closes = [10.0] * 31
    volumes = [100.0] * 30 + [300.0]
    snap = compute_snapshot(daily(closes, volumes=volumes), "America/New_York", AFTER_CLOSE)
    assert snap["volume"] == 300
    assert snap["avg_vol30"] == 100
    assert snap["rel_vol"] == 3
    assert snap["avg_dollar_vol30"] == 1000
    snap = compute_snapshot(daily(closes[:30], volumes=volumes[:30]), "UTC", AFTER_CLOSE)
    assert snap["avg_vol30"] is None


def test_gap_and_change() -> None:
    snap = compute_snapshot(
        daily([100.0, 110.0], opens=[100.0, 105.0]), "America/New_York", AFTER_CLOSE
    )
    assert snap["gap_pct"] == pytest.approx(5.0)
    assert snap["chg1d_pct"] == pytest.approx(10.0)


def test_52_week_fields() -> None:
    closes = [50.0] * 252
    highs = [60.0] * 252
    lows = [40.0] * 252
    highs[100], lows[200] = 70.0, 30.0
    snap = compute_snapshot(daily(closes, highs=highs, lows=lows), "America/New_York", AFTER_CLOSE)
    assert snap["hi52"] == 70
    assert snap["lo52"] == 30
    assert snap["pct_off_hi52"] == pytest.approx((50 / 70 - 1) * 100)
    assert snap["pct_off_lo52"] == pytest.approx((50 / 30 - 1) * 100)
    assert snap["new_hi52"] is None  # needs 252 bars before today
    # Today's high equals the max of the 252 bars before it: a new high (likewise low).
    closes, highs, lows = [50.0] * 254, [60.0] * 254, [40.0] * 254
    highs[0] = 99.0  # 253 bars back: outside the prior 252-bar window
    snap = compute_snapshot(daily(closes, highs=highs, lows=lows), "America/New_York", AFTER_CLOSE)
    assert snap["new_hi52"] is True
    assert snap["new_lo52"] is True  # 40 <= 40
    lows[-1] = 41.0
    highs[-1] = 59.0
    snap = compute_snapshot(daily(closes, highs=highs, lows=lows), "America/New_York", AFTER_CLOSE)
    assert snap["new_hi52"] is False
    assert snap["new_lo52"] is False


def brute_cross(closes: list[float]) -> tuple[int | None, int | None]:
    s = pd.Series(closes)
    diff = (s.rolling(50).mean() - s.rolling(200).mean()).to_numpy()
    sign = np.sign(diff)
    state = int(sign[-1])
    i = len(sign) - 1
    while i > 0 and sign[i - 1] == state:
        i -= 1
    if i == 0 or np.isnan(sign[i - 1]):
        return state, None
    return state, len(sign) - 1 - i


def test_golden_and_death_cross() -> None:
    # Falling for 250 bars, then rising: SMA50 crosses above SMA200 at some point.
    closes = [300.0 - i for i in range(250)] + [50.0 + 3 * i for i in range(120)]
    snap = compute_snapshot(daily(closes), "America/New_York", AFTER_CLOSE)
    state, days = brute_cross(closes)
    assert state == 1 and days is not None and days > 0
    assert snap["cross_state"] == 1
    assert snap["days_since_cross"] == days
    falling = [100.0 + i for i in range(250)] + [350.0 - 3 * i for i in range(100)]
    snap = compute_snapshot(daily(falling), "America/New_York", AFTER_CLOSE)
    state, days = brute_cross(falling)
    assert state == -1
    assert snap["cross_state"] == -1
    assert snap["days_since_cross"] == days


def test_cross_without_earlier_state_has_no_age() -> None:
    closes = [float(10 + i) for i in range(260)]
    snap = compute_snapshot(daily(closes), "America/New_York", AFTER_CLOSE)
    assert snap["cross_state"] == 1
    assert snap["days_since_cross"] is None


def test_in_progress_session_bar_dropped() -> None:
    bars = daily([10.0, 11.0, 12.0])  # newest bar: Thursday 2026-11-05
    during = datetime(2026, 11, 5, 12, 0, tzinfo=NY)
    snap = compute_snapshot(bars, "America/New_York", during)
    assert snap["last"] == 11
    assert snap["bar_ts"] == int(bars["ts"].iloc[-2])
    # An explicit target wins.
    snap = compute_snapshot(bars, "America/New_York", during, target=date(2026, 11, 5))
    assert snap["last"] == 12


def test_crypto_drops_current_utc_day() -> None:
    days = [date(2026, 11, 3) + timedelta(days=i) for i in range(4)]  # ... Fri 11-06 UTC
    bars = pd.DataFrame(
        {
            "ts": [int(datetime(d.year, d.month, d.day, tzinfo=UTC).timestamp()) for d in days],
            "open": [1.0, 2.0, 3.0, 4.0],
            "high": [1.0, 2.0, 3.0, 4.0],
            "low": [1.0, 2.0, 3.0, 4.0],
            "close": [1.0, 2.0, 3.0, 4.0],
            "adj_close": [1.0, 2.0, 3.0, 4.0],
            "volume": [1.0] * 4,
        }
    )
    now = datetime(2026, 11, 6, 23, 0, tzinfo=UTC)
    snap = compute_snapshot(bars, "UTC", now, crypto=True)
    assert snap["last"] == 3
    assert tech.bar_date(int(snap["bar_ts"] or 0), "UTC", crypto=True) == date(2026, 11, 5)


def crypto_year(n: int, highs: dict[int, float]) -> pd.DataFrame:
    """`n` complete UTC-day bars ending on 2026-11-05."""
    first = date(2026, 11, 5) - timedelta(days=n - 1)
    days = [first + timedelta(days=i) for i in range(n)]
    high = [highs.get(i, 60.0) for i in range(n)]
    return pd.DataFrame(
        {
            "ts": [int(datetime(d.year, d.month, d.day, tzinfo=UTC).timestamp()) for d in days],
            "open": [50.0] * n,
            "high": high,
            "low": [40.0] * n,
            "close": [50.0] * n,
            "adj_close": [50.0] * n,
            "volume": [1.0] * n,
        }
    )


def test_crypto_52_week_window_is_365_days() -> None:
    now = datetime(2026, 11, 6, 12, 0, tzinfo=UTC)
    # A high 315 bars back is outside 252 bars but inside 365: crypto still sees it.
    bars = crypto_year(366, {50: 70.0})
    snap = compute_snapshot(bars, "UTC", now, crypto=True)
    assert snap["hi52"] == 70
    assert snap["new_hi52"] is False  # 60 < 70
    stock = compute_snapshot(bars, "UTC", now)  # same bars read as a stock: 252-bar window
    assert stock["hi52"] == 60
    # The window needs 365 bars (366 for the new-high flags).
    short = compute_snapshot(crypto_year(364, {}), "UTC", now, crypto=True)
    assert short["hi52"] is None and short["new_hi52"] is None
    exact = compute_snapshot(crypto_year(365, {}), "UTC", now, crypto=True)
    assert exact["hi52"] == 60 and exact["new_hi52"] is None
    # A high 366 bars back is outside the window.
    old = compute_snapshot(crypto_year(367, {0: 99.0}), "UTC", now, crypto=True)
    assert old["hi52"] == 60


def test_nan_close_rows_dropped_and_missing_ohl_filled() -> None:
    bars = daily([10.0, 11.0, 12.0])
    bars.loc[1, "close"] = np.nan
    bars.loc[2, "open"] = np.nan
    snap = compute_snapshot(bars, "America/New_York", AFTER_CLOSE)
    assert snap["bars_count"] == 2
    assert snap["prev_close"] == 10
    assert snap["gap_pct"] == pytest.approx(20.0)  # open filled with the close


def test_performance_mapping() -> None:
    closes = [100.0] * 300 + [110.0]
    snap = compute_snapshot(daily(closes), "America/New_York", AFTER_CLOSE)
    for key in ("perf_1w", "perf_1m", "perf_3m", "perf_6m", "perf_ytd", "perf_1y"):
        assert snap[key] == pytest.approx(10.0), key


def test_latest_completed_session() -> None:
    tz = "America/New_York"
    fri = date(2026, 11, 6)
    assert latest_completed_session(datetime(2026, 11, 6, 17, 0, tzinfo=NY), tz) == fri
    assert latest_completed_session(datetime(2026, 11, 6, 15, 59, tzinfo=NY), tz) == date(
        2026, 11, 5
    )
    assert latest_completed_session(datetime(2026, 11, 7, 12, 0, tzinfo=NY), tz) == fri
    assert latest_completed_session(datetime(2026, 11, 9, 10, 0, tzinfo=NY), tz) == fri
    settle = timedelta(minutes=20)
    at = datetime(2026, 11, 9, 16, 10, tzinfo=NY)
    assert latest_completed_session(at, tz, settle=settle) == fri
    assert latest_completed_session(at + settle, tz, settle=settle) == date(2026, 11, 9)


def test_latest_completed_session_skips_holidays() -> None:
    tz = "America/New_York"
    # Thanksgiving week 2026: Thursday closed, Friday closes early at 13:00.
    assert latest_completed_session(datetime(2026, 11, 26, 18, 0, tzinfo=NY), tz) == date(
        2026, 11, 25
    )
    assert latest_completed_session(datetime(2026, 11, 27, 12, 59, tzinfo=NY), tz) == date(
        2026, 11, 25
    )
    assert latest_completed_session(datetime(2026, 11, 27, 13, 0, tzinfo=NY), tz) == date(
        2026, 11, 27
    )
    # An explicit close still wins over the early close.
    assert latest_completed_session(
        datetime(2026, 11, 27, 13, 0, tzinfo=NY), tz, close=time(16, 0)
    ) == date(2026, 11, 25)
    # Good Friday 2026-04-03 and a long weekend: Monday morning looks back to Thursday.
    assert latest_completed_session(datetime(2026, 4, 6, 9, 0, tzinfo=NY), tz) == date(2026, 4, 2)
    # Christmas 2027 observed on Friday 2027-12-24.
    assert latest_completed_session(datetime(2027, 12, 27, 9, 0, tzinfo=NY), tz) == date(
        2027, 12, 23
    )
    # One-off closure.
    extra = [date(2025, 1, 9)]
    assert latest_completed_session(
        datetime(2025, 1, 9, 18, 0, tzinfo=NY), tz, extra=extra
    ) == date(2025, 1, 8)


def test_session_final_at_uses_early_close() -> None:
    tz = "America/New_York"
    settle = timedelta(minutes=20)
    assert session_final_at(date(2026, 11, 27), tz, settle) == datetime(
        2026, 11, 27, 13, 20, tzinfo=NY
    ).astimezone(UTC)
    assert session_final_at(date(2026, 11, 25), tz, settle) == datetime(
        2026, 11, 25, 16, 20, tzinfo=NY
    ).astimezone(UTC)
