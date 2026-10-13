from typing import Annotated

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from ..deps import BarServiceDep
from ..intervals import resolve_interval

router = APIRouter(tags=["bars"])


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
    bars: BarServiceDep,
    symbol: Annotated[str, Query(min_length=1, max_length=32)],
    interval: str = "1d",
    start: Annotated[int | None, Query(alias="from", description="Inclusive unix seconds")] = None,
    end: Annotated[int | None, Query(alias="to", description="Exclusive unix seconds")] = None,
    limit: Annotated[int, Query(ge=1, le=20_000)] = 2000,
    adjusted: bool = False,
    prepost: bool = False,
) -> BarsResponse:
    """Most recent `limit` bars in [from, to). Page backwards by passing the
    oldest returned `t` as the next `to`, while `hasMore` is true."""
    try:
        spec = resolve_interval(interval)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    res = bars.get_bars(symbol, spec, prepost, start=start, end=end, limit=limit, adjusted=adjusted)
    df = res.bars
    return BarsResponse(
        symbol=symbol.upper(),
        interval=spec.name,
        adjusted=adjusted,
        prepost=prepost and spec.intraday,
        t=df["ts"].astype("int64").tolist(),
        o=df["open"].tolist(),
        h=df["high"].tolist(),
        l=df["low"].tolist(),
        c=df["close"].tolist(),
        v=df["volume"].tolist(),
        hasMore=res.has_more,
    )
