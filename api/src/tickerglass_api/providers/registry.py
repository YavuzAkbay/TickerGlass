"""Market data providers the API can run on, chosen by the `MARKET_PROVIDER` setting.

Adding a provider: implement `MarketDataProvider` (and optionally a `LiveSource`) in a
module next to this one, add a `ProviderSpec` to `PROVIDERS`, and its id to
`Settings.market_provider`. See docs/providers.md.
"""

from collections.abc import Callable
from dataclasses import dataclass

from ..live import LiveSource
from ..settings import Settings
from .base import MarketDataProvider


@dataclass(frozen=True)
class ProviderSpec:
    id: str
    name: str
    description: str
    #: Needs internet access to an upstream service.
    network: bool
    #: Usage terms the user should know about, shown in the app.
    terms: str | None
    #: A symbol the connection test asks for.
    probe_symbol: str
    make: Callable[[Settings], MarketDataProvider]
    #: Streaming source for live ticks (the hub polls quotes while it is quiet).
    make_live: Callable[[MarketDataProvider], LiveSource]


def _yahoo(settings: Settings) -> MarketDataProvider:
    from .yahoo import YahooProvider

    return YahooProvider(
        retries=settings.upstream_retries,
        rate_limit_retries=settings.upstream_rate_limit_retries,
        quote_v7_retry_s=settings.quote_v7_retry_s,
    )


def _yahoo_live(_: MarketDataProvider) -> LiveSource:
    from .yahoo_live import YahooLiveSource

    return YahooLiveSource()


def _demo(_: Settings) -> MarketDataProvider:
    from .demo import DemoProvider

    return DemoProvider()


def _demo_live(provider: MarketDataProvider) -> LiveSource:
    from .demo import DemoLiveSource, DemoProvider

    assert isinstance(provider, DemoProvider)
    return DemoLiveSource(provider)


PROVIDERS: dict[str, ProviderSpec] = {
    "yahoo": ProviderSpec(
        id="yahoo",
        name="Yahoo Finance",
        description="Stocks, ETFs, indices, FX and crypto through yfinance. Free, unofficial API.",
        network=True,
        terms="Yahoo's terms allow personal use only: do not run a public instance on it.",
        probe_symbol="SPY",
        make=_yahoo,
        make_live=_yahoo_live,
    ),
    "demo": ProviderSpec(
        id="demo",
        name="Demo data",
        description="Generated prices for any symbol, offline. For trying the app and tests.",
        network=False,
        terms=None,
        probe_symbol="GLSS",
        make=_demo,
        make_live=_demo_live,
    ),
}
