from typing import Annotated, Any

from fastapi import APIRouter, Query, Response

from ..deps import SymbolServiceDep
from ._cache_headers import set_max_age

router = APIRouter(prefix="/symbols", tags=["symbols"])

SYMBOL_MAX_AGE_S = 3600


@router.get("/search")
def search(
    response: Response,
    symbols: SymbolServiceDep,
    q: Annotated[str, Query(min_length=1, max_length=64)],
    limit: Annotated[int, Query(ge=1, le=50)] = 10,
) -> list[dict[str, Any]]:
    found = symbols.search(q, limit)
    set_max_age(response, SYMBOL_MAX_AGE_S)
    return found


@router.get("/{symbol}")
def info(response: Response, symbols: SymbolServiceDep, symbol: str) -> dict[str, Any]:
    found = symbols.info(symbol)
    set_max_age(response, SYMBOL_MAX_AGE_S)
    return found
