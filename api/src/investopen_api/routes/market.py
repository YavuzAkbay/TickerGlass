from typing import Annotated, Any

from fastapi import APIRouter, HTTPException, Query

from ..deps import MarketServiceDep

router = APIRouter(tags=["market"])

MAX_QUOTE_SYMBOLS = 100


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


@router.get("/events/{symbol}")
def events(market: MarketServiceDep, symbol: str) -> dict[str, Any]:
    return market.events(symbol)


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
