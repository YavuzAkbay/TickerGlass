from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import APIRouter, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse

from . import __version__
from .db import make_engine, run_migrations
from .live import LiveHub, LiveSource, Poller, provider_poller
from .providers.base import MarketDataProvider, ProviderError, SymbolNotFound
from .routes import bars, live, market, symbols
from .services.bars import BarService
from .services.market import MarketService
from .services.symbols import SymbolService
from .settings import get_settings


def create_app(
    provider: MarketDataProvider | None = None,
    database_url: str | None = None,
    live_source: LiveSource | None = None,
    live_poller: Poller | None = None,
) -> FastAPI:
    settings = get_settings()
    db_url = database_url or settings.database_url

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        run_migrations(db_url)
        engine = make_engine(db_url)
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
        yield
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

    @app.exception_handler(SymbolNotFound)
    async def _not_found(_: Request, exc: SymbolNotFound) -> JSONResponse:
        return JSONResponse({"detail": f"symbol not found: {exc}"}, status_code=404)

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
    app.include_router(api)
    app.include_router(live.router)
    return app


app = create_app()
