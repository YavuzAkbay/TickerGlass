"""Minimal JSON-over-HTTP client for providers (stdlib `urllib`; httpx is not a dependency).

`JsonHttp.get` maps every failure to the provider error hierarchy, so provider code only
deals with decoded JSON:

- connection failure or timeout -> `UpstreamUnavailable`;
- 429 -> `HttpRateLimited` (a `RateLimited`; `Retry-After` honored, else a minute);
- 5xx -> `UpstreamUnavailable`;
- other non-2xx (3xx are never followed) -> `HttpStatusError` (a `ProviderError`);
- a body that is not JSON -> `ProviderError`.

Credentials belong in `headers` (e.g. `Authorization: apikey <key>`), never in the URL.
Error messages and logs name the host and path only, never the query string.
"""

import json
import logging
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Mapping
from email.utils import parsedate_to_datetime
from typing import Any

from .. import __version__
from .base import ProviderError, RateLimited, UpstreamUnavailable

log = logging.getLogger(__name__)

#: (url, request headers, timeout seconds) -> (status, response headers, body). Raises
#: `OSError` (incl. `urllib.error.URLError`, timeouts) when no response arrived; every HTTP
#: status, errors included, is returned.
Send = Callable[[str, Mapping[str, str], float], tuple[int, Mapping[str, str], bytes]]

#: Seconds to back off after a 429 without a usable `Retry-After`.
DEFAULT_RETRY_AFTER_S = 60
#: Responses larger than this are refused.
MAX_BODY_BYTES = 32 * 1024 * 1024


class HttpStatusError(ProviderError):
    """The upstream answered with an unexpected status; `body` is its decoded JSON error
    payload when it sent one (providers read their error codes from it)."""

    def __init__(self, message: str, status: int, body: Any = None) -> None:
        super().__init__(message)
        self.status = status
        self.body = body


class HttpRateLimited(RateLimited):
    """429 from the upstream; `body` as in `HttpStatusError` (it may tell a daily limit
    from a per-minute one, which the provider then re-raises as `RateLimited(daily=True)`)."""

    def __init__(self, message: str, retry_after: int, body: Any = None) -> None:
        super().__init__(message, retry_after)
        self.body = body


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Redirects would carry the credential headers along to wherever they point."""

    def redirect_request(self, *args: Any, **kwargs: Any) -> None:
        return None


_OPENER = urllib.request.build_opener(_NoRedirect)


def urllib_send(
    url: str, headers: Mapping[str, str], timeout: float
) -> tuple[int, Mapping[str, str], bytes]:
    """The default `Send`: one GET through `urllib`, redirects not followed."""
    request = urllib.request.Request(url, headers=dict(headers), method="GET")
    try:
        with _OPENER.open(request, timeout=timeout) as resp:
            status, head = resp.status, resp.headers
            body = resp.read(MAX_BODY_BYTES + 1)
    except urllib.error.HTTPError as exc:
        status, head = exc.code, exc.headers
        try:
            body = exc.read(MAX_BODY_BYTES + 1)
        except OSError:
            body = b""
    if len(body) > MAX_BODY_BYTES:
        raise ProviderError("response too large")
    return status, {k.lower(): v for k, v in head.items()}, body


def _retry_after(headers: Mapping[str, str]) -> int:
    raw = headers.get("retry-after")
    if raw is None:
        return DEFAULT_RETRY_AFTER_S
    try:
        seconds = float(raw)
    except ValueError:
        try:
            seconds = parsedate_to_datetime(raw).timestamp() - time.time()
        except (TypeError, ValueError):
            return DEFAULT_RETRY_AFTER_S
    return max(1, int(seconds + 0.999))


def _decode(body: bytes) -> Any:
    """Decoded JSON, or None when the body is empty or not JSON."""
    try:
        return json.loads(body)
    except ValueError:
        return None


class JsonHttp:
    def __init__(
        self,
        base_url: str,
        *,
        send: Send | None = None,
        timeout_s: float = 15,
        headers: Mapping[str, str] | None = None,
        on_headers: Callable[[Mapping[str, str]], None] | None = None,
    ) -> None:
        """`on_headers` sees the (lower-cased) response headers of every response, errors
        included, before the status is judged."""
        scheme = urllib.parse.urlsplit(base_url).scheme
        if scheme not in ("http", "https"):
            raise ValueError(f"base_url must be http(s), got {base_url!r}")
        self._base = base_url.rstrip("/")
        self._send: Send = send or urllib_send
        self._timeout_s = timeout_s
        self._headers: dict[str, str] = {
            "Accept": "application/json",
            "User-Agent": f"TickerGlass/{__version__}",
            **(headers or {}),
        }
        self._on_headers = on_headers

    def get(self, path: str, params: Mapping[str, str]) -> Any:
        """GET `base_url/path?params` and return the decoded JSON body."""
        path = "/" + path.lstrip("/")
        url = f"{self._base}{path}"
        if params:
            url += "?" + urllib.parse.urlencode(params)
        where = f"{urllib.parse.urlsplit(self._base).netloc}{urllib.parse.urlsplit(url).path}"
        try:
            status, headers, body = self._send(url, self._headers, self._timeout_s)
        except ProviderError:
            raise
        except OSError as exc:  # URLError, timeouts, connection resets
            log.debug("request to %s failed: %s", where, type(exc).__name__)
            raise UpstreamUnavailable(f"{where}: {type(exc).__name__}") from None
        headers = {k.lower(): v for k, v in headers.items()}
        if self._on_headers is not None:
            try:
                self._on_headers(headers)
            except Exception:
                log.warning("response header handler failed for %s", where, exc_info=True)
        if status == 429:
            raise HttpRateLimited(
                f"{where}: rate limited (HTTP 429)", _retry_after(headers), _decode(body)
            )
        if status >= 500:
            raise UpstreamUnavailable(f"{where}: HTTP {status}")
        if not 200 <= status < 300:
            raise HttpStatusError(f"{where}: HTTP {status}", status, _decode(body))
        try:
            return json.loads(body)
        except ValueError:
            raise ProviderError(f"{where}: response is not valid JSON") from None
