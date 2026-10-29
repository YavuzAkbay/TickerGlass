"""The provider-dependent part of the app, built as one unit so it can be swapped.

A `MarketStack` is the active provider's runtime plus everything built on it: the symbol,
bar and market services, the refresher pool and the cache maintenance. `build_stack` wires
it, `install` publishes it on `app.state`, and `ProviderSwitcher` replaces the installed one
at runtime: the new stack's services write the cache under a new generation of the
`CacheGate`, so requests still running on the old stack cannot put its provider's data into
the cache the switch has just wiped. The live hub, dispatcher, alerts state and user data
are not part of the stack and survive a switch.
"""

import asyncio
import logging
import math
import threading
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import timedelta
from typing import Any, Literal

from fastapi import FastAPI
from pydantic_settings import BaseSettings
from sqlalchemy import Engine

from .live import LiveHub, LiveSource, Poller, market_poller
from .providers.base import (
    Budget,
    Capabilities,
    CostModel,
    MarketDataProvider,
    ProviderNotConfigured,
    as_metered,
)
from .providers.guard import GuardedProvider, UpstreamGuard
from .providers.registry import (
    PROVIDERS,
    ProviderSpec,
    UnconfiguredProvider,
    apply_setting_defaults,
    budget_of,
    is_configured,
    load_config,
    missing_config,
)
from .services.bars import BarService, TailPolicy
from .services.cache_gate import CacheGate
from .services.cache_source import ensure_cache_source
from .services.maintenance import CacheMaintenance
from .services.market import MarketService
from .services.provider_choice import ProviderChoice, SelectedBy, save_provider_choice
from .services.stats import CacheStats
from .services.symbols import SymbolService
from .settings import Settings

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class ProviderRuntime:
    """The active provider as the app runs it."""

    #: None for a custom provider passed to `create_app` (tests).
    spec: ProviderSpec | None
    #: The settings as the user gave them, and with the provider's defaults filled in
    #: (what every service is built from).
    user_settings: Settings
    settings: Settings
    #: None without a config model, or with required settings missing.
    config: BaseSettings | None
    #: Every call goes through this guard-wrapped provider.
    provider: GuardedProvider
    guard: UpstreamGuard
    capabilities: Capabilities
    costs: CostModel
    budget: Budget
    #: Where `budget` comes from: the provider's plan, or the settings/defaults.
    limits_source: Literal["plan", "env"]
    live_source: LiveSource | None


def build_runtime(
    spec: ProviderSpec | None,
    settings: Settings,
    stats: CacheStats,
    *,
    provider: MarketDataProvider | None = None,
    live_source: LiveSource | None = None,
) -> ProviderRuntime:
    """Build the provider of `spec` (or wrap the custom `provider` when there is no spec)
    with its config, defaults, costs, capabilities and the upstream guard. A provider with
    required settings missing is replaced by one failing with `ProviderNotConfigured`."""
    config: BaseSettings | None = None
    inner: MarketDataProvider
    effective = settings
    capabilities, costs = Capabilities.full(), CostModel()
    plan: str | None = None
    live: LiveSource | None = live_source
    if spec is None:
        assert provider is not None
        inner = provider
        if live is None:
            # A custom provider (tests) has no spec: Yahoo's relay, as before.
            make_yahoo_live = PROVIDERS["yahoo"].make_live
            live = make_yahoo_live(inner, None) if make_yahoo_live else None
    else:
        try:
            config = load_config(spec)
            missing: ProviderNotConfigured | None = None
        except ProviderNotConfigured as exc:
            missing = exc
        effective = apply_setting_defaults(spec, settings, config)
        capabilities, costs, plan = spec.capabilities(config), spec.costs(config), spec.plan(config)
        if missing is not None:
            inner = UnconfiguredProvider(str(missing))
        else:
            inner = spec.make(effective, config)
            if live is None and spec.make_live is not None:
                live = spec.make_live(inner, config)
    budget = budget_of(effective)
    # Every upstream call (services and the live poller) goes through one guard.
    # What the user set explicitly is never overridden by the upstream's reported limits.
    guard = UpstreamGuard(
        rate_per_min=budget.rate_per_min,
        burst=budget.burst,
        daily_limit=budget.daily,
        calibrate_rate="upstream_rate_per_min" not in settings.model_fields_set,
        calibrate_daily="upstream_daily_limit" not in settings.model_fields_set,
        cooldown_initial_s=effective.upstream_cooldown_initial_s,
        cooldown_max_s=effective.upstream_cooldown_max_s,
        unavailable_cooldown_s=effective.upstream_unavailable_cooldown_s,
    )
    user_set = {"upstream_rate_per_min", "upstream_burst"} & settings.model_fields_set
    return ProviderRuntime(
        spec=spec,
        user_settings=settings,
        settings=effective,
        config=config,
        provider=GuardedProvider(inner, guard, stats, costs=costs, capabilities=capabilities),
        guard=guard,
        capabilities=capabilities,
        costs=costs,
        budget=budget,
        limits_source="plan" if plan is not None and not user_set else "env",
        live_source=live,
    )


