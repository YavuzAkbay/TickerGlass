from typing import Annotated, Any

from fastapi import APIRouter, Query, Response

from ..deps import SymbolServiceDep, UpstreamGuardDep
from ._cache_headers import set_max_age
from ._priority import PriorityDep

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
def info(
    response: Response,
    symbols: SymbolServiceDep,
    guard: UpstreamGuardDep,
    priority: PriorityDep,
    symbol: str,
) -> dict[str, Any]:
    with guard.priority(priority):
        found = symbols.info(symbol)
    set_max_age(response, SYMBOL_MAX_AGE_S)
    return found
