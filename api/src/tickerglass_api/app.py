import asyncio
import logging
import math
import time
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
from .accounts import Accounts
from .ai import make_backend
from .auth import (
    USERNAME_MAX_FAILURES,
    Authenticator,
    AuthMiddleware,
    LoginLimiter,
    session_secret,
)
from .auth_oidc import OidcClient
from .backups.restore import ApplyResult, ServerLock, rollback_applied, startup_restore
from .backups.runner import BackupService
from .backups.scheduler import BackupScheduler
from .db import make_engine, run_migrations, sqlite_path
from .live import LiveHub, LiveSource, Poller
from .logredact import install_log_redaction
from .metrics import Metrics, MetricsMiddleware
from .notifications.dispatcher import Dispatcher
from .ownership import system_session
from .providers.base import (
    MarketDataProvider,
    ProviderError,
    ProviderNotConfigured,
    ProviderUnsupported,
    RateLimited,
    SymbolNotFound,
    UpstreamUnavailable,
)
from .providers.registry import PROVIDERS, ProviderSpec, env_cache_source, is_configured
from .routes import (
    ai,
    alerts,
    auth,
    backups,
    bars,
    cache,
    drawings,
    hotlists,
    layouts,
    live,
    market,
    notes,
    portfolio,
    providers,
    screener,
    screens,
    server,
    symbols,
    templates,
    transfer,
    user_scripts,
    user_settings,
    users,
    watchlists,
)
from .routes import health as health_routes
from .routes import metrics as metrics_routes
from .services.cache_gate import CacheGate, CacheRetired
from .services.cache_source import ensure_cache_source
from .services.provider_choice import SelectedBy, env_choice, resolve_startup_provider
from .services.screener.universe import seed_bundle
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
    install_log_redaction()  # also covers `uvicorn tickerglass_api.app:app` run directly
    db_url = database_url or settings.database_url
    if db_url != settings.database_url:
        # Keep settings coherent with the engine (auth's secret file and the server
        # routes read database_url): a `database_url` argument wins over the settings.
        settings = settings.model_copy(update={"database_url": db_url})
    if provider is None and settings.market_provider not in PROVIDERS:
        raise ValueError(
            f"unknown MARKET_PROVIDER {settings.market_provider!r}; valid: {', '.join(PROVIDERS)}"
        )

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        app.state.started_at = time.time()
        db_file = sqlite_path(db_url)
        server_lock: ServerLock | None = None
        applied: ApplyResult | None = None
        if db_file is not None:
            data_dir = db_file.resolve().parent
            data_dir.mkdir(parents=True, exist_ok=True)
            # Held for the server's lifetime: `tickerglass-api backup restore --apply-now` only
            # proceeds when it can take it, i.e. when no server is running.
            server_lock = ServerLock(data_dir)
            # Cleaning the work folder and applying a staged restore (before the migrations,
            # which then upgrade an older backup) only happen while holding the lock.
            applied = startup_restore(db_file, server_lock)
        try:
            run_migrations(db_url)
        except Exception as exc:
            if applied is not None and applied.status == "applied" and db_file is not None:
                rollback_applied(db_file, applied, exc)
            if server_lock is not None:
                server_lock.release()
            raise
        engine = make_engine(db_url)
        app.state.engine = engine
        app.state.sessionmaker = sessionmaker(engine, expire_on_commit=False)
        accounts = Accounts(app.state.sessionmaker, settings)
        accounts.startup()
        app.state.accounts = accounts
        if authenticator is not None:
            authenticator.accounts = accounts
        with system_session(app.state.sessionmaker) as seed_session, seed_session.begin():
            seed_bundle(seed_session, settings)
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
            # Cached bars and metadata belong to the provider (and variant of it: the crypto
            # exchange, a data feed) that fetched them.
            source = env_cache_source(spec)
            if source is not None:
                ensure_cache_source(engine, source)
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
        dispatcher = Dispatcher(
            app.state.sessionmaker,
            stack.runtime.settings,
            app.state.live_hub,
            metrics=app.state.metrics,
        )
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
        backup_service = BackupService(engine, settings)
        app.state.backups = backup_service
        backup_scheduler = BackupScheduler(backup_service)
        app.state.backup_scheduler = backup_scheduler
        backup_scheduler.start()
        app.state.ready = True  # `GET /api/health/ready`
        yield
        app.state.ready = False
        await backup_scheduler.stop()
        await asyncio.to_thread(backup_service.join, 10)
        await dispatcher.stop()
        # First: waits for a switch in progress (it holds the switcher's lock) and refuses
        # later ones, so none can hand the hub a new upstream after the hub is closed.
        # Stops the maintenance and drops queued refreshes (a running one finishes on its
        # own thread).
        await switcher.close()
        await app.state.live_hub.close()
        engine.dispose()
        if server_lock is not None:
            server_lock.release()

    app = FastAPI(title="TickerGlass API", version=__version__, lifespan=lifespan)
    app.state.ai = make_backend(settings)
    app.state.ai_active = set()
    app.add_middleware(GZipMiddleware, minimum_size=1024)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    # Optional auth (auth.py): password, OIDC and/or trusted proxy header. Off unless one
    # of them is configured. The middleware always runs: it names the request's user (the
    # owner user in open mode).
    authenticator: Authenticator | None = None
    if settings.auth_methods:
        app.state.auth_secret = session_secret(settings)
        authenticator = Authenticator(settings, app.state.auth_secret)
        app.state.authenticator = authenticator
        app.state.login_limiter = LoginLimiter()
        # (client IP, username) failures: a sign-in attempt never locks a name for others.
        app.state.pair_limiter = LoginLimiter()
        # Per signed-in user (password change): nobody else can burn it.
        app.state.user_limiter = LoginLimiter(USERNAME_MAX_FAILURES)
        if not settings.alerts_internal_token:
            logging.getLogger("tickerglass.auth").warning(
                "auth is enabled but ALERTS_INTERNAL_TOKEN is not set: the alerts service "
                "cannot authenticate (its requests are refused with 401/403) and alerts will "
                "not fire; set the same ALERTS_INTERNAL_TOKEN for the api and alerts containers"
            )
        if "oidc" in settings.auth_methods:
            app.state.oidc = OidcClient(settings)
        if {"oidc", "header"} & set(settings.auth_methods) and settings.auth_allow_any_user:
            logging.getLogger("tickerglass.auth").warning(
                "AUTH_ALLOW_ANY_USER=true: every account your identity provider accepts can sign in"
            )
    app.add_middleware(
        AuthMiddleware,
        authenticator=authenticator,
        internal_token=settings.alerts_internal_token,
    )
    # Opt-in Prometheus metrics (docs/design/metrics.md). Outermost, so it also counts what
    # the guards above refuse. The collector reads `app.state` lazily, at scrape time.
    app.state.metrics = None
    if settings.metrics_enabled:
        app.state.metrics = Metrics(app)
        app.add_middleware(MetricsMiddleware, metrics=app.state.metrics)

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

    api.include_router(health_routes.router)
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
    api.include_router(screener.router)
    api.include_router(hotlists.router)
    api.include_router(screens.router)
    api.include_router(alerts.router)
    api.include_router(portfolio.router)
    api.include_router(ai.router)
    api.include_router(auth.router)
    api.include_router(users.router)
    api.include_router(users.me_router)
    api.include_router(server.router)
    api.include_router(backups.router)
    api.include_router(transfer.router)
    app.include_router(api)
    app.include_router(live.router)
    if settings.metrics_enabled:
        app.include_router(metrics_routes.router)
    return app


app = create_app()