def _poll_pacer(guard: UpstreamGuard, costs: CostModel) -> Callable[[int], float]:
    """Fewest seconds between polls of a symbol while `n` are polled: polling may use at
    most half of the credits the guard can sustain (the rest is for the user's requests)."""

    def pace(n: int) -> float:
        rate = guard.sustainable_rate_per_min()
        if rate <= 0:
            return 3600.0  # daily credits gone; the interval is recomputed every round
        return costs.quotes(n) * 60 / (0.5 * rate)

    return pace


def _seed_usage(provider: GuardedProvider) -> None:
    """Calibrate the guard with the upstream's own credit count (runs on a thread: it is a
    network call). Failure only means the count starts from zero."""
    try:
        provider.seed_usage()
    except Exception as exc:
        log.warning("could not read upstream credit usage; counting from zero: %s", exc)


@dataclass(frozen=True)
class MarketStack:
    """The provider and every service built on it (see the module docstring)."""

    runtime: ProviderRuntime
    #: The `CacheGate` generation its services write the cache under.
    generation: int
    selected_by: SelectedBy
    #: Background refreshes of stale cache entries, shared by every in-memory cache.
    refresher: ThreadPoolExecutor
    symbol_service: SymbolService
    bar_service: BarService
    market_service: MarketService
    maintenance: CacheMaintenance
    #: See `_poll_pacer`.
    pace: Callable[[int], float]


def build_stack(
    spec: ProviderSpec | None,
    user_settings: Settings,
    *,
    engine: Engine,
    stats: CacheStats,
    gate: CacheGate,
    generation: int,
    hub: Callable[[], LiveHub],
    selected_by: SelectedBy,
    provider: MarketDataProvider | None = None,
    live_source: LiveSource | None = None,
    runtime: ProviderRuntime | None = None,
) -> MarketStack:
    """Build the provider (unless `runtime`, one built already, is given) and wire the
    services on it. `hub` is looked up lazily: the live hub is created after the stack
    and only the quote pacer needs it. Nothing runs yet (see `ProviderSwitcher`)."""
    if runtime is None:
        runtime = build_runtime(
            spec, user_settings, stats, provider=provider, live_source=live_source
        )
    eff = runtime.settings
    guard = runtime.guard
    prov = runtime.provider
    refresher = ThreadPoolExecutor(max_workers=2, thread_name_prefix="cache-refresh")
    symbol_service = SymbolService(
        engine,
        prov,
        settings=eff,
        stats=stats,
        refresher=refresher,
        background=guard.background,
        gate=gate,
        generation=generation,
    )
    # Bar tails follow the market session of the symbol's stored metadata.
    bar_service = BarService(
        engine,
        prov,
        stats=stats,
        session_lookup=symbol_service.cached_info,
        policy=TailPolicy.from_settings(eff),
        extended_history=runtime.capabilities.extended_history,
        self_paging=spec is not None and spec.self_paging,
        metadata_max_age=timedelta(seconds=eff.symbol_info_ttl_s),
        gate=gate,
        generation=generation,
    )
    pace = _poll_pacer(guard, runtime.costs)
    market_service = MarketService(
        prov,
        settings=eff,
        stats=stats,
        refresher=refresher,
        background=guard.background,
        session_lookup=symbol_service.cached_info,
        metadata_max_age=timedelta(seconds=eff.symbol_info_ttl_s),
        # A quote is never refreshed faster than the polls of the open symbols may be.
        quote_pacer=lambda: pace(hub().symbol_count()),
    )
    return MarketStack(
        runtime=runtime,
        generation=generation,
        selected_by=selected_by,
        refresher=refresher,
        symbol_service=symbol_service,
        bar_service=bar_service,
        market_service=market_service,
        maintenance=CacheMaintenance(engine, bar_service, eff, stats),
        pace=pace,
    )


