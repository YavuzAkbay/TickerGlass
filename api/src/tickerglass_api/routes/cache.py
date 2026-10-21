from typing import Any

from fastapi import APIRouter

from ..deps import CacheStatsDep, UpstreamGuardDep

router = APIRouter(prefix="/cache", tags=["cache"])


@router.get("/stats")
def stats(cache_stats: CacheStatsDep, guard: UpstreamGuardDep) -> dict[str, Any]:
    """Upstream calls per provider op, the guard's budget/cooldown state and bar cache ops."""
    tree = cache_stats.snapshot()
    return {
        **tree,
        "upstream": tree.get("upstream", {}),
        "bars": tree.get("bars", {}),
        "guard": guard.snapshot(),
    }
