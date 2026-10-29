"""Exchange trading hours, used to skip bar tail refreshes while a market is closed.

Only a weekly schedule is known: one regular session per trading day in the exchange
time zone, taken from the symbol's metadata. The trading days follow the time zone
(`TRADING_WEEKS`: Monday-Friday, or Sunday-Thursday for several Middle Eastern
exchanges); a time zone not listed there is treated as always open. Holidays are not
known; series that stop receiving bars back off (see `next_check_at`). Crypto,
currencies, futures, unknown instrument types and a missing or unparseable session are
treated as always open, so a fetch is never skipped wrongly.

The stored session is the one current when the metadata was fetched, which may have
been an early-close day. A session shorter than `SHORT_SESSION`, or metadata older than
the metadata max age (`METADATA_MAX_AGE`, or `Settings.symbol_info_ttl_s`), keeps its
open but is taken to run until midnight.
"""

import re
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta, tzinfo
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

DAY_S = 86_400
# Instrument types (lowercased) whose exchange runs a weekday session.
SESSION_TYPES = frozenset({"equity", "etf", "index", "mutualfund"})
# How long into the regular session a series may lack a bar for today before the day
# is taken to be an exchange holiday.
HOLIDAY_GRACE = timedelta(minutes=30)
# Intraday: how long past the next bar's open its absence is tolerated.
INTRADAY_GRACE_S = 60
# Bound on the stored quiet streak; the backoff is capped well below 2**this anyway.
QUIET_STREAK_MAX = 16
_SESSION_RE = re.compile(r"^(\d{2})(\d{2})-(\d{2})(\d{2})$")
# Any span of this many days contains a trading day.
_SEARCH_DAYS = 8
#: Stored sessions shorter than this may be an early close (a US half day is 3.5 hours).
SHORT_SESSION = timedelta(hours=4)
#: Metadata older than this may hold another day's (early-close) session. Kept equal to
#: `Settings.symbol_info_ttl_s`, whose value callers pass as `max_age`.
METADATA_MAX_AGE = timedelta(hours=24)

MON_FRI = frozenset({0, 1, 2, 3, 4})
SUN_THU = frozenset({6, 0, 1, 2, 3})
# Trading days (`date.weekday()`) per exchange time zone. Not listed: always open.
# Sunday-Thursday: Saudi Exchange, Qatar Stock Exchange, Boursa Kuwait, Bahrain Bourse,
# Egyptian Exchange. Left out on purpose: zones whose exchanges changed their week
# recently or trade on another week (Asia/Jerusalem, Asia/Tehran).
_SUN_THU_ZONES = ("Asia/Riyadh", "Asia/Qatar", "Asia/Kuwait", "Asia/Bahrain", "Africa/Cairo")
_MON_FRI_PREFIXES = ("America/", "Europe/", "Australia/")
_MON_FRI_ZONES = (
    "Africa/Casablanca",
    "Africa/Johannesburg",
    "Africa/Lagos",
    "Africa/Nairobi",
    "Asia/Bangkok",
    "Asia/Calcutta",
    "Asia/Colombo",
    "Asia/Dubai",
    "Asia/Ho_Chi_Minh",
    "Asia/Hong_Kong",
    "Asia/Jakarta",
    "Asia/Karachi",
    "Asia/Kolkata",
    "Asia/Kuala_Lumpur",
    "Asia/Manila",
    "Asia/Saigon",
    "Asia/Seoul",
    "Asia/Shanghai",
    "Asia/Singapore",
    "Asia/Taipei",
    "Asia/Tokyo",
    "Pacific/Auckland",
)
TRADING_WEEKS: dict[str, frozenset[int]] = {
    **dict.fromkeys(_SUN_THU_ZONES, SUN_THU),
    **dict.fromkeys(_MON_FRI_ZONES, MON_FRI),
}


def trading_week(tz_name: str) -> frozenset[int] | None:
    """Trading weekdays of exchanges in `tz_name`, or None when not known."""
    week = TRADING_WEEKS.get(tz_name)
    if week is None and tz_name.startswith(_MON_FRI_PREFIXES):
        week = MON_FRI
    return week


class StoredInfo(dict[str, Any]):
    """Stored symbol metadata plus when it was fetched (UTC)."""

    def __init__(self, data: Mapping[str, Any], *, fetched_at: datetime) -> None:
        super().__init__(data)
        self.fetched_at = fetched_at


