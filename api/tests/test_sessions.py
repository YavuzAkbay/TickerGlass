from datetime import UTC, datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

import pytest

from tickerglass_api.services.sessions import (
    HOLIDAY_GRACE,
    StoredInfo,
    TradingHours,
    newer_bar_due,
    next_check_at,
)

NY = ZoneInfo("America/New_York")
US_EQUITY: dict[str, Any] = {
    "symbol": "AAPL",
    "type": "equity",
    "timezone": "America/New_York",
    "session": "0930-1600",
}
SETTLE = 1200.0
QUIET_MAX = 1800.0


def us(prepost: bool = False) -> TradingHours:
    hours = TradingHours.from_symbol_info(US_EQUITY, prepost=prepost)
    assert hours is not None
    return hours


def ny(y: int, m: int, d: int, hh: int = 0, mm: int = 0) -> datetime:
    return datetime(y, m, d, hh, mm, tzinfo=NY)


def check(
    hours: TradingHours | None,
    now: datetime,
    *,
    ttl: float = 30,
    streak: int = 0,
    last_fetch: datetime | None = None,
    newest: datetime | None = None,
) -> datetime:
    return next_check_at(
        hours,
        ttl,
        now,
        now if last_fetch is None else last_fetch,
        streak,
        SETTLE,
        QUIET_MAX,
        newest_ts=None if newest is None else int(newest.timestamp()),
    )


# ------------------------------------------------------------ from_symbol_info


@pytest.mark.parametrize("kind", ["equity", "etf", "index", "mutualfund", "EQUITY"])
def test_session_types_get_weekday_hours(kind: str) -> None:
    hours = TradingHours.from_symbol_info({**US_EQUITY, "type": kind})
    assert hours == TradingHours(NY, time(9, 30), time(16, 0))


@pytest.mark.parametrize(
    "info",
    [
        {**US_EQUITY, "type": "cryptocurrency", "timezone": "UTC"},
        {**US_EQUITY, "type": "currency"},
        {**US_EQUITY, "type": "future"},
        {**US_EQUITY, "type": None},
        {k: v for k, v in US_EQUITY.items() if k != "type"},
        {**US_EQUITY, "session": None},
        {**US_EQUITY, "session": "9:30-16:00"},
        {**US_EQUITY, "session": "0930-2575"},
        {**US_EQUITY, "session": "1800-1700"},  # overnight
        {**US_EQUITY, "timezone": None},
        {**US_EQUITY, "timezone": "Mars/Olympus_Mons"},
        {**US_EQUITY, "timezone": "../etc/passwd"},
    ],
)
def test_unknown_hours_mean_always_open(info: dict[str, Any]) -> None:
    assert TradingHours.from_symbol_info(info) is None


def test_prepost_opens_the_whole_weekday() -> None:
    hours = us(prepost=True)
    assert hours.extended
    assert hours.is_open(ny(2026, 10, 12, 0, 0))
    assert hours.is_open(ny(2026, 10, 12, 4, 0))
    assert hours.is_open(ny(2026, 10, 12, 23, 59))
    assert not hours.is_open(ny(2026, 10, 10, 12, 0))  # Saturday
    assert hours.last_close(ny(2026, 10, 10, 12, 0)) == ny(2026, 10, 10, 0, 0)
    assert hours.next_open(ny(2026, 10, 10, 12, 0)) == ny(2026, 10, 12, 0, 0)


# ---------------------------------------------------------------- open / close


def test_us_equity_open_close() -> None:
    hours = us()
    assert not hours.is_open(ny(2026, 10, 12, 9, 29))
    assert hours.is_open(ny(2026, 10, 12, 9, 30))
    assert hours.is_open(ny(2026, 10, 12, 15, 59))
    assert not hours.is_open(ny(2026, 10, 12, 16, 0))
    assert not hours.is_open(ny(2026, 10, 10, 12, 0))  # Saturday
    assert not hours.is_open(ny(2026, 10, 11, 12, 0))  # Sunday
    # Monday before the open: the last close is Friday's.
    assert hours.last_close(ny(2026, 10, 12, 9, 0)) == ny(2026, 10, 9, 16, 0)
    assert hours.last_close(ny(2026, 10, 12, 16, 0)) == ny(2026, 10, 12, 16, 0)
    assert hours.next_open(ny(2026, 10, 9, 16, 5)) == ny(2026, 10, 12, 9, 30)
    assert hours.next_open(ny(2026, 10, 12, 9, 0)) == ny(2026, 10, 12, 9, 30)
    # While open, the next open is tomorrow's.
    assert hours.next_open(ny(2026, 10, 12, 9, 30)) == ny(2026, 10, 13, 9, 30)


