"""Telegram Bot API transport (stdlib `urllib`)."""

import json
import urllib.error
import urllib.request

from . import DeliveryError

TIMEOUT_S = 10.0
MAX_TEXT = 4096


def send(token: str, chat_id: str, text: str, *, timeout: float = TIMEOUT_S) -> None:
    """`sendMessage` as plain text. 429 honors `retry_after`; other 4xx (except 408) are permanent.

    Errors never include the URL (it contains the bot token).
    """
    payload = {"chat_id": chat_id, "text": text[:MAX_TEXT], "disable_web_page_preview": True}
    req = urllib.request.Request(
        f"https://api.telegram.org/bot{token}/sendMessage",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            resp.read()
    except urllib.error.HTTPError as exc:
        description, retry_after = _error_body(exc)
        message = f"Telegram HTTP {exc.code}" + (f": {description}" if description else "")
        if exc.code == 429:
            raise DeliveryError(message, retry_after=retry_after) from None
        permanent = 400 <= exc.code < 500 and exc.code != 408
        raise DeliveryError(message, retryable=not permanent) from None
    except (urllib.error.URLError, OSError) as exc:
        raise DeliveryError(f"{type(exc).__name__}: {exc}") from None


def _error_body(exc: urllib.error.HTTPError) -> tuple[str, float | None]:
    try:
        data = json.loads(exc.read())
    except (OSError, ValueError):
        return "", None
    if not isinstance(data, dict):
        return "", None
    params = data.get("parameters")
    raw = params.get("retry_after") if isinstance(params, dict) else None
    retry_after = float(raw) if isinstance(raw, int | float) and not isinstance(raw, bool) else None
    desc = data.get("description")
    return (desc if isinstance(desc, str) else ""), retry_after