@dataclass(frozen=True)
class TradingHours:
    """One regular session per trading day (`days`, `date.weekday()` numbers) in `tz`;
    `extended` opens the whole trading day."""

    tz: ZoneInfo
    open: time
    close: time
    # Pre/post-market series: every trading day is open from midnight to midnight.
    extended: bool = False
    days: frozenset[int] = MON_FRI
    # False when the stored close may be an early one: sessions run until midnight.
    close_known: bool = True

    @classmethod
    def from_symbol_info(
        cls,
        info: Mapping[str, Any],
        *,
        prepost: bool = False,
        now: datetime | None = None,
        max_age: timedelta = METADATA_MAX_AGE,
    ) -> "TradingHours | None":
        """Hours from stored symbol metadata (`type`, `timezone`, `session` "HHMM-HHMM"),
        or None when the symbol is always open or its hours are unknown. With `now` and
        a `StoredInfo`, metadata older than `max_age` has an unknown close."""
        kind = str(info.get("type") or "").lower()
        if kind not in SESSION_TYPES:
            return None
        tz_name, session = info.get("timezone"), info.get("session")
        if not isinstance(tz_name, str) or not isinstance(session, str):
            return None
        days = trading_week(tz_name)
        if days is None:
            return None
        try:
            tz = ZoneInfo(tz_name)
        except (ZoneInfoNotFoundError, ValueError):
            return None
        bounds = _parse_session(session)
        if bounds is None:
            return None
        start, end = bounds
        if end <= start:  # overnight session: no closed gap we could rely on
            return None
        length = datetime.combine(date.min, end) - datetime.combine(date.min, start)
        stale = (
            now is not None
            and isinstance(info, StoredInfo)
            and now - _utc(info.fetched_at) > max_age
        )
        close_known = length >= SHORT_SESSION and not stale
        return cls(tz, start, end, extended=prepost, days=days, close_known=close_known)

    def session(self, day: date) -> tuple[datetime, datetime]:
        """Open and close of the session on `day` (a trading day), as aware datetimes."""
        midnight = datetime.combine(day + timedelta(days=1), time(0), self.tz)
        if self.extended:
            return datetime.combine(day, time(0), self.tz), midnight
        close = datetime.combine(day, self.close, self.tz) if self.close_known else midnight
        return datetime.combine(day, self.open, self.tz), close

    def current_session(self, now: datetime) -> tuple[datetime, datetime] | None:
        """Bounds of the session `now` falls in, or None while closed."""
        day = now.astimezone(self.tz).date()
        if day.weekday() not in self.days:
            return None
        start, end = self.session(day)
        return (start, end) if start <= now < end else None

    def is_open(self, now: datetime) -> bool:
        return self.current_session(now) is not None

    def last_close(self, now: datetime) -> datetime:
        """The latest session close at or before `now`."""
        today = now.astimezone(self.tz).date()
        for back in range(_SEARCH_DAYS):
            day = today - timedelta(days=back)
            if day.weekday() in self.days and (end := self.session(day)[1]) <= now:
                return end
        raise AssertionError("no trading day within a week")  # pragma: no cover

    def next_open(self, now: datetime) -> datetime:
        """The earliest session open after `now`."""
        today = now.astimezone(self.tz).date()
        for ahead in range(_SEARCH_DAYS + 1):
            day = today + timedelta(days=ahead)
            if day.weekday() in self.days and (start := self.session(day)[0]) > now:
                return start
        raise AssertionError("no trading day within a week")  # pragma: no cover

    def regular_open(self, day: date) -> datetime:
        """Open of the regular session on `day`, also for extended series."""
        return datetime.combine(day, self.open, self.tz)


def _utc(dt: datetime) -> datetime:
    # SQLite drops tzinfo on round-trip; stored times are UTC.
    return dt if dt.tzinfo else dt.replace(tzinfo=UTC)


def _parse_session(text: str) -> tuple[time, time] | None:
    m = _SESSION_RE.match(text.strip())
    if m is None:
        return None
    oh, om, ch, cm = (int(g) for g in m.groups())
    if oh > 23 or ch > 23 or om > 59 or cm > 59:
        return None
    return time(oh, om), time(ch, cm)


def newer_bar_due(
    hours: TradingHours | None, newest_ts: int, bar_seconds: int, now: datetime
) -> bool:
    """True when a bar newer than `newest_ts` should exist by `now` if trading went on.

    Intraday: the next bar opened over a minute ago. Daily and longer: the newest bar's
    period (in the exchange's calendar, UTC when hours are unknown) ended before today;
    periods longer than a day get a day of slack for uneven months and quarters.
    """
    if bar_seconds < DAY_S:
        return newest_ts + bar_seconds + INTRADAY_GRACE_S <= now.timestamp()
    tz: tzinfo = hours.tz if hours is not None else UTC
    newest_day = datetime.fromtimestamp(newest_ts, tz).date()
    days = bar_seconds // DAY_S + (0 if bar_seconds == DAY_S else 1)
    return newest_day + timedelta(days=days) <= now.astimezone(tz).date()


def next_check_at(
    hours: TradingHours | None,
    base_ttl: float,
    now: datetime,
    last_fetch: datetime,
    quiet_streak: int,
    settle_s: float,
    quiet_max_s: float,
    *,
    newest_ts: int | None = None,
) -> datetime:
    """When a series last fetched at `last_fetch` is next due for a tail refresh.

    - Open (always, when `hours` is None): `base_ttl * 2**quiet_streak`, capped at
      `quiet_max_s` and never past the session close; a check that would land after the
      close moves to `close + settle_s` instead.
    - Open, quiet, newest bar (`newest_ts`) from before today and more than
      `HOLIDAY_GRACE` past the regular open: an unknown holiday, or a series whose bar
      comes late (a quiet stock, a fund's NAV after the close). Back off at once to
      `quiet_max_s`, still capped by the close; the settle check stays.
    - Closed, last fetch before the last close + `settle_s`: one final check then.
    - Closed otherwise: the next open.
    """
    streak = min(max(quiet_streak, 0), QUIET_STREAK_MAX)
    backoff = timedelta(seconds=min(base_ttl * 2**streak, max(base_ttl, quiet_max_s)))
    if hours is None:
        return last_fetch + backoff
    settle = timedelta(seconds=settle_s)
    session = hours.current_session(now)
    if session is None:
        close = hours.last_close(now)
        if last_fetch < close + settle:
            return close + settle
        return hours.next_open(now)
    if streak and newest_ts is not None:
        today = now.astimezone(hours.tz).date()
        newest_day = datetime.fromtimestamp(newest_ts, hours.tz).date()
        if newest_day < today and now >= hours.regular_open(today) + HOLIDAY_GRACE:
            # Never jump to the next open: the day may be trading after all.
            backoff = timedelta(seconds=max(base_ttl, quiet_max_s))
    due = last_fetch + backoff
    end = session[1]
    return due if due < end else end + settle