def test_dst_start_in_march() -> None:
    # Clocks go forward on Sunday 2026-03-08: Friday closes at 21:00 UTC (EST),
    # Monday opens at 13:30 UTC (EDT).
    hours = us()
    saturday = datetime(2026, 3, 7, 12, tzinfo=UTC)
    assert hours.last_close(saturday) == datetime(2026, 3, 6, 21, 0, tzinfo=UTC)
    assert hours.next_open(saturday) == datetime(2026, 3, 9, 13, 30, tzinfo=UTC)
    assert not hours.is_open(datetime(2026, 3, 9, 13, 29, tzinfo=UTC))
    assert hours.is_open(datetime(2026, 3, 9, 13, 30, tzinfo=UTC))
    assert not hours.is_open(datetime(2026, 3, 9, 20, 0, tzinfo=UTC))
    # A fetch Friday after the settle: nothing until Monday's open.
    fetched = datetime(2026, 3, 6, 21, 30, tzinfo=UTC)
    assert check(hours, fetched) == datetime(2026, 3, 9, 13, 30, tzinfo=UTC)


def test_dst_end_in_november() -> None:
    # Clocks go back on Sunday 2026-11-01: Friday closes at 20:00 UTC (EDT),
    # Monday opens at 14:30 UTC (EST).
    hours = us()
    friday_close = datetime(2026, 10, 30, 20, 0, tzinfo=UTC)
    assert hours.last_close(datetime(2026, 11, 1, 12, tzinfo=UTC)) == friday_close
    assert hours.next_open(friday_close) == datetime(2026, 11, 2, 14, 30, tzinfo=UTC)
    assert not hours.is_open(datetime(2026, 11, 2, 13, 30, tzinfo=UTC))
    assert hours.is_open(datetime(2026, 11, 2, 14, 30, tzinfo=UTC))
    assert hours.is_open(datetime(2026, 11, 2, 20, 59, tzinfo=UTC))
    assert not hours.is_open(datetime(2026, 11, 2, 21, 0, tzinfo=UTC))
    # A fetch right after Friday's close settles at 20:20 UTC.
    assert check(hours, friday_close + timedelta(minutes=1)) == friday_close + timedelta(
        seconds=SETTLE
    )


def test_tokyo_hours() -> None:
    hours = TradingHours.from_symbol_info(
        {"type": "equity", "timezone": "Asia/Tokyo", "session": "0900-1530"}
    )
    assert hours is not None
    # Wednesday 2026-10-21: 10:00 JST = 01:00 UTC.
    assert hours.is_open(datetime(2026, 10, 21, 1, 0, tzinfo=UTC))
    assert not hours.is_open(datetime(2026, 10, 21, 7, 0, tzinfo=UTC))
    assert hours.last_close(datetime(2026, 10, 21, 7, 0, tzinfo=UTC)) == datetime(
        2026, 10, 21, 6, 30, tzinfo=UTC
    )
    # Friday evening in New York is already Saturday in Tokyo.
    friday_ny = datetime(2026, 10, 23, 22, 0, tzinfo=UTC)
    assert not hours.is_open(friday_ny)
    assert hours.next_open(friday_ny) == datetime(2026, 10, 26, 0, 0, tzinfo=UTC)


def test_istanbul_hours() -> None:
    hours = TradingHours.from_symbol_info(
        {"type": "equity", "timezone": "Europe/Istanbul", "session": "1000-1800"}
    )
    assert hours is not None
    # UTC+3 all year: no DST shift between March and November.
    assert hours.is_open(datetime(2026, 3, 9, 7, 0, tzinfo=UTC))
    assert hours.is_open(datetime(2026, 11, 2, 7, 0, tzinfo=UTC))
    assert not hours.is_open(datetime(2026, 11, 2, 15, 0, tzinfo=UTC))


# --------------------------------------------------------------- next_check_at


def test_open_refreshes_at_ttl_with_quiet_backoff() -> None:
    hours = us()
    now = ny(2026, 10, 12, 11, 0)
    assert check(hours, now) == now + timedelta(seconds=30)
    assert check(hours, now, streak=1) == now + timedelta(seconds=60)
    assert check(hours, now, streak=3) == now + timedelta(seconds=240)
    assert check(hours, now, streak=40) == now + timedelta(seconds=QUIET_MAX)
    assert check(hours, now, ttl=300) == now + timedelta(seconds=300)


