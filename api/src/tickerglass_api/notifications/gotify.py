"""Gotify transport (docs/design/notify-channels.md): `POST <GOTIFY_URL>/message`.

The application token travels in the `X-Gotify-Key` header, never in the query string.
"""

import json

from ..settings import Settings
from . import DeliveryError, webhook

TIMEOUT_S = 10.0


def send(settings: Settings, title: str, body: str, *, timeout: float = TIMEOUT_S) -> None:
    if not (settings.gotify_url and settings.gotify_token):
        raise DeliveryError("not configured", retryable=False)
    payload = {"title": title, "message": body, "priority": settings.gotify_priority}
    webhook.post(
        f"{settings.gotify_url.strip().rstrip('/')}/message",
        json.dumps(payload).encode(),
        "application/json",
        headers={"X-Gotify-Key": settings.gotify_token},
        timeout=timeout,
        allow_private=True,
    )
