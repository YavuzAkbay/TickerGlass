from typing import Annotated, Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, HTTPException, Query

from ..deps import BarServiceDep, MarketServiceDep, SymbolServiceDep
from ..intervals import resolve_interval
from ..providers.base import ProviderError
from ..services.performance import compute_performance

router = APIRouter(tags=["market"])

MAX_QUOTE_SYMBOLS = 100
MAX_NEWS_SYMBOLS = 10


@router.get("/quotes")
def quotes(
    market: MarketServiceDep,
    symbols: Annotated[str, Query(min_length=1, max_length=2000)],
) -> list[dict[str, Any]]:
    parsed = [s.strip() for s in symbols.split(",") if s.strip()]
    if not parsed:
        raise HTTPException(status_code=422, detail="symbols must not be empty")
    if len(parsed) > MAX_QUOTE_SYMBOLS:
        raise HTTPException(status_code=422, detail=f"at most {MAX_QUOTE_SYMBOLS} symbols")
    return market.quotes(parsed)


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
    market: MarketServiceDep,
    symbols: Annotated[str, Query(min_length=1, max_length=2000)],
) -> list[dict[str, Any]]:
    return market.extended_quotes(_parse_symbols(symbols, MAX_QUOTE_SYMBOLS))


@router.get("/events/{symbol}")
def events(market: MarketServiceDep, symbol: str) -> dict[str, Any]:
    return market.events(symbol)


@router.get("/news")
def news_multi(
    market: MarketServiceDep,
    symbols: Annotated[str, Query(min_length=1, max_length=500)],
    limit: Annotated[int, Query(ge=1, le=100)] = 30,
) -> list[dict[str, Any]]:
    """Merged news of up to 10 symbols, newest first, tagged with the source symbol."""
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
    return out[:limit]


@router.get("/news/{symbol}")
def news(
    market: MarketServiceDep,
    symbol: str,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
) -> list[dict[str, Any]]:
    return market.news(symbol, limit)


@router.get("/fundamentals/{symbol}")
def fundamentals(market: MarketServiceDep, symbol: str) -> dict[str, Any]:
    return market.fundamentals(symbol)


@router.get("/performance/{symbol}")
def performance(bars: BarServiceDep, symbols: SymbolServiceDep, symbol: str) -> dict[str, Any]:
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
    return {"symbol": sym, **compute_performance(res.bars, tz)}
