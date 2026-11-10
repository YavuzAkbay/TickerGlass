import contextvars
import logging
import math
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Response
from pydantic import BaseModel

from ..deps import BarServiceDep, UpstreamGuardDep
from ..intervals import resolve_interval
from ._cache_headers import set_max_age, set_no_cache
from ._priority import PriorityDep

router = APIRouter(tags=["bars"])
logger = logging.getLogger(__name__)

HISTORY_MAX_AGE_S = 300
# A page ending this many bar intervals before now holds only closed, settled bars.
SETTLED_BARS = 2
MAX_SPARKLINE_SYMBOLS = 50
SPARKLINE_WORKERS = 4
SPARKLINE_MAX_AGE_S = 60
# One pool for all requests: concurrent chunk calls share these workers instead of each
# spawning their own. Workers only run `load` (they never wait on other tasks), so queuing is safe.
_SPARKLINE_POOL = ThreadPoolExecutor(max_workers=SPARKLINE_WORKERS, thread_name_prefix="sparkline")


class BarsResponse(BaseModel):
    """Columnar bars. `t` is bar open time in unix seconds (UTC)."""

    symbol: str
    interval: str
    adjusted: bool
    prepost: bool
    t: list[int]
    o: list[float]
    h: list[float]
    l: list[float]  # noqa: E741
    c: list[float]
    v: list[float]
    hasMore: bool


@router.get("/bars", response_model=BarsResponse)
def get_bars(
    response: Response,
    bars: BarServiceDep,
    guard: UpstreamGuardDep,
    priority: PriorityDep,
    symbol: Annotated[str, Query(min_length=1, max_length=32)],
    interval: str = "1d",
    start: Annotated[int | None, Query(alias="from", description="Inclusive unix seconds")] = None,
    end: Annotated[int | None, Query(alias="to", description="Exclusive unix seconds")] = None,
    limit: Annotated[int, Query(ge=1, le=20_000)] = 2000,
    adjusted: bool = False,
    prepost: bool = False,
) -> BarsResponse:
    """Most recent `limit` bars in [from, to). Page backwards by passing the
    oldest returned `t` as the next `to`, while `hasMore` is true. Upstream calls run at
    `interactive` priority unless the `X-TickerGlass-Priority` header asks for a lower one."""
    try:
        spec = resolve_interval(interval)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    with guard.priority(priority):
        res = bars.get_bars(
            symbol, spec, prepost, start=start, end=end, limit=limit, adjusted=adjusted
        )
    df = res.bars
    if end is not None and end <= time.time() - SETTLED_BARS * spec.seconds:
        set_max_age(response, HISTORY_MAX_AGE_S)
    else:
        set_no_cache(response)
    return BarsResponse(
        symbol=symbol.upper(),
        interval=spec.name,
        adjusted=adjusted,
        prepost=bars.effective_prepost(spec, prepost),
        t=df["ts"].astype("int64").tolist(),
        o=df["open"].tolist(),
        h=df["high"].tolist(),
        l=df["low"].tolist(),
        c=df["close"].tolist(),
        v=df["volume"].tolist(),
        hasMore=res.has_more,
    )


class Sparkline(BaseModel):
    """Daily closes, oldest first; `time` holds each bar's open time in unix seconds."""

    closes: list[float]
    time: list[int]


@router.get("/sparklines", response_model=dict[str, Sparkline | None])
def get_sparklines(
    response: Response,
    bars: BarServiceDep,
    guard: UpstreamGuardDep,
    symbols: Annotated[str, Query(min_length=1, max_length=2000)],
    limit: Annotated[int, Query(ge=2, le=400)] = 30,
) -> dict[str, Sparkline | None]:
    """Last `limit` daily closes for several symbols in one call, keyed by upper-cased symbol.
    A symbol that is unknown or fails (rate limit, outage) maps to null instead of failing the
    whole call. Reads the same bars path as `/bars` (cached database bars are reused), always
    at `background` priority: it never waits for tokens and leaves the burst reserve to charts."""
    parsed = list(dict.fromkeys(s.strip().upper() for s in symbols.split(",") if s.strip()))
    if not parsed:
        raise HTTPException(422, "symbols must not be empty")
    if len(parsed) > MAX_SPARKLINE_SYMBOLS:
        raise HTTPException(422, f"at most {MAX_SPARKLINE_SYMBOLS} symbols")
    spec = resolve_interval("1d")

    def load(symbol: str) -> Sparkline | None:
        if len(symbol) > 32:
            return None
        try:
            with guard.priority("background"):
                df = bars.get_bars(symbol, spec, False, limit=limit).bars
        except Exception as exc:  # noqa: BLE001 - one bad symbol must not fail the batch
            logger.debug("sparkline for %s failed: %s", symbol, exc)
            return None
        closes: list[float] = []
        times: list[int] = []
        for ts, close in zip(df["ts"].astype("int64").tolist(), df["close"].tolist(), strict=True):
            if math.isfinite(close):
                closes.append(close)
                times.append(ts)
        return Sparkline(closes=closes, time=times) if closes else None

    # Worker threads start with an empty context; run each in a copy of this one.
    futures = [_SPARKLINE_POOL.submit(contextvars.copy_context().run, load, s) for s in parsed]
    out = {s: f.result() for s, f in zip(parsed, futures, strict=True)}
    if any(v is None for v in out.values()):
        # A null may be a transient failure (rate limit, outage): the browser must retry it.
        set_no_cache(response)
    else:
        set_max_age(response, SPARKLINE_MAX_AGE_S)
    return out
