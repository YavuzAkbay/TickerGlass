import asyncio
import math
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import APIRouter, FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy.orm import sessionmaker

from . import __version__
from .db import make_engine, run_migrations
from .live import LiveHub, LiveSource, Poller, provider_poller
from .notifications.dispatcher import Dispatcher
from .providers.base import (
    MarketDataProvider,
    ProviderError,
    RateLimited,
    SymbolNotFound,
    UpstreamUnavailable,
)
from .routes import (
    alerts,
    bars,
    drawings,
    layouts,
    live,
    market,
    notes,
    symbols,
    templates,
    transfer,
    user_scripts,
    user_settings,
    watchlists,
)
from .services.bars import BarService
from .services.market import MarketService
from .services.symbols import SymbolService
from .settings import Settings, get_settings


def _finite(value: Any) -> Any:
    """Replace inf/NaN (e.g. `1e999` echoed back in a 422's `input`) so the response encodes."""
    if isinstance(value, float) and not math.isfinite(value):
        return str(value)
    if isinstance(value, dict):
        return {k: _finite(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_finite(v) for v in value]
    return value


def create_app(
    provider: MarketDataProvider | None = None,
    database_url: str | None = None,
    live_source: LiveSource | None = None,
    live_poller: Poller | None = None,
    settings_override: Settings | None = None,
) -> FastAPI:
    settings = settings_override or get_settings()
    db_url = database_url or settings.database_url

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        run_migrations(db_url)
        engine = make_engine(db_url)
        app.state.sessionmaker = sessionmaker(engine, expire_on_commit=False)
        if provider is None:
            from .providers.yahoo import YahooProvider

            prov: MarketDataProvider = YahooProvider()
        else:
            prov = provider
        app.state.provider = prov
        app.state.bar_service = BarService(engine, prov)
        app.state.symbol_service = SymbolService(engine, prov)
        app.state.market_service = MarketService(prov)
        source = live_source
        if source is None:
            from .providers.yahoo_live import YahooLiveSource

            source = YahooLiveSource()
        app.state.live_hub = LiveHub(
            source,
            live_poller if live_poller is not None else provider_poller(prov),
            poll_after_s=settings.live_poll_after_s,
            poll_interval_s=settings.live_poll_interval_s,
            poll_closed_interval_s=settings.live_poll_closed_interval_s,
        )
        app.state.settings = settings
        app.state.live_hub.bind_loop(asyncio.get_running_loop())
        app.state.alerts_service = alerts.ServiceState()
        dispatcher = Dispatcher(app.state.sessionmaker, settings, app.state.live_hub)
        app.state.dispatcher = dispatcher
        dispatcher.start()
        yield
        await dispatcher.stop()
        await app.state.live_hub.close()
        engine.dispose()

    app = FastAPI(title="InvestOpen API", version=__version__, lifespan=lifespan)
    app.add_middleware(GZipMiddleware, minimum_size=1024)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.exception_handler(RequestValidationError)
    async def _invalid(_: Request, exc: RequestValidationError) -> JSONResponse:
        return JSONResponse({"detail": _finite(jsonable_encoder(exc.errors()))}, status_code=422)

    @app.exception_handler(SymbolNotFound)
    async def _not_found(_: Request, exc: SymbolNotFound) -> JSONResponse:
        return JSONResponse({"detail": f"symbol not found: {exc}"}, status_code=404)

    @app.exception_handler(RateLimited)
    async def _rate_limited(_: Request, exc: RateLimited) -> JSONResponse:
        return JSONResponse(
            {"detail": str(exc)},
            status_code=429,
            headers={"Retry-After": str(exc.retry_after)},
        )

    @app.exception_handler(UpstreamUnavailable)
    async def _unavailable(_: Request, exc: UpstreamUnavailable) -> JSONResponse:
        return JSONResponse({"detail": str(exc)}, status_code=503)

    @app.exception_handler(ProviderError)
    async def _upstream(_: Request, exc: ProviderError) -> JSONResponse:
        return JSONResponse({"detail": str(exc)}, status_code=502)

    api = APIRouter(prefix="/api")

    @api.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok", "version": __version__}

    api.include_router(bars.router)
    api.include_router(symbols.router)
    api.include_router(market.router)
    api.include_router(layouts.router)
    api.include_router(drawings.router)
    api.include_router(templates.router)
    api.include_router(user_settings.router)
    api.include_router(notes.router)
    api.include_router(user_scripts.router)
    api.include_router(watchlists.router)
    api.include_router(watchlists.flags_router)
    api.include_router(alerts.router)
    api.include_router(transfer.router)
    app.include_router(api)
    app.include_router(live.router)
    return app


app = create_app()
