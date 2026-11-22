"""Minimal JSON-over-HTTP client for providers (stdlib `urllib`; httpx is not a dependency).

`JsonHttp.get` maps every failure to the provider error hierarchy, so provider code only
deals with decoded JSON:

- connection failure or timeout -> `UpstreamUnavailable`;
- 429 -> `HttpRateLimited` (a `RateLimited`; `Retry-After` honored, else a minute);
- 5xx -> `UpstreamUnavailable`;
- other non-2xx (3xx are never followed) -> `HttpStatusError` (a `ProviderError`);
- a body that is not JSON -> `ProviderError`.

`JsonHttp.get_text` is the same client for text bodies (Stooq's CSV).

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
from ..metrics import upstream
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


#: Hosts a provider's base URL may reach over plain http (a local test server or proxy).
LOCAL_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})


def require_https(url: str, setting: str) -> str:
    """`url` when it is an https URL, or an http one for a local host; else `ValueError`
    (meant for a config validator: the API key travels to this URL). The message never
    echoes the URL, which may carry credentials."""
    parts = urllib.parse.urlsplit(url.strip())
    scheme = parts.scheme.lower()
    host = (parts.hostname or "").lower()
    if host and (scheme == "https" or (scheme == "http" and host in LOCAL_HOSTS)):
        return url
    raise ValueError(
        f"{setting} must be an https:// URL with a host (plain http is accepted only for "
        "localhost, 127.0.0.1 and ::1)"
    )


def host_of(url: str) -> str:
    """The normalized `host[:port]` of a URL (lower case; no credentials, path, scheme or
    default port)."""
    parts = urllib.parse.urlsplit(url.strip())
    host = (parts.hostname or "").lower()
    try:
        port = parts.port
    except ValueError:
        port = None
    if port is None or port == {"https": 443, "http": 80}.get(parts.scheme.lower()):
        return host
    return f"{host}:{port}"


def overridden_host(url: str, default: str) -> str | None:
    """The host of `url` when it is not the host of `default` (a proxy, a mirror), else None.
    Used for a provider's cache identity: a default endpoint adds nothing to it."""
    host = host_of(url)
    return host if host and host != host_of(default) else None


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


#: Characters of an error answer kept in the exception's `body` by `JsonHttp.get_text`.
ERROR_TEXT_CHARS = 500


def _text_snippet(body: bytes) -> str:
    return body[: ERROR_TEXT_CHARS * 4].decode("utf-8", errors="replace")[:ERROR_TEXT_CHARS]


def _decode_text(body: bytes) -> str:
    return body.decode("utf-8-sig", errors="replace")


def _outcome(status: int) -> str:
    """The `tickerglass_provider_requests_total` outcome of an HTTP status."""
    if status == 429:
        return "rate_limited"
    if status >= 500:
        return "unavailable"
    return "ok" if 200 <= status < 300 else "error"


class JsonHttp:
    def __init__(
        self,
        base_url: str,
        *,
        send: Send | None = None,
        timeout_s: float = 15,
        headers: Mapping[str, str] | None = None,
        on_headers: Callable[[Mapping[str, str]], None] | None = None,
        provider: str = "other",
    ) -> None:
        """`on_headers` sees the (lower-cased) response headers of every response, errors
        included, before the status is judged. `provider` (a fixed id, never user input)
        labels the request counter."""
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
        self._provider = provider

    def get(self, path: str, params: Mapping[str, str]) -> Any:
        """GET `base_url/path?params` and return the decoded JSON body."""
        body, where = self._fetch(path, params, self._headers, _decode)
        try:
            return json.loads(body)
        except ValueError:
            raise ProviderError(f"{where}: response is not valid JSON") from None

    def get_text(
        self,
        path: str,
        params: Mapping[str, str],
        *,
        accept: str = "text/csv",
        classify: Callable[[str], str | None] | None = None,
    ) -> str:
        """GET `base_url/path?params` and return the body as text (CSV and the like). Same
        error mapping, redirect policy and request counting as `get`; the `body` of an
        `HttpStatusError` / `HttpRateLimited` is the first `ERROR_TEXT_CHARS` characters of
        the answer. The query string never appears in an error or log line, so a credential
        in it stays out of them.

        `classify` is for servers that answer errors with a 2xx status: it sees the body of a
        2xx answer before the request is counted and returns the outcome to count it under
        (`rate_limited`, `error`, ...), or None for a normal answer (`ok`)."""
        headers = {**self._headers, "Accept": f"{accept}, text/plain;q=0.9, */*;q=0.5"}
        body, _ = self._fetch(
            path,
            params,
            headers,
            _text_snippet,
            (lambda raw: classify(_decode_text(raw))) if classify is not None else None,
        )
        return _decode_text(body)

    def _fetch(
        self,
        path: str,
        params: Mapping[str, str],
        request_headers: Mapping[str, str],
        error_body: Callable[[bytes], Any],
        classify_ok: Callable[[bytes], str | None] | None = None,
    ) -> tuple[bytes, str]:
        """One GET: the body of a 2xx answer and `host/path` (for messages). `error_body`
        decodes the body of an error answer for the exception; `classify_ok` may count a 2xx
        answer under another outcome than `ok`."""
        path = "/" + path.lstrip("/")
        url = f"{self._base}{path}"
        if params:
            url += "?" + urllib.parse.urlencode(params)
        where = f"{urllib.parse.urlsplit(self._base).netloc}{urllib.parse.urlsplit(url).path}"
        try:
            status, headers, body = self._send(url, request_headers, self._timeout_s)
        except ProviderError:
            upstream.record(self._provider, "error")
            raise
        except OSError as exc:  # URLError, timeouts, connection resets
            upstream.record(self._provider, "unavailable")
            log.debug("request to %s failed: %s", where, type(exc).__name__)
            raise UpstreamUnavailable(f"{where}: {type(exc).__name__}") from None
        outcome = _outcome(status)
        if classify_ok is not None and outcome == "ok":
            outcome = classify_ok(body) or outcome
        upstream.record(self._provider, outcome)
        headers = {k.lower(): v for k, v in headers.items()}
        if self._on_headers is not None:
            try:
                self._on_headers(headers)
            except Exception:
                log.warning("response header handler failed for %s", where, exc_info=True)
        if status == 429:
            raise HttpRateLimited(
                f"{where}: rate limited (HTTP 429)", _retry_after(headers), error_body(body)
            )
        if status >= 500:
            raise UpstreamUnavailable(f"{where}: HTTP {status}")
        if not 200 <= status < 300:
            raise HttpStatusError(f"{where}: HTTP {status}", status, error_body(body))
        return body, where
