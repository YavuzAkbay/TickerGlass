import asyncio
import logging
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
from .live import LiveHub, LiveSource, Poller
from .notifications.dispatcher import Dispatcher
from .providers.base import (
    MarketDataProvider,
    ProviderError,
    ProviderNotConfigured,
    ProviderUnsupported,
    RateLimited,
    SymbolNotFound,
    UpstreamUnavailable,
)
from .providers.registry import PROVIDERS, ProviderSpec, is_configured
from .routes import (
    alerts,
    bars,
    cache,
    drawings,
    layouts,
    live,
    market,
    notes,
    providers,
    symbols,
    templates,
    transfer,
    user_scripts,
    user_settings,
    watchlists,
)
from .services.cache_gate import CacheGate, CacheRetired
from .services.cache_source import ensure_cache_source
from .services.provider_choice import SelectedBy, env_choice, resolve_startup_provider
from .services.stats import CacheStats
from .settings import Settings, get_settings
from .stack import (
    ProviderRuntime as ProviderRuntime,  # re-exported: routes and tests import it from here
)
from .stack import (
    ProviderSwitcher,
    build_stack,
    install,
    live_config,
)
from .stack import build_runtime as build_runtime  # re-exported (tests)

log = logging.getLogger(__name__)


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
    if provider is None and settings.market_provider not in PROVIDERS:
        raise ValueError(
            f"unknown MARKET_PROVIDER {settings.market_provider!r}; valid: {', '.join(PROVIDERS)}"
        )

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        run_migrations(db_url)
        engine = make_engine(db_url)
        app.state.sessionmaker = sessionmaker(engine, expire_on_commit=False)
        stats = CacheStats()
        app.state.cache_stats = stats
        gate = CacheGate()
        app.state.cache_gate = gate
        spec: ProviderSpec | None = None
        selected_by: SelectedBy = env_choice(settings)
        if provider is None:
            # MARKET_PROVIDER, or the provider last picked in the app (see provider_choice).
            provider_id, selected_by = resolve_startup_provider(engine, settings, is_configured)
            spec = PROVIDERS[provider_id]
            # Cached bars and metadata belong to the provider that fetched them.
            ensure_cache_source(engine, spec.id)
        stack = build_stack(
            spec,
            settings,
            engine=engine,
            stats=stats,
            gate=gate,
            generation=gate.generation,
            hub=lambda: app.state.live_hub,
            selected_by=selected_by,
            provider=provider,
            live_source=live_source,
        )
        install(app, stack)
        app.state.live_hub = LiveHub(**live_config(stack, live_poller))
        app.state.live_hub.bind_loop(asyncio.get_running_loop())
        app.state.alerts_service = alerts.ServiceState()
        dispatcher = Dispatcher(app.state.sessionmaker, stack.runtime.settings, app.state.live_hub)
        app.state.dispatcher = dispatcher
        dispatcher.start()
        switcher = ProviderSwitcher(
            app,
            engine,
            gate,
            stats,
            live_poller=live_poller,
            switching_enabled=settings.provider_switching,
            cooldown_s=settings.provider_switch_cooldown_s,
        )
        app.state.switcher = switcher
        await switcher.start_current()
        yield
        await dispatcher.stop()
        # First: waits for a switch in progress (it holds the switcher's lock) and refuses
        # later ones, so none can hand the hub a new upstream after the hub is closed.
        # Stops the maintenance and drops queued refreshes (a running one finishes on its
        # own thread).
        await switcher.close()
        await app.state.live_hub.close()
        engine.dispose()

    app = FastAPI(title="TickerGlass API", version=__version__, lifespan=lifespan)
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

    @app.exception_handler(ProviderUnsupported)
    async def _unsupported(request: Request, exc: ProviderUnsupported) -> JSONResponse:
        spec: ProviderSpec | None = getattr(request.app.state, "provider_spec", None)
        name = exc.provider or (spec.id if spec else None)
        return JSONResponse(
            {
                "detail": str(ProviderUnsupported(exc.feature, name)),
                "code": "unsupported",
                "feature": exc.feature,
                "provider": name,
            },
            status_code=501,
        )

    @app.exception_handler(CacheRetired)
    async def _cache_retired(_: Request, __: CacheRetired) -> JSONResponse:
        # The data source was switched while this request was running; a retry runs on it.
        return JSONResponse(
            {"detail": "data source changed; retry", "code": "provider_switched"},
            status_code=503,
            headers={"Retry-After": "1"},
        )

    @app.exception_handler(ProviderNotConfigured)
    async def _not_configured(_: Request, exc: ProviderNotConfigured) -> JSONResponse:
        return JSONResponse({"detail": str(exc), "code": "not_configured"}, status_code=503)

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
    api.include_router(cache.router)
    api.include_router(symbols.router)
    api.include_router(market.router)
    api.include_router(providers.router)
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
