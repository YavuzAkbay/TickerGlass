from datetime import UTC, datetime
from zoneinfo import ZoneInfo

import pandas as pd
import pytest

from tickerglass_api.providers.base import BAR_COLUMNS
from tickerglass_api.providers.resample import resample_bars

NY = ZoneInfo("America/New_York")


def ts(y: int, mo: int, d: int, h: int = 0, mi: int = 0, tz: ZoneInfo | None = None) -> int:
    return int(datetime(y, mo, d, h, mi, tzinfo=tz or UTC).timestamp())


def frame(rows: list[tuple[int, float, float, float, float, float]]) -> pd.DataFrame:
    return pd.DataFrame([(t, o, h, lo, c, c, v) for t, o, h, lo, c, v in rows], columns=BAR_COLUMNS)


def test_empty_frame_gives_an_empty_frame_with_the_bar_columns() -> None:
    out = resample_bars(pd.DataFrame(columns=BAR_COLUMNS), "epoch", 2, "UTC")
    assert out.empty and list(out.columns) == BAR_COLUMNS


def test_epoch_buckets_aggregate_and_align_to_the_epoch() -> None:
    base = ts(2026, 6, 17, 13, 30)  # 13:30:00Z, an even minute
    df = frame(
        [
            (base, 1, 5, 0.5, 2, 10),
            (base + 60, 2, 9, 1, 8, 20),
            # 13:32 is missing; 13:33 starts the next bucket's second half
            (base + 180, 8, 8.5, 7, 7.5, 5),
            (base + 240, 7.5, 12, 7, 11, 7),
        ]
    )
    out = resample_bars(df, "epoch", 2, "UTC")
    assert out["ts"].tolist() == [base, base + 120, base + 240]
    assert out.dtypes["ts"] == "int64"
    first = out.iloc[0]
    assert (first.open, first.high, first.low, first.close, first.volume) == (1, 9, 0.5, 8, 30)
    # A bucket holding only its second minute is stamped at the aligned start.
    second = out.iloc[1]
    assert (second.open, second.close, second.volume) == (8, 7.5, 5)
    assert list(out.columns) == BAR_COLUMNS


def test_input_order_and_duplicates_do_not_matter() -> None:
    base = ts(2026, 6, 17, 13, 30)
    df = frame([(base + 60, 2, 3, 1, 2.5, 4), (base, 1, 2, 0.5, 1.5, 3), (base, 9, 9, 9, 9, 9)])
    # The later row for a repeated timestamp wins (after sorting, the last one).
    out = resample_bars(df, "epoch", 2, "UTC")
    assert len(out) == 1 and out.iloc[0].volume == 13


def test_session_buckets_anchor_at_each_days_first_bar() -> None:
    # 30-minute bars of a New York session (09:30-16:00) on two days -> 90 minutes.
    rows = []
    for day in (16, 17):
        for i in range(13):
            rows.append(
                (ts(2026, 6, day, 9, 30, NY) + i * 1800, 10 + i, 11 + i, 9 + i, 10.5 + i, 1)
            )
    out = resample_bars(frame(rows), "session", 90, "America/New_York")
    starts = [datetime.fromtimestamp(t, NY).strftime("%d %H:%M") for t in out["ts"]]
    assert starts == [
        f"{d} {t}" for d in (16, 17) for t in ("09:30", "11:00", "12:30", "14:00", "15:30")
    ]
    assert out["volume"].tolist() == [3, 3, 3, 3, 1] * 2  # the close bucket holds one bar
    assert out.iloc[0].open == 10 and out.iloc[0].close == 12.5 and out.iloc[0].high == 13


def test_session_anchor_follows_the_local_day_across_dst() -> None:
    # Before and after the March 2026 DST change the UTC open differs by an hour.
    rows = [
        (ts(2026, 3, 6, 9, 30, NY), 1, 1, 1, 1, 1),  # EST
        (ts(2026, 3, 9, 9, 30, NY), 2, 2, 2, 2, 1),  # EDT
    ]
    out = resample_bars(frame(rows), "session", 90, "America/New_York")
    assert out["ts"].tolist() == [r[0] for r in rows]


def test_quarter_buckets_are_calendar_quarters_at_local_midnight() -> None:
    months = [(2025, m) for m in range(10, 13)] + [(2026, m) for m in (1, 2, 3, 4)]
    rows = [
        (ts(y, m, 1, tz=NY), 10 + i, 20 + i, 5 + i, 12 + i, 100) for i, (y, m) in enumerate(months)
    ]
    out = resample_bars(frame(rows), "quarter", 3, "America/New_York")
    assert out["ts"].tolist() == [
        ts(2025, 10, 1, tz=NY),
        ts(2026, 1, 1, tz=NY),
        ts(2026, 4, 1, tz=NY),
    ]
    q4, q1, q2 = out.iloc[0], out.iloc[1], out.iloc[2]
    assert (q4.open, q4.close, q4.volume) == (10, 14, 300)
    assert (q1.open, q1.high, q1.low, q1.close) == (13, 25, 8, 17)
    assert (q2.open, q2.volume) == (16, 100)


def test_invalid_arguments() -> None:
    df = frame([(1, 1, 1, 1, 1, 1)])
    with pytest.raises(ValueError, match="factor"):
        resample_bars(df, "epoch", 0, "UTC")
    with pytest.raises(ValueError, match="rule"):
        resample_bars(df, "weekly", 2, "UTC")  # type: ignore[arg-type]
