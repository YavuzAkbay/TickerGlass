from collections.abc import Iterator
from typing import Annotated

from fastapi import Depends, HTTPException, Request
from sqlalchemy.orm import Session, sessionmaker

from .accounts import Accounts, CurrentUser
from .live import LiveHub
from .notifications.dispatcher import Dispatcher
from .ownership import scope_to_owner, scope_to_system
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


def principal(request: Request) -> CurrentUser:
    """Who the request acts as (set by `AuthMiddleware`: a user, or `CurrentUser.SYSTEM` for the
    alerts token). 401 when the middleware did not run: fail closed."""
    user: CurrentUser | None = getattr(request.state, "user", None)
    if user is None:
        raise HTTPException(401, "unauthorized")
    return user


def get_user(who: Annotated[CurrentUser, Depends(principal)]) -> CurrentUser:
    """Any signed-in user. The alerts service is not a user."""
    if who.is_system:
        raise HTTPException(403, "this route is for signed-in users")
    return who


def get_admin(who: Annotated[CurrentUser, Depends(get_user)]) -> CurrentUser:
    if not who.is_admin:
        raise HTTPException(403, "admin only")
    return who


UserDep = Annotated[CurrentUser, Depends(get_user)]
AdminDep = Annotated[CurrentUser, Depends(get_admin)]


def get_accounts(request: Request) -> Accounts:
    accounts: Accounts = request.app.state.accounts
    return accounts


AccountsDep = Annotated[Accounts, Depends(get_accounts)]


def get_owned_db(request: Request, who: UserDep) -> Iterator[Session]:
    """A session per request limited to the signed-in user's rows (`ownership.py`)."""
    maker: sessionmaker[Session] = request.app.state.sessionmaker
    with maker() as session:
        yield scope_to_owner(session, who.id)


def get_service_principal(
    request: Request, who: Annotated[CurrentUser, Depends(principal)]
) -> CurrentUser:
    """The alerts service. With auth on, only the `SYSTEM` principal (a valid
    `ALERTS_INTERNAL_TOKEN`, see `AuthMiddleware`) qualifies: an admin does not. In open mode
    (no auth, one user) the caller is the service by definition, so the Node service works
    without a token there."""
    if who.is_system:
        return who
    if getattr(request.app.state, "authenticator", None) is None:
        return CurrentUser.SYSTEM
    raise HTTPException(403, "service only")


def get_system_db(
    request: Request, _: Annotated[CurrentUser, Depends(get_service_principal)]
) -> Iterator[Session]:
    """A session that sees every owner's rows: for the alerts service only. Admin features
    that need one open it themselves after `AdminDep` (`system_session`)."""
    maker: sessionmaker[Session] = request.app.state.sessionmaker
    with maker() as session:
        yield scope_to_system(session)


def get_db(request: Request, who: Annotated[CurrentUser, Depends(principal)]) -> Iterator[Session]:
    """A session per request on the app's engine (user data routes). Owner-scoped to the
    signed-in user, so a route that was not written for several users still cannot leave its
    owner's rows; the alerts service (system principal) sees every owner."""
    maker: sessionmaker[Session] = request.app.state.sessionmaker
    with maker() as session:
        if who.is_system:
            scope_to_system(session)
        else:
            scope_to_owner(session, who.id)
        yield session


SessionDep = Annotated[Session, Depends(get_db)]
OwnedSessionDep = Annotated[Session, Depends(get_owned_db)]
SystemSessionDep = Annotated[Session, Depends(get_system_db)]


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