def test_open_check_past_the_close_moves_to_settle() -> None:
    hours = us()
    assert check(hours, ny(2026, 10, 12, 15, 59), ttl=300) == ny(2026, 10, 12, 16, 20)
    assert check(hours, ny(2026, 10, 12, 15, 0), streak=10) == ny(2026, 10, 12, 15, 30)


def test_closed_one_check_after_settle_then_next_open() -> None:
    hours = us()
    settle = ny(2026, 10, 12, 16, 20)
    assert check(hours, ny(2026, 10, 12, 16, 5)) == settle
    assert check(hours, settle) == ny(2026, 10, 13, 9, 30)
    assert check(hours, ny(2026, 10, 12, 22, 0)) == ny(2026, 10, 13, 9, 30)
    # Fetched during the session but checked after the close: the settle check is due.
    assert check(hours, ny(2026, 10, 12, 18, 0), last_fetch=ny(2026, 10, 12, 15, 0)) == settle


def test_weekend_waits_for_monday() -> None:
    hours = us()
    assert check(hours, ny(2026, 10, 10, 12, 0)) == ny(2026, 10, 12, 9, 30)
    assert check(hours, ny(2026, 10, 9, 16, 30)) == ny(2026, 10, 12, 9, 30)
    # Last fetched Friday mid-session: Friday's settle check is overdue.
    assert check(hours, ny(2026, 10, 10, 12, 0), last_fetch=ny(2026, 10, 9, 12, 0)) == ny(
        2026, 10, 9, 16, 20
    )


def test_always_open_never_waits_for_a_session() -> None:
    saturday = datetime(2026, 10, 10, 12, tzinfo=UTC)
    assert check(None, saturday) == saturday + timedelta(seconds=30)
    assert check(None, saturday, streak=2) == saturday + timedelta(seconds=120)


def test_suspected_holiday_backs_off_at_the_cap_within_the_session() -> None:
    hours = us()
    friday_bar = ny(2026, 10, 9, 15, 55)
    early = ny(2026, 10, 12, 9, 45)
    assert check(hours, early, streak=2, newest=friday_bar) == early + timedelta(seconds=120)
    late = ny(2026, 10, 12, 9, 30) + HOLIDAY_GRACE
    assert check(hours, late, streak=2, newest=friday_bar) == late + timedelta(seconds=QUIET_MAX)
    # Never past the close: the settle check stays.
    near_close = ny(2026, 10, 12, 15, 45)
    assert check(hours, near_close, streak=9, newest=friday_bar) == ny(2026, 10, 12, 16, 20)
    # Not quiet, or today's bar present: the plain backoff.
    assert check(hours, late, newest=friday_bar) == late + timedelta(seconds=30)
    today_bar = ny(2026, 10, 12, 9, 55)
    assert check(hours, late, streak=2, newest=today_bar) == late + timedelta(seconds=120)


def test_late_first_bar_on_a_trading_day_is_not_skipped() -> None:
    # Wednesday 10:05 and no bar yet today: the next check stays on Wednesday.
    hours = us()
    now = ny(2026, 10, 14, 10, 5)
    tuesday_bar = ny(2026, 10, 13, 15, 55)
    due = check(hours, now, streak=1, newest=tuesday_bar)
    assert due == now + timedelta(seconds=QUIET_MAX)
    assert due < ny(2026, 10, 14, 16, 0)


def test_holiday_grace_counts_from_the_regular_open_with_prepost() -> None:
    hours = us(prepost=True)
    friday_bar = ny(2026, 10, 9, 19, 55)
    night = ny(2026, 10, 12, 1, 0)
    assert check(hours, night, streak=1, newest=friday_bar) == night + timedelta(seconds=60)
    ten = ny(2026, 10, 12, 10, 0)
    assert check(hours, ten, streak=1, newest=friday_bar) == ten + timedelta(seconds=QUIET_MAX)


# -------------------------------------------------------------- trading week

RIYADH = ZoneInfo("Asia/Riyadh")


@pytest.mark.parametrize("tz", ["Asia/Riyadh", "Asia/Qatar", "Asia/Kuwait", "Africa/Cairo"])
def test_sunday_to_thursday_exchanges(tz: str) -> None:
    hours = TradingHours.from_symbol_info(
        {"type": "equity", "timezone": tz, "session": "1000-1500"}
    )
    assert hours is not None
    zone = ZoneInfo(tz)
    # 2026-10-18 is a Sunday.
    assert hours.is_open(datetime(2026, 10, 18, 11, tzinfo=zone))
    assert hours.is_open(datetime(2026, 10, 15, 11, tzinfo=zone))  # Thursday
    assert not hours.is_open(datetime(2026, 10, 16, 11, tzinfo=zone))  # Friday
    assert not hours.is_open(datetime(2026, 10, 17, 11, tzinfo=zone))  # Saturday
    assert hours.next_open(datetime(2026, 10, 15, 16, tzinfo=zone)) == datetime(
        2026, 10, 18, 10, tzinfo=zone
    )
    assert hours.last_close(datetime(2026, 10, 17, 12, tzinfo=zone)) == datetime(
        2026, 10, 15, 15, tzinfo=zone
    )


