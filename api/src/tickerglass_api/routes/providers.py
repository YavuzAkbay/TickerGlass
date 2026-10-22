"""The market data provider this API runs on, and a connection test (first-run setup)."""

import time
from typing import Any

from fastapi import APIRouter, Request

from ..providers.base import ProviderError
from ..providers.registry import PROVIDERS, ProviderSpec

router = APIRouter(prefix="/providers", tags=["providers"])


def _describe(spec: ProviderSpec) -> dict[str, Any]:
    return {
        "id": spec.id,
        "name": spec.name,
        "description": spec.description,
        "network": spec.network,
        "terms": spec.terms,
    }


@router.get("")
def providers(request: Request) -> dict[str, Any]:
    """Every provider this build knows; `active` is the one in use (None for a custom one)."""
    spec: ProviderSpec | None = request.app.state.provider_spec
    return {
        "active": spec.id if spec else None,
        "setting": "MARKET_PROVIDER",
        "providers": [_describe(p) for p in PROVIDERS.values()],
    }


@router.post("/test")
def test_connection(request: Request) -> dict[str, Any]:
    """Ask the active provider for one quote, through the upstream guard (counts as one request)."""
    spec: ProviderSpec | None = request.app.state.provider_spec
    symbol = spec.probe_symbol if spec else "SPY"
    started = time.perf_counter()
    try:
        rows = request.app.state.provider.quotes([symbol])
    except ProviderError as exc:
        return {"ok": False, "symbol": symbol, "error": str(exc) or type(exc).__name__}
    latency = round((time.perf_counter() - started) * 1000)
    row = next((r for r in rows if r.get("symbol") == symbol), None)
    if row is None or row.get("last") is None:
        return {"ok": False, "symbol": symbol, "error": f"No quote for {symbol}"}
    return {"ok": True, "symbol": symbol, "price": row["last"], "latencyMs": latency}
