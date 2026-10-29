"""Build bars of an interval the upstream does not serve from a finer one it does.

All rules keep the bar timestamp convention (unix seconds of the bar's open, daily and
longer bars at exchange-local midnight) and aggregate open first, high max, low min,
close last, adj_close last, volume sum.
"""

from datetime import datetime
from typing import Literal
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd

from .base import BAR_COLUMNS

Rule = Literal["epoch", "session", "quarter"]

_AGG = {
    "open": "first",
    "high": "max",
    "low": "min",
    "close": "last",
    "adj_close": "last",
    "volume": "sum",
}


def resample_bars(df: pd.DataFrame, rule: Rule, factor: int, tz: str) -> pd.DataFrame:
    """Aggregate `df` (BAR_COLUMNS, any order) into bars of the target length.

    - `"epoch"`: `factor` minutes, buckets aligned to the unix epoch (1m -> 2m).
    - `"session"`: `factor` minutes, buckets anchored at the first bar of each exchange-local
      day in `tz`, so every session starts on a bucket edge whatever its open time (30m -> 90m).
      The last bucket of a day may be shorter.
    - `"quarter"`: `factor` calendar months counted from January in `tz`, stamped at the
      local midnight of the bucket's first day (1mo -> 3mo, `factor=3`).

    Buckets without source bars are absent. Returns an empty BAR_COLUMNS frame for no input.
    """
    if factor < 1:
        raise ValueError(f"factor must be positive, got {factor}")
    if rule not in ("epoch", "session", "quarter"):
        raise ValueError(f"unknown resample rule {rule!r}")
    if df.empty:
        return pd.DataFrame(columns=BAR_COLUMNS)
    frame = df.sort_values("ts").drop_duplicates("ts", keep="last").reset_index(drop=True)
    ts = frame["ts"].to_numpy(dtype="int64")
    if rule == "epoch":
        step = factor * 60
        start = ts - ts % step
    elif rule == "session":
        step = factor * 60
        local = pd.to_datetime(ts, unit="s", utc=True).tz_convert(tz)
        day = pd.Series(local.date, index=frame.index)
        anchor = pd.Series(ts, index=frame.index).groupby(day).transform("min").to_numpy()
        start = anchor + (ts - anchor) // step * step
    else:
        zone = ZoneInfo(tz)
        local = pd.to_datetime(ts, unit="s", utc=True).tz_convert(zone)
        months = np.asarray(local.year, dtype="int64") * 12 + np.asarray(local.month) - 1
        first = months - months % factor
        start = np.array(
            [datetime(int(m // 12), int(m % 12) + 1, 1, tzinfo=zone).timestamp() for m in first],
            dtype="int64",
        )
    out = frame.assign(start=start).groupby("start", sort=True).agg(_AGG)
    out.insert(0, "ts", out.index.to_numpy(dtype="int64"))
    return out.reset_index(drop=True)[BAR_COLUMNS]
