from typing import Annotated, Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, HTTPException, Query, Request, Response

from ..deps import BarServiceDep, MarketServiceDep, SymbolServiceDep, UpstreamGuardDep
from ..intervals import resolve_interval
from ..providers.base import Capabilities, ProviderError, ProviderUnsupported
from ..services.performance import compute_performance
from ._cache_headers import set_max_age, set_no_cache

router = APIRouter(tags=["market"])

MAX_QUOTE_SYMBOLS = 100
MAX_NEWS_SYMBOLS = 10
SLOW_MAX_AGE_S = 600  # fundamentals, events
NEWS_MAX_AGE_S = 120


@router.get("/quotes")
def quotes(
    response: Response,
    market: MarketServiceDep,
    guard: UpstreamGuardDep,
    symbols: Annotated[str, Query(min_length=1, max_length=2000)],
) -> list[dict[str, Any]]:
    parsed = [s.strip() for s in symbols.split(",") if s.strip()]
    if not parsed:
        raise HTTPException(status_code=422, detail="symbols must not be empty")
    if len(parsed) > MAX_QUOTE_SYMBOLS:
        raise HTTPException(status_code=422, detail=f"at most {MAX_QUOTE_SYMBOLS} symbols")
    with guard.priority("visible"):
        out = market.quotes(parsed)
    set_no_cache(response)
    return out


def _parse_symbols(symbols: str, limit: int) -> list[str]:
    parsed = [s.strip() for s in symbols.split(",") if s.strip()]
    if not parsed:
        raise HTTPException(status_code=422, detail="symbols must not be empty")
    if len(parsed) > limit:
        raise HTTPException(status_code=422, detail=f"at most {limit} symbols")
    return parsed


# Declared before any /quotes/{...} route.
@router.get("/quotes/extended")
def extended_quotes(
    response: Response,
    market: MarketServiceDep,
    guard: UpstreamGuardDep,
    symbols: Annotated[str, Query(min_length=1, max_length=2000)],
) -> list[dict[str, Any]]:
    wanted = _parse_symbols(symbols, MAX_QUOTE_SYMBOLS)
    with guard.priority("visible"):
        out = market.extended_quotes(wanted)
    set_no_cache(response)
    return out


@router.get("/events/{symbol}")
def events(
    response: Response, market: MarketServiceDep, guard: UpstreamGuardDep, symbol: str
) -> dict[str, Any]:
    with guard.priority("visible"):
        out = market.events(symbol)
    set_max_age(response, SLOW_MAX_AGE_S)
    return out


@router.get("/news")
def news_multi(
    request: Request,
    response: Response,
    market: MarketServiceDep,
    symbols: Annotated[str, Query(min_length=1, max_length=500)],
    limit: Annotated[int, Query(ge=1, le=100)] = 30,
) -> list[dict[str, Any]]:
    """Merged news of up to 10 symbols, newest first, tagged with the source symbol."""
    capabilities: Capabilities = request.app.state.capabilities
    if not capabilities.news:
        # Not per symbol: an unsupported feature must not read as "no news".
        raise ProviderUnsupported("news")
    wanted = list(dict.fromkeys(s.upper() for s in _parse_symbols(symbols, MAX_NEWS_SYMBOLS)))
    merged: dict[str, dict[str, Any]] = {}
    failure: ProviderError | None = None
    ok = False
    for sym in wanted:
        try:
            items = market.news(sym, limit)
        except ProviderError as exc:
            failure = exc
            continue
        ok = True
        for item in items:
            key = str(item.get("id") or item.get("url") or f"{sym}#{len(merged)}")
            if key not in merged:
                merged[key] = {**item, "symbol": sym}
    if not ok and failure is not None:
        raise failure
    out = sorted(merged.values(), key=lambda n: (n.get("time") is None, -(n.get("time") or 0)))
    set_max_age(response, NEWS_MAX_AGE_S)
    return out[:limit]


@router.get("/news/{symbol}")
def news(
    response: Response,
    market: MarketServiceDep,
    symbol: str,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
) -> list[dict[str, Any]]:
    items = market.news(symbol, limit)
    set_max_age(response, NEWS_MAX_AGE_S)
    return items


@router.get("/fundamentals/{symbol}")
def fundamentals(
    response: Response, market: MarketServiceDep, guard: UpstreamGuardDep, symbol: str
) -> dict[str, Any]:
    with guard.priority("visible"):
        out = market.fundamentals(symbol)
    set_max_age(response, SLOW_MAX_AGE_S)
    return out


@router.get("/performance/{symbol}")
def performance(
    response: Response, bars: BarServiceDep, symbols: SymbolServiceDep, symbol: str
) -> dict[str, Any]:
    """1W..5Y price returns from cached daily bars (calendar offsets, exchange tz)."""
    sym = symbol.upper()
    res = bars.get_bars(sym, resolve_interval("1d"), prepost=False, limit=1900, adjusted=False)
    if res.bars.empty:
        raise HTTPException(status_code=404, detail=f"no bars for {sym}")
    try:
        tz = symbols.info(sym).get("timezone") or "UTC"
    except ProviderError:
        tz = "UTC"
    try:
        ZoneInfo(tz)
    except (ZoneInfoNotFoundError, ValueError):
        tz = "UTC"
    set_no_cache(response)
    return {"symbol": sym, **compute_performance(res.bars, tz)}
