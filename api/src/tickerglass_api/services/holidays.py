"""NYSE trading calendar: holidays and early closes, from rules (no data files, no network).

Regular holidays (NYSE Rule 7.2), with the weekend observance of the exchange:

- New Year's Day, January 1: on a Sunday observed on Monday; on a Saturday **not**
  observed at all (the exchange does not close on the Friday before).
- Martin Luther King Jr. Day, 3rd Monday of January (from 1998).
- Washington's Birthday, 3rd Monday of February.
- Good Friday, two days before Easter (Gregorian, anonymous algorithm).
- Memorial Day, last Monday of May.
- Juneteenth, June 19 (from 2022); Saturday: Friday, Sunday: Monday.
- Independence Day, July 4; Saturday: Friday, Sunday: Monday.
- Labor Day, 1st Monday of September.
- Thanksgiving Day, 4th Thursday of November.
- Christmas Day, December 25; Saturday: Friday, Sunday: Monday.

Early closes (13:00 New York time) on trading days: July 3 (the day before Independence
Day, a Monday-Thursday), the day after Thanksgiving, December 24 (a Monday-Thursday).

One-off closures (days of mourning, disasters) follow no rule: list them in
`Settings.market_extra_holidays` (`MARKET_EXTRA_HOLIDAYS`, ISO dates, comma separated) or pass
`extra`. Without `extra`, the setting from the environment is used. The rules reproduce the
calendar from 2022 on; earlier years miss the one-off closures (and Juneteenth).

Only market "US" (NYSE, Nasdaq) is known. Crypto and other exchanges have no calendar here.
"""

from collections.abc import Collection
from datetime import date, datetime, time, timedelta
from functools import lru_cache
from zoneinfo import ZoneInfo

from ..settings import get_settings

US_TZ = ZoneInfo("America/New_York")
US_CLOSE = time(16, 0)
US_EARLY_CLOSE = time(13, 0)
JUNETEENTH_FROM = 2022
MLK_FROM = 1998
_SEARCH_DAYS = 14  # longer than any run of closed days


def _nth_weekday(year: int, month: int, weekday: int, n: int) -> date:
    """The `n`th `weekday` (0 = Monday) of the month."""
    first = date(year, month, 1)
    return first + timedelta(days=(weekday - first.weekday()) % 7 + 7 * (n - 1))


def _last_weekday(year: int, month: int, weekday: int) -> date:
    nxt = date(year + (month == 12), month % 12 + 1, 1)
    last = nxt - timedelta(days=1)
    return last - timedelta(days=(last.weekday() - weekday) % 7)


def easter(year: int) -> date:
    """Gregorian Easter Sunday (anonymous Gregorian algorithm, Meeus/Jones/Butcher)."""
    a, b, c = year % 19, year // 100, year % 100
    d, e = b // 4, b % 4
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i, k = c // 4, c % 4
    el = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * el) // 451
    month = (h + el - 7 * m + 114) // 31
    day = (h + el - 7 * m + 114) % 31 + 1
    return date(year, month, day)


def _observed(day: date) -> date:
    """Saturday: the Friday before, Sunday: the Monday after."""
    if day.weekday() == 5:
        return day - timedelta(days=1)
    if day.weekday() == 6:
        return day + timedelta(days=1)
    return day


@lru_cache(maxsize=64)
def _rule_holidays(year: int) -> frozenset[date]:
    days = {
        _nth_weekday(year, 2, 0, 3),  # Washington's Birthday
        easter(year) - timedelta(days=2),  # Good Friday
        _last_weekday(year, 5, 0),  # Memorial Day
        _observed(date(year, 7, 4)),
        _nth_weekday(year, 9, 0, 1),  # Labor Day
        _nth_weekday(year, 11, 3, 4),  # Thanksgiving
        _observed(date(year, 12, 25)),
    }
    new_year = date(year, 1, 1)
    if new_year.weekday() != 5:  # a Saturday New Year's Day is not observed
        days.add(_observed(new_year))
    if year >= MLK_FROM:
        days.add(_nth_weekday(year, 1, 0, 3))
    if year >= JUNETEENTH_FROM:
        days.add(_observed(date(year, 6, 19)))
    return frozenset(days)


def _check_market(market: str) -> None:
    if market != "US":
        raise ValueError(f"no trading calendar for market {market!r}")


def _extra(extra: Collection[date] | None) -> Collection[date]:
    return get_settings().market_extra_holidays if extra is None else extra


def holidays(year: int, market: str = "US", *, extra: Collection[date] | None = None) -> list[date]:
    """Sorted exchange holidays of `year`: the rules plus the one-off closures in `extra`
    (default `Settings.market_extra_holidays`)."""
    _check_market(market)
    days = set(_rule_holidays(year))
    days.update(d for d in _extra(extra) if d.year == year)
    return sorted(days)


def is_trading_day(d: date, market: str = "US", *, extra: Collection[date] | None = None) -> bool:
    """True on a weekday that is not an exchange holiday."""
    _check_market(market)
    if d.weekday() >= 5:
        return False
    return d not in _rule_holidays(d.year) and d not in _extra(extra)


def previous_trading_day(
    d: date, market: str = "US", *, extra: Collection[date] | None = None
) -> date:
    """The latest trading day before `d`."""
    for back in range(1, _SEARCH_DAYS + 1):
        day = d - timedelta(days=back)
        if is_trading_day(day, market, extra=extra):
            return day
    raise AssertionError("no trading day within two weeks")  # pragma: no cover


def next_trading_day(d: date, market: str = "US", *, extra: Collection[date] | None = None) -> date:
    """The earliest trading day after `d`."""
    for ahead in range(1, _SEARCH_DAYS + 1):
        day = d + timedelta(days=ahead)
        if is_trading_day(day, market, extra=extra):
            return day
    raise AssertionError("no trading day within two weeks")  # pragma: no cover


def is_early_close(d: date) -> bool:
    """True on a rule-based early-close day (13:00): the day before Independence Day, the
    day after Thanksgiving, Christmas Eve. Whether `d` trades at all is not checked here."""
    if d.month == 7 and d.day == 3:
        return d.weekday() < 4  # Monday-Thursday: July 4 is a weekday after it
    if d.month == 12 and d.day == 24:
        return d.weekday() < 4
    if d.month == 11 and d.weekday() == 4:
        return d == _nth_weekday(d.year, 11, 3, 4) + timedelta(days=1)
    return False


def close_time(d: date, market: str = "US", *, extra: Collection[date] | None = None) -> time:
    """Local close of the session on `d`: 13:00 on an early-close trading day, else 16:00."""
    _check_market(market)
    if is_early_close(d) and is_trading_day(d, market, extra=extra):
        return US_EARLY_CLOSE
    return US_CLOSE


def session_close(
    d: date, market: str = "US", *, extra: Collection[date] | None = None
) -> datetime:
    """Close of the session on trading day `d` as an aware New York datetime; ValueError when
    `d` is not a trading day."""
    if not is_trading_day(d, market, extra=extra):
        raise ValueError(f"{d} is not a trading day")
    return datetime.combine(d, close_time(d, market, extra=extra), US_TZ)
