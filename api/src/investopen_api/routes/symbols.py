from typing import Annotated, Any

from fastapi import APIRouter, Query

from ..deps import SymbolServiceDep

router = APIRouter(prefix="/symbols", tags=["symbols"])


@router.get("/search")
def search(
    symbols: SymbolServiceDep,
    q: Annotated[str, Query(min_length=1, max_length=64)],
    limit: Annotated[int, Query(ge=1, le=50)] = 10,
) -> list[dict[str, Any]]:
    return symbols.search(q, limit)


@router.get("/{symbol}")
def info(symbols: SymbolServiceDep, symbol: str) -> dict[str, Any]:
    return symbols.info(symbol)
