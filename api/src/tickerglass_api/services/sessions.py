"""Exchange trading hours, used to skip bar tail refreshes while a market is closed.

Only a weekly schedule is known: one regular session per weekday (Mon-Fri) in the
exchange time zone, taken from the symbol's metadata. Holidays are not known; they are
inferred from series that stop receiving bars (see `next_check_at`). Crypto, currencies,
futures, unknown instrument types and a missing or unparseable session are treated as
always open, so a fetch is never skipped wrongly.
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
_WEEKDAYS = 5  # Monday..Friday
# Any span of this many days contains a weekday.
_SEARCH_DAYS = 8
_SESSION_RE = re.compile(r"^(\d{2})(\d{2})-(\d{2})(\d{2})$")


@dataclass(frozen=True)
class TradingHours:
    """One regular session per weekday in `tz`; `extended` opens the whole weekday."""

    tz: ZoneInfo
    open: time
    close: time
    # Pre/post-market series: every weekday is open from midnight to midnight.
    extended: bool = False

    @classmethod
    def from_symbol_info(
        cls, info: Mapping[str, Any], *, prepost: bool = False
    ) -> "TradingHours | None":
        """Hours from stored symbol metadata (`type`, `timezone`, `session` "HHMM-HHMM"),
        or None when the symbol is always open or its hours are unknown."""
        kind = str(info.get("type") or "").lower()
        if kind not in SESSION_TYPES:
            return None
        tz_name, session = info.get("timezone"), info.get("session")
        if not isinstance(tz_name, str) or not isinstance(session, str):
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
        return cls(tz, start, end, extended=prepost)

    def session(self, day: date) -> tuple[datetime, datetime]:
        """Open and close of the session on `day` (a weekday), as aware datetimes."""
        if self.extended:
            return (
                datetime.combine(day, time(0), self.tz),
                datetime.combine(day + timedelta(days=1), time(0), self.tz),
            )
        return datetime.combine(day, self.open, self.tz), datetime.combine(day, self.close, self.tz)

    def current_session(self, now: datetime) -> tuple[datetime, datetime] | None:
        """Bounds of the session `now` falls in, or None while closed."""
        day = now.astimezone(self.tz).date()
        if day.weekday() >= _WEEKDAYS:
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
            if day.weekday() < _WEEKDAYS and (end := self.session(day)[1]) <= now:
                return end
        raise AssertionError("no weekday session within a week")  # pragma: no cover

    def next_open(self, now: datetime) -> datetime:
        """The earliest session open after `now`."""
        today = now.astimezone(self.tz).date()
        for ahead in range(_SEARCH_DAYS + 1):
            day = today + timedelta(days=ahead)
            if day.weekday() < _WEEKDAYS and (start := self.session(day)[0]) > now:
                return start
        raise AssertionError("no weekday session within a week")  # pragma: no cover

    def regular_open(self, day: date) -> datetime:
        """Open of the regular session on `day`, also for extended series."""
        return datetime.combine(day, self.open, self.tz)


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
      `HOLIDAY_GRACE` past the regular open: an unknown holiday, wait for the next open.
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
            return hours.next_open(now)
    due = last_fetch + backoff
    end = session[1]
    return due if due < end else end + settle
