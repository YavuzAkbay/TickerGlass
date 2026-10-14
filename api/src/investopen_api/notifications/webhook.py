"""Webhook transport (stdlib `urllib`), hardened against SSRF.

Per-alert and test-endpoint URLs are user-supplied and the API is unauthenticated, so unless
`ALERTS_WEBHOOK_ALLOW_PRIVATE` is set the destination must resolve only to public addresses.
The check runs at validation time (`check_url`) and again at send time; at send time the
connection is additionally pinned to the validated address, so a DNS rebind between check and
connect cannot slip through. Redirects are never followed. Error text handed back to callers is
generic; details go to the server log with the URL masked.
"""

import hashlib
import hmac
import http.client
import ipaddress
import logging
import socket
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from . import DeliveryError, mask_url

log = logging.getLogger(__name__)

TIMEOUT_S = 10.0
BLOCKED = "destination not allowed"

IP = ipaddress.IPv4Address | ipaddress.IPv6Address


def _blocked(ip: IP) -> bool:
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    return (
        ip.is_loopback
        or ip.is_link_local
        or ip.is_private
        or ip.is_unspecified
        or ip.is_multicast
        or ip.is_reserved
        or not ip.is_global  # also covers e.g. carrier-grade NAT 100.64.0.0/10
    )


def _resolve(host: str, port: int) -> list[IP]:
    """All addresses of `host` (a test seam, replaced in the suite)."""
    infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    return [ipaddress.ip_address(str(i[4][0]).partition("%")[0]) for i in infos]


def _public_addresses(host: str, port: int, allow_private: bool) -> list[IP]:
    try:
        addrs = _resolve(host, port)
    except (OSError, ValueError) as exc:
        log.warning("webhook host %r did not resolve: %s", host, exc)
        raise DeliveryError("host did not resolve", retryable=False) from None
    if not addrs:
        raise DeliveryError("host did not resolve", retryable=False)
    if not allow_private and any(_blocked(a) for a in addrs):
        log.warning("webhook host %r resolves to a non-public address; refused", host)
        raise DeliveryError(BLOCKED, retryable=False)
    return addrs


def check_url(url: str, allow_private: bool) -> None:
    """Raise a permanent `DeliveryError` unless `url` is an http(s) URL to an allowed host."""
    try:
        parts = urllib.parse.urlsplit(url)
        host, port = parts.hostname, parts.port
    except ValueError:
        raise DeliveryError("invalid URL", retryable=False) from None
    if parts.scheme not in ("http", "https") or not host:
        raise DeliveryError("invalid URL", retryable=False)
    _public_addresses(host, port or (443 if parts.scheme == "https" else 80), allow_private)


def _pinned_connect(allow_private: bool) -> Any:
    def create(
        address: tuple[str, int], timeout: float | None = None, source_address: Any = None
    ) -> socket.socket:
        host, port = address
        last: OSError | None = None
        for ip in _public_addresses(host, port, allow_private):
            try:
                return socket.create_connection((str(ip), port), timeout, source_address)
            except OSError as exc:
                last = exc
        raise last or OSError("no address")

    return create


class _HTTPConn(http.client.HTTPConnection):
    allow_private = False

    def __init__(self, *a: Any, **kw: Any) -> None:
        super().__init__(*a, **kw)
        self._create_connection = _pinned_connect(self.allow_private)


class _HTTPSConn(http.client.HTTPSConnection):
    allow_private = False

    def __init__(self, *a: Any, **kw: Any) -> None:
        super().__init__(*a, **kw)
        self._create_connection = _pinned_connect(self.allow_private)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """A 3xx is surfaced as an `HTTPError` (a redirect could point at an internal address)."""

    def redirect_request(self, *a: Any, **kw: Any) -> None:
        return None


def _build_opener(allow_private: bool) -> urllib.request.OpenerDirector:
    http_conn = type("HTTPConn", (_HTTPConn,), {"allow_private": allow_private})
    https_conn = type("HTTPSConn", (_HTTPSConn,), {"allow_private": allow_private})

    class H(urllib.request.HTTPHandler):
        def http_open(self, req: urllib.request.Request) -> http.client.HTTPResponse:
            return self.do_open(http_conn, req)  # type: ignore[arg-type]

    class S(urllib.request.HTTPSHandler):
        def https_open(self, req: urllib.request.Request) -> http.client.HTTPResponse:
            return self.do_open(https_conn, req)  # type: ignore[arg-type]

    return urllib.request.build_opener(H, S, _NoRedirect)


def send(
    url: str,
    body: bytes,
    content_type: str,
    *,
    secret: str | None = None,
    timeout: float = TIMEOUT_S,
    allow_private: bool = False,
) -> None:
    """POST `body`; raises `DeliveryError` (4xx other than 408/429 is permanent).

    `allow_private=False` refuses non-public destinations (see module docstring).
    """
    check_url(url, allow_private)
    headers = {"Content-Type": content_type, "User-Agent": "InvestOpen-Alerts"}
    if secret:
        digest = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
        headers["X-InvestOpen-Signature"] = f"sha256={digest}"
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with _build_opener(allow_private).open(req, timeout=timeout) as resp:
            resp.read()
    except urllib.error.HTTPError as exc:
        permanent = 400 <= exc.code < 500 and exc.code not in (408, 429)
        raise DeliveryError(f"HTTP {exc.code}", retryable=not permanent) from exc
    except DeliveryError:
        raise
    except (urllib.error.URLError, OSError, ValueError) as exc:
        log.warning("webhook %s failed: %s: %s", mask_url(url), type(exc).__name__, exc)
        # Generic text only: the specific error would be a port-scan oracle for the caller.
        raise DeliveryError("delivery failed") from None