def test_riyadh_sunday_open_friday_closed() -> None:
    info = {"type": "equity", "timezone": "Asia/Riyadh", "session": "1000-1500"}
    hours = TradingHours.from_symbol_info(info)
    assert hours is not None
    sunday = datetime(2026, 10, 18, 11, tzinfo=RIYADH)
    assert check(hours, sunday) == sunday + timedelta(seconds=30)
    friday = datetime(2026, 10, 16, 11, tzinfo=RIYADH)
    assert check(hours, friday) == datetime(2026, 10, 18, 10, tzinfo=RIYADH)


@pytest.mark.parametrize("tz", ["Asia/Tehran", "Asia/Jerusalem", "UTC"])
def test_unknown_trading_week_means_always_open(tz: str) -> None:
    info = {"type": "equity", "timezone": tz, "session": "0930-1600"}
    assert TradingHours.from_symbol_info(info) is None


# ---------------------------------------------------- unreliable session close


def test_short_stored_session_keeps_the_weekday_open_until_midnight() -> None:
    # Metadata fetched on an early-close day.
    hours = TradingHours.from_symbol_info({**US_EQUITY, "session": "0930-1300"})
    assert hours is not None
    assert not hours.is_open(ny(2026, 11, 30, 9, 0))
    assert hours.is_open(ny(2026, 11, 30, 14, 0))
    assert hours.is_open(ny(2026, 11, 30, 23, 59))
    assert not hours.is_open(ny(2026, 11, 28, 14, 0))  # Saturday


def test_old_metadata_extends_the_close() -> None:
    info = StoredInfo({**US_EQUITY, "session": "0930-1500"}, fetched_at=ny(2026, 10, 12, 10))
    fresh = TradingHours.from_symbol_info(info, now=ny(2026, 10, 12, 15, 30))
    assert fresh is not None and not fresh.is_open(ny(2026, 10, 12, 15, 30))
    old = TradingHours.from_symbol_info(info, now=ny(2026, 10, 14, 15, 30))
    assert old is not None and old.is_open(ny(2026, 10, 14, 15, 30))
    # A plain mapping has no age: trusted.
    plain = TradingHours.from_symbol_info(dict(info), now=ny(2026, 10, 14, 15, 30))
    assert plain is not None and not plain.is_open(ny(2026, 10, 14, 15, 30))


# --------------------------------------------------------------- newer_bar_due


def test_newer_bar_due_intraday() -> None:
    bar = ny(2026, 10, 12, 10, 0)
    ts = int(bar.timestamp())
    assert not newer_bar_due(us(), ts, 300, bar + timedelta(minutes=5))
    assert newer_bar_due(us(), ts, 300, bar + timedelta(minutes=6))


def test_newer_bar_due_daily_family() -> None:
    hours = us()
    monday = int(ny(2026, 10, 12).timestamp())
    assert not newer_bar_due(hours, monday, 86_400, ny(2026, 10, 12, 15, 0))
    assert newer_bar_due(hours, monday, 86_400, ny(2026, 10, 13, 10, 0))
    # Weekly bar of the week starting Monday 10-12: a day of slack after the week.
    assert not newer_bar_due(hours, monday, 7 * 86_400, ny(2026, 10, 19, 10, 0))
    assert newer_bar_due(hours, monday, 7 * 86_400, ny(2026, 10, 20, 10, 0))
    # Monthly bar of January: not due on the 31st.
    jan = int(ny(2026, 1, 1).timestamp())
    assert not newer_bar_due(hours, jan, 30 * 86_400, ny(2026, 1, 31, 10, 0))
    # Without hours the calendar is UTC.
    utc_day = int(datetime(2026, 10, 10, tzinfo=UTC).timestamp())
    assert not newer_bar_due(None, utc_day, 86_400, datetime(2026, 10, 10, 23, tzinfo=UTC))
    assert newer_bar_due(None, utc_day, 86_400, datetime(2026, 10, 11, 0, 1, tzinfo=UTC))