def install(app: FastAPI, stack: MarketStack) -> None:
    """Publish `stack` on `app.state`: itself, and the pieces routes and deps read."""
    runtime = stack.runtime
    app.state.market_stack = stack
    app.state.runtime = runtime
    app.state.capabilities = runtime.capabilities
    app.state.upstream_guard = runtime.guard
    app.state.provider = runtime.provider
    app.state.provider_spec = runtime.spec
    app.state.symbol_service = stack.symbol_service
    app.state.bar_service = stack.bar_service
    app.state.market_service = stack.market_service
    app.state.cache_refresher = stack.refresher
    app.state.cache_maintenance = stack.maintenance
    app.state.settings = runtime.settings


def live_config(stack: MarketStack, poller: Poller | None) -> dict[str, Any]:
    """Keyword arguments of `LiveHub(...)` / `LiveHub.reconfigure(...)` for `stack`: its
    stream (None: polling only), `poller` (default: through the stack's quote cache) and the
    poll cadence of its settings."""
    runtime = stack.runtime
    eff = runtime.settings
    metered = as_metered(runtime.provider.inner) is not None
    return {
        "source": runtime.live_source,
        "poller": poller
        if poller is not None
        else market_poller(stack.market_service, runtime.guard),
        "poll_after_s": eff.live_poll_after_s,
        "poll_interval_s": eff.live_poll_interval_s,
        "poll_closed_interval_s": eff.live_poll_closed_interval_s,
        "poll_pacer": stack.pace,
        "closed_cap_s": eff.quote_closed_ttl_s if metered else None,
        "session_lookup": stack.symbol_service.cached_info,
        "metadata_max_age": timedelta(seconds=eff.symbol_info_ttl_s),
    }


class SwitchRefused(Exception):
    """A switch that was not carried out, with the HTTP answer for it."""

    def __init__(
        self,
        status: int,
        code: str,
        detail: str,
        *,
        headers: dict[str, str] | None = None,
        **extra: Any,
    ) -> None:
        super().__init__(detail)
        self.status = status
        self.code = code
        self.detail = detail
        #: Response headers (`Retry-After`).
        self.headers = headers or {}
        self.extra = extra


