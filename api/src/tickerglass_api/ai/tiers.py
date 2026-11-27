"""Capability tiers of chat models (docs/design/local-ai.md §8).

Small models follow a strict script and a short tool list well and get lost with more; large
and cloud models do better with freedom and every tool. A model's tier picks both the system
prompt and the chart tools it may use. The tier comes from the model's size unless an admin set
one for that model. The server enforces the tool list; the browser only offers what fits.
"""

import re
from dataclasses import replace
from typing import Literal

from .base import ModelInfo

Tier = Literal["basic", "standard", "full"]
TIERS: tuple[Tier, ...] = ("basic", "standard", "full")

#: Parameter counts (billions) where the next tier starts.
STANDARD_FROM_B = 14.0
FULL_FROM_B = 60.0

BASIC_TOOLS = frozenset(
    {
        "list_indicators",
        "add_indicator",
        "remove_indicator",
        "get_fundamentals",
        "find_swings",
        "find_divergences",
        "draw_divergence",
        "find_levels",
        "draw_level",
        "draw_trend_line",
        "draw_horizontal_line",
        "clear_ai_drawings",
    }
)
STANDARD_TOOLS = BASIC_TOOLS | {"search_indicators", "draw"}
FULL_TOOLS = STANDARD_TOOLS | {
    "list_drawings",
    "update_drawing",
    "remove_drawing",
    "edit_indicator",
    "set_chart",
    "get_bars",
    "get_events",
    "get_news",
}
TIER_TOOLS: dict[Tier, frozenset[str]] = {
    "basic": BASIC_TOOLS,
    "standard": STANDARD_TOOLS,
    "full": FULL_TOOLS,
}

_SIZE = re.compile(r"^\s*(?:(\d+)\s*[xX]\s*)?(\d+(?:\.\d+)?)\s*([KMBT])?\s*$")
_SCALE = {"K": 1e-6, "M": 1e-3, "B": 1.0, "T": 1e3, None: 1e-9}


def parse_billions(size: str | None) -> float | None:
    """`26.1B` -> 26.1, `671B` -> 671, `8x7B` -> 56 (total parameters of a mixture), `567M` ->
    0.567; None when missing or unreadable."""
    if not size:
        return None
    m = _SIZE.match(size)
    if not m:
        return None
    experts = int(m.group(1)) if m.group(1) else 1
    unit = m.group(3).upper() if m.group(3) else None
    value = experts * float(m.group(2)) * _SCALE[unit]
    return value if value > 0 else None


def auto_tier(parameter_size: str | None, cloud: bool = False) -> Tier:
    """Cloud models are Full; local ones by size; an unknown size is Standard."""
    if cloud:
        return "full"
    b = parse_billions(parameter_size)
    if b is None:
        return "standard"
    if b >= FULL_FROM_B:
        return "full"
    return "standard" if b >= STANDARD_FROM_B else "basic"


def is_tier(value: object) -> bool:
    return value in TIERS


def with_tiers(models: list[ModelInfo], overrides: dict[str, str] | None) -> list[ModelInfo]:
    """`models` with the tier an admin set for them, else the automatic one."""
    out: list[ModelInfo] = []
    for m in models:
        wanted = (overrides or {}).get(m.name)
        tier: Tier = wanted if is_tier(wanted) else auto_tier(m.parameter_size, m.cloud)  # type: ignore[assignment]
        out.append(m if m.tier == tier else replace(m, tier=tier))
    return out


def tool_names(tools: list[dict[str, object]]) -> list[str]:
    """Function names of Ollama/OpenAI tool schemas."""
    names: list[str] = []
    for t in tools:
        fn = t.get("function")
        name = fn.get("name") if isinstance(fn, dict) else None
        names.append(str(name) if name else "")
    return names
