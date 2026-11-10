from datetime import date, datetime, time
from zoneinfo import ZoneInfo

import pytest

from tickerglass_api.services.holidays import (
    close_time,
    easter,
    holidays,
    is_early_close,
    is_trading_day,
    next_trading_day,
    previous_trading_day,
    session_close,
)
from tickerglass_api.settings import Settings

NY = ZoneInfo("America/New_York")


def d(text: str) -> date:
    return date.fromisoformat(text)


# NYSE calendar as published, rule holidays only (one-off closures excluded).
HOLIDAYS = {
    2022: "2022-01-17 2022-02-21 2022-04-15 2022-05-30 2022-06-20 2022-07-04 2022-09-05 "
    "2022-11-24 2022-12-26",
    2023: "2023-01-02 2023-01-16 2023-02-20 2023-04-07 2023-05-29 2023-06-19 2023-07-04 "
    "2023-09-04 2023-11-23 2023-12-25",
    2024: "2024-01-01 2024-01-15 2024-02-19 2024-03-29 2024-05-27 2024-06-19 2024-07-04 "
    "2024-09-02 2024-11-28 2024-12-25",
    2025: "2025-01-01 2025-01-20 2025-02-17 2025-04-18 2025-05-26 2025-06-19 2025-07-04 "
    "2025-09-01 2025-11-27 2025-12-25",
    2026: "2026-01-01 2026-01-19 2026-02-16 2026-04-03 2026-05-25 2026-06-19 2026-07-03 "
    "2026-09-07 2026-11-26 2026-12-25",
    # Juneteenth and Christmas on a Saturday: Friday; July 4 on a Sunday: Monday.
    2027: "2027-01-01 2027-01-18 2027-02-15 2027-03-26 2027-05-31 2027-06-18 2027-07-05 "
    "2027-09-06 2027-11-25 2027-12-24",
    # New Year's Day on a Saturday: no holiday at all (nor on Friday 2027-12-31).
    2028: "2028-01-17 2028-02-21 2028-04-14 2028-05-29 2028-06-19 2028-07-04 2028-09-04 "
    "2028-11-23 2028-12-25",
}


@pytest.mark.parametrize("year", sorted(HOLIDAYS))
def test_holidays_by_year(year: int) -> None:
    assert holidays(year, extra=[]) == [d(x) for x in HOLIDAYS[year].split()]


def test_easter() -> None:
    assert easter(2024) == d("2024-03-31")
    assert easter(2025) == d("2025-04-20")
    assert easter(2026) == d("2026-04-05")
    assert easter(2027) == d("2027-03-28")
    assert easter(2028) == d("2028-04-16")
    assert easter(2038) == d("2038-04-25")  # the latest Easter


def test_saturday_new_year_has_no_observance() -> None:
    assert d("2028-01-01").weekday() == 5
    assert is_trading_day(d("2027-12-31"), extra=[])
    assert not is_trading_day(d("2028-01-01"), extra=[])  # Saturday anyway
    assert is_trading_day(d("2028-01-03"), extra=[])
    assert not is_trading_day(d("2023-01-02"), extra=[])  # Sunday New Year: Monday


def test_juneteenth_only_from_2022() -> None:
    assert is_trading_day(d("2021-06-18"), extra=[])
    assert not is_trading_day(d("2022-06-20"), extra=[])
    assert not is_trading_day(d("2022-06-19"), extra=[])


def test_is_trading_day_weekends_and_regular_days() -> None:
    assert is_trading_day(d("2026-11-06"), extra=[])  # Friday
    assert not is_trading_day(d("2026-11-07"), extra=[])  # Saturday
    assert not is_trading_day(d("2026-11-08"), extra=[])  # Sunday
    assert not is_trading_day(d("2026-11-26"), extra=[])  # Thanksgiving
    assert is_trading_day(d("2026-11-27"), extra=[])  # the day after, an early close


def test_extra_holidays() -> None:
    mourning = d("2025-01-09")
    assert is_trading_day(mourning, extra=[])  # no rule for it
    assert not is_trading_day(mourning, extra=[mourning])
    assert mourning in holidays(2025, extra=[mourning])
    assert mourning not in holidays(2024, extra=[mourning])
    assert previous_trading_day(d("2025-01-10"), extra=[mourning]) == d("2025-01-08")
    assert next_trading_day(d("2025-01-08"), extra=[mourning]) == d("2025-01-10")
    assert not is_trading_day(mourning, "US", extra=[mourning])


