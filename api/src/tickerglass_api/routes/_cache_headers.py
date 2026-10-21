"""Cache-Control for market-data GET routes.

Routes take a `Response` parameter and call one of these on the success path only: an
error raised afterwards (HTTPException, provider errors) is rendered by a fresh response
that never carries the header. `private` keeps shared proxies out; there is no ETag.
"""

from fastapi import Response

NO_CACHE = "private, no-cache"


def max_age(seconds: int) -> str:
    return f"private, max-age={seconds}"


def set_max_age(response: Response, seconds: int) -> None:
    response.headers["Cache-Control"] = max_age(seconds)


def set_no_cache(response: Response) -> None:
    response.headers["Cache-Control"] = NO_CACHE
