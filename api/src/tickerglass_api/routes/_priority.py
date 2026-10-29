"""Upstream priority a client may ask for on the routes that default to `interactive`.

`X-TickerGlass-Priority: visible | background` lets a caller that is not a user waiting on
a chart (the alerts service reloading series, say) make its upstream calls yield to the
user's: see `UpstreamGuard.priority`. Anything else, or no header, is the route's default
(`interactive`); `prefetch` is not offered.
"""

from typing import Annotated

from fastapi import Depends, Header

from ..providers.guard import Priority

PRIORITY_HEADER = "X-TickerGlass-Priority"
_ASKABLE: tuple[Priority, ...] = ("visible", "background")


def request_priority(
    x_tickerglass_priority: Annotated[str | None, Header()] = None,
) -> Priority:
    level = (x_tickerglass_priority or "").strip().lower()
    for askable in _ASKABLE:
        if level == askable:
            return askable
    return "interactive"


PriorityDep = Annotated[Priority, Depends(request_priority)]