def test_extra_defaults_to_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    from tickerglass_api import settings as settings_mod

    monkeypatch.setenv("MARKET_EXTRA_HOLIDAYS", "2025-01-09, 2025-03-03")
    settings_mod.get_settings.cache_clear()
    try:
        assert not is_trading_day(d("2025-01-09"))
        assert not is_trading_day(d("2025-03-03"))
        assert is_trading_day(d("2025-03-04"))
    finally:
        monkeypatch.delenv("MARKET_EXTRA_HOLIDAYS")
        settings_mod.get_settings.cache_clear()
    assert is_trading_day(d("2025-01-09"))


def test_settings_parse_extra_holidays(monkeypatch: pytest.MonkeyPatch) -> None:
    assert Settings(_env_file=None).market_extra_holidays == []  # type: ignore[call-arg]
    monkeypatch.setenv("MARKET_EXTRA_HOLIDAYS", "2025-01-09,2018-12-05 ,")
    assert Settings(_env_file=None).market_extra_holidays == [  # type: ignore[call-arg]
        d("2025-01-09"),
        d("2018-12-05"),
    ]
    monkeypatch.setenv("MARKET_EXTRA_HOLIDAYS", "")
    assert Settings(_env_file=None).market_extra_holidays == []  # type: ignore[call-arg]


def test_previous_and_next_trading_day() -> None:
    assert previous_trading_day(d("2026-11-09"), extra=[]) == d("2026-11-06")  # Monday
    assert next_trading_day(d("2026-11-06"), extra=[]) == d("2026-11-09")
    assert previous_trading_day(d("2026-04-06"), extra=[]) == d("2026-04-02")  # Good Friday
    assert next_trading_day(d("2026-04-02"), extra=[]) == d("2026-04-06")
    assert previous_trading_day(d("2026-07-06"), extra=[]) == d("2026-07-02")  # Jul 3 observed
    assert next_trading_day(d("2026-12-24"), extra=[]) == d("2026-12-28")
    assert previous_trading_day(d("2028-01-03"), extra=[]) == d("2027-12-31")
    assert next_trading_day(d("2026-11-07"), extra=[]) == d("2026-11-09")  # from a weekend
    assert previous_trading_day(d("2026-11-08"), extra=[]) == d("2026-11-06")


EARLY = [
    "2024-07-03 2024-11-29 2024-12-24",
    "2025-07-03 2025-11-28 2025-12-24",
    "2026-11-27 2026-12-24",  # Jul 3 is the observed holiday
    "2027-11-26",  # Dec 24 is the observed holiday, Jul 3 a Saturday
    "2028-07-03 2028-11-24",  # Dec 24 is a Sunday
    "2022-11-25",  # Jul 3 Sunday, Dec 24 Saturday
    "2023-07-03 2023-11-24",  # Dec 24 Sunday
]


def test_early_closes() -> None:
    expected = {d(x) for line in EARLY for x in line.split()}
    found = {
        day
        for year in range(2022, 2029)
        for month in (7, 11, 12)
        for n in range(1, 32)
        if _valid(year, month, n)
        and close_time(day := date(year, month, n), extra=[]) == time(13, 0)
    }
    assert found == expected
    assert all(is_early_close(day) for day in expected)


def _valid(year: int, month: int, day: int) -> bool:
    try:
        date(year, month, day)
    except ValueError:
        return False
    return True


def test_close_time_regular_and_closed_days() -> None:
    assert close_time(d("2026-11-06"), extra=[]) == time(16, 0)
    assert close_time(d("2026-11-26"), extra=[]) == time(16, 0)  # closed day: not early
    assert close_time(d("2026-07-03"), extra=[]) == time(16, 0)  # the holiday, not an early close
    assert close_time(d("2025-12-24"), extra=[d("2025-12-24")]) == time(16, 0)


def test_session_close() -> None:
    assert session_close(d("2026-11-06"), extra=[]) == datetime(2026, 11, 6, 16, 0, tzinfo=NY)
    assert session_close(d("2026-11-27"), extra=[]) == datetime(2026, 11, 27, 13, 0, tzinfo=NY)
    summer = session_close(d("2026-07-02"), extra=[])
    assert summer.utcoffset() is not None and summer.utcoffset().total_seconds() == -4 * 3600
    with pytest.raises(ValueError):
        session_close(d("2026-11-26"), extra=[])
    with pytest.raises(ValueError):
        session_close(d("2026-11-07"), extra=[])


def test_unknown_market() -> None:
    with pytest.raises(ValueError):
        is_trading_day(d("2026-11-06"), "JP")
    with pytest.raises(ValueError):
        holidays(2026, "JP")
