"""Webhook transport (stdlib `urllib`)."""

import hashlib
import hmac
import urllib.error
import urllib.request

from . import DeliveryError

TIMEOUT_S = 10.0


def send(
    url: str,
    body: bytes,
    content_type: str,
    *,
    secret: str | None = None,
    timeout: float = TIMEOUT_S,
) -> None:
    """POST `body`; raises `DeliveryError` (4xx other than 408/429 is permanent)."""
    headers = {"Content-Type": content_type, "User-Agent": "InvestOpen-Alerts"}
    if secret:
        digest = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
        headers["X-InvestOpen-Signature"] = f"sha256={digest}"
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            resp.read()
    except urllib.error.HTTPError as exc:
        permanent = 400 <= exc.code < 500 and exc.code not in (408, 429)
        raise DeliveryError(f"HTTP {exc.code}", retryable=not permanent) from exc
    except (urllib.error.URLError, OSError, ValueError) as exc:
        # ValueError: malformed URL; retried anyway, it ends as `failed` after 5 attempts.
        raise DeliveryError(f"{type(exc).__name__}: {exc}") from exc
