from dataclasses import dataclass
from datetime import timedelta

DAY = 86_400


@dataclass(frozen=True)
class IntervalSpec:
    name: str
    seconds: int
    intraday: bool
    # How far back Yahoo serves this interval (None = full history).
    max_lookback: timedelta | None
    # Max span of a single Yahoo request (None = no chunking needed).
    chunk: timedelta | None
    # How long a fetched tail stays fresh before refetching.
    tail_ttl: timedelta


def _intraday(
    name: str, minutes: int, lookback_days: int, chunk_days: int | None = None
) -> IntervalSpec:
    return IntervalSpec(
        name=name,
        seconds=minutes * 60,
        intraday=True,
        # Leave a day of margin; Yahoo rejects requests that touch the boundary.
        max_lookback=timedelta(days=lookback_days - 1),
        chunk=timedelta(days=chunk_days) if chunk_days else None,
        tail_ttl=timedelta(seconds=30),
    )


def _daily(name: str, days: int) -> IntervalSpec:
    return IntervalSpec(
        name=name,
        seconds=days * DAY,
        intraday=False,
        max_lookback=None,
        chunk=None,
        tail_ttl=timedelta(minutes=5),
    )


INTERVALS: dict[str, IntervalSpec] = {
    s.name: s
    for s in [
        _intraday("1m", 1, 30, chunk_days=7),
        _intraday("2m", 2, 60),
        _intraday("5m", 5, 60),
        _intraday("15m", 15, 60),
        _intraday("30m", 30, 60),
        _intraday("60m", 60, 730),
        _intraday("90m", 90, 60),
        _daily("1d", 1),
        _daily("5d", 5),
        _daily("1wk", 7),
        _daily("1mo", 30),
        _daily("3mo", 91),
    ]
}

ALIASES = {"1h": "60m"}


def resolve_interval(name: str) -> IntervalSpec:
    key = ALIASES.get(name, name)
    try:
        return INTERVALS[key]
    except KeyError:
        raise ValueError(f"unsupported interval {name!r}; native: {', '.join(INTERVALS)}") from None
