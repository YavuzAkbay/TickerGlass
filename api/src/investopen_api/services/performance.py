"""Period returns (1W .. 5Y) from daily bars, using calendar offsets in the exchange tz.

Each period compares the newest close with the close of the last bar whose local
date is on or before the target date. A period is null when the history does not
reach back that far; there is no "since inception" fallback.
"""

import math
from bisect import bisect_right
from collections.abc import Callable
from datetime import date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

import pandas as pd


def _months_back(k: int) -> Callable[[date], date]:
    def target(d: date) -> date:
        # DateOffset clamps the day: 31 Mar - 1 month = 28/29 Feb.
        ts: pd.Timestamp = pd.Timestamp(d) - pd.DateOffset(months=k)
        return ts.date()

    return target


# Order is part of the wire contract.
PERIODS: list[tuple[str, Callable[[date], date]]] = [
    ("1W", lambda d: d - timedelta(days=7)),
    ("1M", _months_back(1)),
    ("3M", _months_back(3)),
    ("6M", _months_back(6)),
    ("YTD", lambda d: date(d.year - 1, 12, 31)),
    ("1Y", _months_back(12)),
    ("5Y", _months_back(60)),
]


def compute_performance(df: pd.DataFrame, tz: str) -> dict[str, Any]:
    """Period returns for a frame with BAR_COLUMNS (daily bars, `ts` unix seconds).

    Raises ValueError for an empty frame (callers map that to 404).
    """
    if df.empty:
        raise ValueError("no bars")
    zone = ZoneInfo(tz)
    df = df.sort_values("ts")
    times: list[int] = df["ts"].astype("int64").tolist()
    closes: list[float] = df["close"].astype(float).tolist()
    dates = [datetime.fromtimestamp(t, zone).date() for t in times]
    last = closes[-1]
    newest = dates[-1]

    periods: list[dict[str, Any]] = []
    for key, target_of in PERIODS:
        # Index of the last bar with local date <= target (dates ascend with ts).
        i = bisect_right(dates, target_of(newest)) - 1
        base_close = closes[i] if i >= 0 else math.nan
        if not math.isfinite(base_close):
            periods.append({"key": key, "baseTime": None, "baseClose": None, "changePercent": None})
            continue
        change = (last / base_close - 1) * 100 if base_close > 0 and math.isfinite(last) else None
        periods.append(
            {"key": key, "baseTime": times[i], "baseClose": base_close, "changePercent": change}
        )
    return {"timezone": tz, "asOf": times[-1], "last": last, "periods": periods}
