"""Market data providers the API can run on, chosen by the `MARKET_PROVIDER` setting.

Adding a provider: implement `MarketDataProvider` (and optionally a `LiveSource`) in a
module next to this one, add a `ProviderSpec` to `PROVIDERS`. A provider with settings of
its own declares them as a `BaseSettings` model (`config`, env prefix `<ID>_`). See
docs/providers.md.
"""

import types
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Union, get_args, get_origin

import pandas as pd
from pydantic import SecretStr, ValidationError
from pydantic_settings import BaseSettings

from ..live import LiveSource
from ..settings import Settings
from .base import (
    Budget,
    Capabilities,
    ConfigField,
    CostModel,
    MarketDataProvider,
    ProviderNotConfigured,
)

# Light module (HTTP over the standard library, pandas is loaded anyway): imported eagerly.
from .twelvedata import (
    TwelveDataConfig,
    TwelveDataProvider,
    capabilities_for,
    costs_for,
    effective_profile,
    setting_defaults_for,
)


def _full_capabilities(_: BaseSettings | None) -> Capabilities:
    return Capabilities.full()


def _default_costs(_: BaseSettings | None) -> CostModel:
    return CostModel()


def _no_defaults(_: BaseSettings | None) -> Mapping[str, Any]:
    return {}


def _no_plan(_: BaseSettings | None) -> str | None:
    return None


@dataclass(frozen=True)
class ProviderSpec:
    """A provider and everything the app needs to run it without importing it. The
    callables receive the provider's config (None when it has no config model, or when
    required settings are missing: `capabilities` and `costs` must cope with that)."""

    id: str
    name: str
    description: str
    #: Needs internet access to an upstream service.
    network: bool
    #: Usage terms the user should know about, shown in the app.
    terms: str | None
    #: A symbol the connection test asks for.
    probe_symbol: str
    make: Callable[[Settings, BaseSettings | None], MarketDataProvider]
    #: Streaming source for live ticks (the hub polls quotes while it is quiet); None, or
    #: a None result, means polling only.
    make_live: Callable[[MarketDataProvider, BaseSettings | None], LiveSource | None] | None = None
    #: The provider's own settings: env prefix `<ID>_`, secrets as `SecretStr`.
    config: type[BaseSettings] | None = None
    capabilities: Callable[[BaseSettings | None], Capabilities] = _full_capabilities
    costs: Callable[[BaseSettings | None], CostModel] = _default_costs
    #: Defaults for global `Settings` fields (request budget, TTLs, poll intervals) that
    #: suit this provider; applied only to fields the user did not set.
    setting_defaults: Callable[[BaseSettings | None], Mapping[str, Any]] = _no_defaults
    #: Name of the subscription plan the budget follows, if the provider has plans.
    plan: Callable[[BaseSettings | None], str | None] = _no_plan
    #: `history` pages through long ranges itself (one call per backfill window): the bar
    #: service then does not split them in Yahoo-sized chunks.
    self_paging: bool = False


class UnconfiguredProvider:
    """Stands in for a provider whose required settings are missing: the app starts and
    every call fails with `ProviderNotConfigured` naming what to set."""

    def __init__(self, message: str) -> None:
        self._message = message

    def _fail(self) -> ProviderNotConfigured:
        return ProviderNotConfigured(self._message)

    def history(
        self,
        symbol: str,
        interval: str,
        start: datetime | None,
        end: datetime | None,
        prepost: bool,
    ) -> pd.DataFrame:
        raise self._fail()

    def symbol_info(self, symbol: str) -> dict[str, Any]:
        raise self._fail()

    def search(self, query: str, limit: int) -> list[dict[str, Any]]:
        raise self._fail()

    def quotes(self, symbols: list[str]) -> list[dict[str, Any]]:
        raise self._fail()

    def extended_quotes(self, symbols: list[str]) -> list[dict[str, Any]]:
        raise self._fail()

    def events(self, symbol: str) -> dict[str, Any]:
        raise self._fail()

    def news(self, symbol: str, limit: int) -> list[dict[str, Any]]:
        raise self._fail()

    def fundamentals(self, symbol: str) -> dict[str, Any]:
        raise self._fail()


def _env_prefix(model: type[BaseSettings]) -> str:
    return str(model.model_config.get("env_prefix") or "")


def load_config(spec: ProviderSpec) -> BaseSettings | None:
    """The provider's config from the environment (None without a config model).

    Raises `ProviderNotConfigured` naming the variables when required ones are missing, and
    pydantic's `ValidationError` for invalid values."""
    if spec.config is None:
        return None
    try:
        return spec.config()
    except ValidationError as exc:
        missing = [str(e["loc"][0]) for e in exc.errors() if e["type"] == "missing" and e["loc"]]
        if len(missing) != len(exc.errors()):
            raise
        prefix = _env_prefix(spec.config)
        names = ", ".join(f"{prefix}{name}".upper() for name in missing)
        raise ProviderNotConfigured(
            f"{names} {'is' if len(missing) == 1 else 'are'} not set"
        ) from exc


def is_configured(spec: ProviderSpec) -> bool:
    """The provider can run: it has no config model, or the environment holds a valid one
    (required settings set)."""
    try:
        load_config(spec)
    except (ProviderNotConfigured, ValidationError):
        return False
    return True


