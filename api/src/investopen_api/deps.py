from collections.abc import Iterator
from typing import Annotated

from fastapi import Depends, Request
from sqlalchemy.orm import Session, sessionmaker

from .services.bars import BarService
from .services.market import MarketService
from .services.symbols import SymbolService


def get_bar_service(request: Request) -> BarService:
    svc: BarService = request.app.state.bar_service
    return svc


def get_symbol_service(request: Request) -> SymbolService:
    svc: SymbolService = request.app.state.symbol_service
    return svc


def get_market_service(request: Request) -> MarketService:
    svc: MarketService = request.app.state.market_service
    return svc


BarServiceDep = Annotated[BarService, Depends(get_bar_service)]
SymbolServiceDep = Annotated[SymbolService, Depends(get_symbol_service)]
MarketServiceDep = Annotated[MarketService, Depends(get_market_service)]


def get_db(request: Request) -> Iterator[Session]:
    """A session per request on the app's engine (user data routes)."""
    maker: sessionmaker[Session] = request.app.state.sessionmaker
    with maker() as session:
        yield session


SessionDep = Annotated[Session, Depends(get_db)]
