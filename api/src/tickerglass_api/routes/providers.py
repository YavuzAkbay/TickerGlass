"""The market data provider this API runs on, and a connection test (first-run setup)."""

import time
from typing import TYPE_CHECKING, Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ValidationError
from pydantic_settings import BaseSettings

from ..providers.base import ProviderError, ProviderNotConfigured, as_metered
from ..providers.registry import (
    PROVIDERS,
    ProviderSpec,
    apply_setting_defaults,
    budget_of,
    config_fields,
    load_config,
)
from ..settings import Settings
from ..stack import SwitchRefused

if TYPE_CHECKING:
    from ..app import ProviderRuntime

router = APIRouter(prefix="/providers", tags=["providers"])


def _config_of(spec: ProviderSpec, runtime: "ProviderRuntime") -> BaseSettings | None:
    """Config of `spec`; the active provider's is already loaded. A provider that is not
    running never fails the listing: missing or invalid settings read as unset."""
    if runtime.spec is not None and runtime.spec.id == spec.id:
        config: BaseSettings | None = runtime.config
        return config
    try:
        return load_config(spec)
    except (ProviderNotConfigured, ValidationError):
        return None


def _describe(spec: ProviderSpec, runtime: "ProviderRuntime") -> dict[str, Any]:
    """What the app shows of a provider. Config values of secrets are never included."""
    config = _config_of(spec, runtime)
    settings: Settings = apply_setting_defaults(spec, runtime.user_settings, config)
    budget = budget_of(settings)
    return {
        "id": spec.id,
        "name": spec.name,
        "description": spec.description,
        "network": spec.network,
        "terms": spec.terms,
        "configured": spec.config is None or config is not None,
        "capabilities": spec.capabilities(config).to_json(),
        "costs": spec.costs(config).to_json(),
        "budget": {
            "ratePerMin": budget.rate_per_min,
            "burst": budget.burst,
            "daily": budget.daily,
        },
        "config": [f.to_json() for f in config_fields(spec, config)],
        "plan": spec.plan(config),
    }


def providers_payload(app_state: Any) -> dict[str, Any]:
    """Every provider this build knows; `active` is the one in use (None for a custom one).
    `switchable`: the app may switch providers; `selectedBy`: who chose the active one."""
    runtime: ProviderRuntime = app_state.runtime
    spec: ProviderSpec | None = runtime.spec
    settings: Settings = runtime.settings
    snap = runtime.guard.snapshot()
    calibrated: bool = snap["calibrated"]
    # What the guard runs with now: after calibration that is what the upstream reported.
    daily = snap["daily"]["limit"] if snap["daily"] else None
    return {
        "active": spec.id if spec else None,
        "setting": "MARKET_PROVIDER",
        "switchable": app_state.switcher.switching_enabled and spec is not None,
        "selectedBy": app_state.market_stack.selected_by,
        "providers": [_describe(p, runtime) for p in PROVIDERS.values()],
        "activeCapabilities": runtime.capabilities.to_json(),
        "effectiveLimits": {
            "creditsPerMin": snap["ratePerMin"] if calibrated else runtime.budget.rate_per_min,
            "dailyCredits": daily if calibrated else runtime.budget.daily,
            "quoteTtlS": settings.quote_ttl_s,
            "pollIntervalS": settings.live_poll_interval_s,
            "source": "calibrated" if calibrated else runtime.limits_source,
        },
    }


@router.get("")
def providers(request: Request) -> dict[str, Any]:
    return providers_payload(request.app.state)


class ActiveProvider(BaseModel):
    id: str


@router.post("/active", response_model=None)
async def set_active(body: ActiveProvider, request: Request) -> dict[str, Any] | JSONResponse:
    """Switch the app to another provider (clears the market data cache); answers like
    `GET /providers`. A refused switch answers `{detail, code, ...}` with its status."""
    try:
        await request.app.state.switcher.switch(body.id)
    except SwitchRefused as exc:
        return JSONResponse(
            {"detail": exc.detail, "code": exc.code, **exc.extra},
            status_code=exc.status,
            headers=exc.headers,
        )
    return providers_payload(request.app.state)


@router.get("/usage")
def usage(request: Request) -> dict[str, Any]:
    """Credits left in the guard's budget, for the budget bar and the "exhausted" notice.
    Read from the guard's own accounting: never an upstream request (and no credits)."""
    runtime: ProviderRuntime = request.app.state.runtime
    spec: ProviderSpec | None = runtime.spec
    snap = runtime.guard.snapshot()
    daily = snap["daily"]
    return {
        "plan": spec.plan(runtime.config) if spec else None,
        # Only a provider with credits to run out of is polled for its usage.
        "metered": (
            daily is not None
            or runtime.limits_source == "plan"
            or snap["calibrated"]
            or as_metered(runtime.provider.inner) is not None
        ),
        "minute": {"limit": round(snap["ratePerMin"]), "left": max(0, int(snap["tokens"]))},
        "daily": (
            {"limit": daily["limit"], "used": daily["used"], "resetAt": daily["resetAt"]}
            if daily
            else None
        ),
        "state": snap["state"],
        "retryAfterS": snap["retryAfterS"],
    }


@router.post("/test")
def test_connection(request: Request) -> dict[str, Any]:
    """Ask the active provider for one quote, through the upstream guard (counts as one request)."""
    spec: ProviderSpec | None = request.app.state.provider_spec
    symbol = spec.probe_symbol if spec else "SPY"
    started = time.perf_counter()
    try:
        rows = request.app.state.provider.quotes([symbol])
    except ProviderNotConfigured as exc:
        return {"ok": False, "symbol": symbol, "error": str(exc), "code": "not_configured"}
    except ProviderError as exc:
        return {"ok": False, "symbol": symbol, "error": str(exc) or type(exc).__name__}
    latency = round((time.perf_counter() - started) * 1000)
    row = next((r for r in rows if r.get("symbol") == symbol), None)
    if row is None or row.get("last") is None:
        return {"ok": False, "symbol": symbol, "error": f"No quote for {symbol}"}
    return {"ok": True, "symbol": symbol, "price": row["last"], "latencyMs": latency}