class ProviderSwitcher:
    """Replaces the installed `MarketStack` with another provider's, at runtime.

    One switch at a time (`lock`), and not within `cooldown_s` of the previous one (each
    switch wipes the cache and costs credits). A switch builds the new provider first (a
    failure there changes nothing), then advances the cache gate, wipes the cache for the new
    provider, installs the new stack, retires the old one and moves the live hub to the new
    upstream."""

    def __init__(
        self,
        app: FastAPI,
        engine: Engine,
        gate: CacheGate,
        stats: CacheStats,
        *,
        live_poller: Poller | None,
        switching_enabled: bool,
        cooldown_s: float = 0.0,
    ) -> None:
        self._app = app
        self._engine = engine
        self._gate = gate
        self._stats = stats
        self._live_poller = live_poller
        self.switching_enabled = switching_enabled
        self._cooldown_s = cooldown_s
        #: Monotonic time the last switch to another provider finished.
        self._last_switch: float | None = None
        self.lock = asyncio.Lock()
        self._closed = False

    @property
    def current(self) -> MarketStack:
        stack: MarketStack = self._app.state.market_stack
        return stack

    def _hub(self) -> LiveHub:
        hub: LiveHub = self._app.state.live_hub
        return hub

    async def switch(self, provider_id: str) -> MarketStack:
        """Run the app on `provider_id`; returns the stack now installed."""
        async with self.lock:
            current = self.current
            spec = self._check(provider_id, current)
            if spec is None:
                return current
            previous = current.runtime.spec
            assert previous is not None
            try:
                runtime = await asyncio.to_thread(
                    build_runtime, spec, current.runtime.user_settings, self._stats
                )
            except Exception as exc:
                log.exception("could not start provider %s", provider_id)
                raise SwitchRefused(
                    500, "switch_failed", f"could not start {spec.name}: {exc}"
                ) from exc
            # Advance before the wipe: writes of the old stack still in flight are refused
            # from here on, so none can land after the wipe.
            # (On a thread: `advance` waits for a commit in progress, which must not block
            # the event loop.)
            generation = await asyncio.to_thread(self._gate.advance)
            try:
                await asyncio.to_thread(self._record, provider_id, current.runtime.user_settings)
            except Exception as exc:
                log.exception("could not switch the cache to provider %s", provider_id)
                # The wipe is one transaction: the cache still holds the old provider's data.
                await self._activate(
                    current,
                    current.runtime,
                    generation,
                    current.selected_by,
                    reset_hub=False,
                )
                raise SwitchRefused(
                    503, "switch_failed", f"could not switch to {spec.name}: {exc}"
                ) from exc
            stack = await self._activate(
                current,
                runtime,
                generation,
                "ui",
                notice={"type": "provider.changed", "id": provider_id, "previous": previous.id},
            )
            self._last_switch = time.monotonic()
            log.warning("market data provider switched from %s to %s", previous.id, provider_id)
            return stack

    def _check(self, provider_id: str, current: MarketStack) -> ProviderSpec | None:
        """The spec to switch to; None when it is the active one. Raises `SwitchRefused`."""
        if self._closed:
            raise SwitchRefused(503, "shutting_down", "the API is shutting down")
        if not self.switching_enabled:
            raise SwitchRefused(
                403,
                "switching_disabled",
                "switching the data source is disabled (PROVIDER_SWITCHING)",
            )
        active = current.runtime.spec
        if active is None:
            raise SwitchRefused(409, "custom_provider", "the app runs a custom provider")
        spec = PROVIDERS.get(provider_id)
        if spec is None:
            raise SwitchRefused(422, "unknown_provider", f"unknown provider {provider_id!r}")
        if spec.id == active.id:
            return None
        if self._last_switch is not None:
            wait = self._last_switch + self._cooldown_s - time.monotonic()
            if wait > 0:
                retry_after = math.ceil(wait)
                raise SwitchRefused(
                    429,
                    "switch_cooldown",
                    f"the data source was switched a moment ago; retry in {retry_after}s",
                    headers={"Retry-After": str(retry_after)},
                )
        if not is_configured(spec):
            missing = missing_config(spec)
            raise SwitchRefused(
                409,
                "not_configured",
                f"{spec.name} is not configured: set {', '.join(missing)} and restart the API",
                missing=missing,
            )
        return spec

    def _record(self, provider_id: str, settings: Settings) -> None:
        """Wipe the cache for `provider_id` (a no-op when it already holds its data) and
        remember the choice for the next start. Blocking: runs on a worker thread.

        A choice that cannot be stored does not undo the switch (the cache already belongs
        to `provider_id`): the app runs on it until restart, then on `MARKET_PROVIDER`."""
        ensure_cache_source(self._engine, provider_id)
        try:
            save_provider_choice(
                self._engine, ProviderChoice(id=provider_id, env=settings.market_provider)
            )
        except Exception:
            log.exception(
                "could not store the chosen provider %s; it lasts until restart", provider_id
            )

    async def _activate(
        self,
        old: MarketStack,
        runtime: ProviderRuntime,
        generation: int,
        selected_by: SelectedBy,
        *,
        notice: dict[str, Any] | None = None,
        reset_hub: bool = True,
    ) -> MarketStack:
        """Build the stack of `runtime` under `generation`, install it, retire `old` and
        point the live hub at it. `reset_hub` false: `runtime` is the one `old` ran on, so
        the hub keeps its upstream and poll state and only gets the new stack's poller."""
        stack = build_stack(
            runtime.spec,
            runtime.user_settings,
            engine=self._engine,
            stats=self._stats,
            gate=self._gate,
            generation=generation,
            hub=self._hub,
            selected_by=selected_by,
            runtime=runtime,
        )
        install(self._app, stack)
        await self._retire(old)
        config = live_config(stack, self._live_poller)
        if reset_hub:
            await self._hub().reconfigure(**config, notice=notice)
        else:
            self._hub().set_poller(config["poller"], config["session_lookup"])
        # The guard of a kept runtime is seeded already.
        self._start(stack, seed=reset_hub)
        return stack

    @staticmethod
    async def _retire(stack: MarketStack) -> None:
        await stack.maintenance.stop()
        # Queued refreshes are dropped; a running one finishes on its own thread.
        stack.refresher.shutdown(wait=False, cancel_futures=True)

    def _start(self, stack: MarketStack, *, seed: bool = True) -> None:
        """Start the background work of `stack`: cache maintenance, and (`seed`) calibrating
        the guard from a metered upstream's own credit count."""
        if stack.runtime.settings.cache_maintenance_enabled:
            stack.maintenance.start()
        if seed and as_metered(stack.runtime.provider.inner) is not None:
            threading.Thread(
                target=_seed_usage,
                args=(stack.runtime.provider,),
                name="usage-seed",
                daemon=True,
            ).start()

    async def start_current(self) -> None:
        """Start the background work of the installed stack (app start-up)."""
        self._start(self.current)

    async def close(self) -> None:
        """Retire the installed stack (app shutdown); no switch can start afterwards."""
        async with self.lock:
            self._closed = True
            await self._retire(self.current)