def missing_config(spec: ProviderSpec) -> list[str]:
    """Environment variables of the provider's required settings that are not set (empty
    when it is configured or its config is invalid for another reason)."""
    if spec.config is None:
        return []
    try:
        spec.config()
    except ValidationError as exc:
        prefix = _env_prefix(spec.config)
        return [
            f"{prefix}{e['loc'][0]}".upper()
            for e in exc.errors()
            if e["type"] == "missing" and e["loc"]
        ]
    return []


def _is_secret(annotation: Any) -> bool:
    if annotation is SecretStr:
        return True
    if get_origin(annotation) in (Union, types.UnionType):
        return any(_is_secret(a) for a in get_args(annotation))
    return False


def config_fields(spec: ProviderSpec, config: BaseSettings | None) -> list[ConfigField]:
    """The provider's settings for display: which are set, and the values of non-secret
    ones (secrets never carry a value). `config` None shows everything as unset."""
    if spec.config is None:
        return []
    prefix = _env_prefix(spec.config)
    out: list[ConfigField] = []
    for name, field in spec.config.model_fields.items():
        secret = _is_secret(field.annotation)
        is_set = config is not None and name in config.model_fields_set
        value: Any = None
        if not secret:
            if config is not None:
                value = getattr(config, name)
            elif not field.is_required():
                value = field.get_default(call_default_factory=True)
        out.append(
            ConfigField(
                name=name,
                env=f"{prefix}{name}".upper(),
                label=field.title or name.replace("_", " ").capitalize(),
                secret=secret,
                required=field.is_required(),
                set=is_set,
                value=value,
            )
        )
    return out


def apply_setting_defaults(
    spec: ProviderSpec, settings: Settings, config: BaseSettings | None
) -> Settings:
    """`settings` with the provider's `setting_defaults` for every field the user did not
    set (env, `.env` or constructor): what is set always wins."""
    updates = dict(spec.setting_defaults(config))
    unknown = updates.keys() - Settings.model_fields.keys()
    if unknown:
        raise ValueError(f"{spec.id}: setting_defaults names unknown settings {sorted(unknown)}")
    updates = {k: v for k, v in updates.items() if k not in settings.model_fields_set}
    return settings.model_copy(update=updates) if updates else settings


def budget_of(settings: Settings) -> Budget:
    """The request budget the guard runs with under `settings`."""
    return Budget(
        rate_per_min=settings.upstream_rate_per_min,
        burst=settings.upstream_burst,
        daily=settings.upstream_daily_limit or None,
    )


def _yahoo(settings: Settings, _: BaseSettings | None) -> MarketDataProvider:
    from .yahoo import YahooProvider

    return YahooProvider(
        retries=settings.upstream_retries,
        rate_limit_retries=settings.upstream_rate_limit_retries,
        quote_v7_retry_s=settings.quote_v7_retry_s,
    )


def _yahoo_live(_: MarketDataProvider, __: BaseSettings | None) -> LiveSource | None:
    from .yahoo_live import YahooLiveSource

    return YahooLiveSource()


def _demo(_: Settings, __: BaseSettings | None) -> MarketDataProvider:
    from .demo import DemoProvider

    return DemoProvider()


def _demo_live(provider: MarketDataProvider, _: BaseSettings | None) -> LiveSource | None:
    from .demo import DemoLiveSource, DemoProvider

    assert isinstance(provider, DemoProvider)
    return DemoLiveSource(provider)


def _twelvedata(settings: Settings, config: BaseSettings | None) -> MarketDataProvider:
    assert isinstance(config, TwelveDataConfig)
    # A deep history call may page as far as the per-minute burst pays for (one credit each),
    # keeping one credit of it for the user's other requests.
    return TwelveDataProvider(config, max_pages=max(1, settings.upstream_burst - 1))


def _twelvedata_capabilities(config: BaseSettings | None) -> Capabilities:
    return capabilities_for(effective_profile(config))


def _twelvedata_costs(config: BaseSettings | None) -> CostModel:
    return costs_for(effective_profile(config))


def _twelvedata_defaults(config: BaseSettings | None) -> Mapping[str, Any]:
    return setting_defaults_for(effective_profile(config))


def _twelvedata_plan(config: BaseSettings | None) -> str | None:
    return config.plan if isinstance(config, TwelveDataConfig) else "basic"


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
    "twelvedata": ProviderSpec(
        id="twelvedata",
        name="Twelve Data",
        description=(
            "US stocks, ETFs, forex and crypto from the Twelve Data API (non-US exchanges "
            "from the Grow plan). Needs an API key; credits are metered per plan."
        ),
        network=True,
        terms=(
            "Needs a Twelve Data API key (TWELVEDATA_API_KEY) and follows your plan's credits "
            "(Basic: 8 per minute, 800 per day). Check the plan's terms before sharing data."
        ),
        probe_symbol="AAPL",
        make=_twelvedata,
        config=TwelveDataConfig,
        capabilities=_twelvedata_capabilities,
        costs=_twelvedata_costs,
        setting_defaults=_twelvedata_defaults,
        plan=_twelvedata_plan,
        self_paging=True,
    ),
}
