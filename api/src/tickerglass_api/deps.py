from collections.abc import Iterator
from typing import Annotated

from fastapi import Depends, Request
from sqlalchemy.orm import Session, sessionmaker

from .live import LiveHub
from .notifications.dispatcher import Dispatcher
from .providers.guard import UpstreamGuard
from .services.bars import BarService
from .services.market import MarketService
from .services.stats import CacheStats
from .services.symbols import SymbolService
from .settings import Settings


def get_bar_service(request: Request) -> BarService:
    svc: BarService = request.app.state.bar_service
    return svc


def get_symbol_service(request: Request) -> SymbolService:
    svc: SymbolService = request.app.state.symbol_service
    return svc


def get_market_service(request: Request) -> MarketService:
    svc: MarketService = request.app.state.market_service
    return svc


def get_cache_stats(request: Request) -> CacheStats:
    stats: CacheStats = request.app.state.cache_stats
    return stats


def get_upstream_guard(request: Request) -> UpstreamGuard:
    guard: UpstreamGuard = request.app.state.upstream_guard
    return guard


BarServiceDep = Annotated[BarService, Depends(get_bar_service)]
SymbolServiceDep = Annotated[SymbolService, Depends(get_symbol_service)]
MarketServiceDep = Annotated[MarketService, Depends(get_market_service)]
CacheStatsDep = Annotated[CacheStats, Depends(get_cache_stats)]
UpstreamGuardDep = Annotated[UpstreamGuard, Depends(get_upstream_guard)]


def get_db(request: Request) -> Iterator[Session]:
    """A session per request on the app's engine (user data routes)."""
    maker: sessionmaker[Session] = request.app.state.sessionmaker
    with maker() as session:
        yield session


SessionDep = Annotated[Session, Depends(get_db)]


def get_hub(request: Request) -> LiveHub:
    hub: LiveHub = request.app.state.live_hub
    return hub


def get_dispatcher(request: Request) -> Dispatcher:
    dispatcher: Dispatcher = request.app.state.dispatcher
    return dispatcher


def get_app_settings(request: Request) -> Settings:
    settings: Settings = request.app.state.settings
    return settings


HubDep = Annotated[LiveHub, Depends(get_hub)]
DispatcherDep = Annotated[Dispatcher, Depends(get_dispatcher)]
SettingsDep = Annotated[Settings, Depends(get_app_settings)]
