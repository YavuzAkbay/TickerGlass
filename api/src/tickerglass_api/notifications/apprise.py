"""Apprise API transport (docs/design/notify-channels.md), no Python `apprise` dependency.

`POST <APPRISE_URL>` (caronc/apprise-api `/notify` stateless or `/notify/<key>` stateful) with a
JSON body. `APPRISE_URLS` (target URLs, usually secret) only ever appears in that body.
"""

import json
import re

from ..settings import Settings
from . import DeliveryError, webhook

TIMEOUT_S = 10.0


def target_urls(raw: str | None) -> list[str]:
    return [u for u in re.split(r"[,\s]+", raw or "") if u]


def send(settings: Settings, title: str, body: str, *, timeout: float = TIMEOUT_S) -> None:
    if not settings.apprise_url:
        raise DeliveryError("not configured", retryable=False)
    payload: dict[str, object] = {"title": title, "body": body, "type": "info"}
    urls = target_urls(settings.apprise_urls)
    if urls:
        payload["urls"] = ",".join(urls)
    if settings.apprise_tag and settings.apprise_tag.strip():
        payload["tag"] = settings.apprise_tag.strip()
    webhook.post(
        settings.apprise_url.strip(),
        json.dumps(payload).encode(),
        "application/json",
        timeout=timeout,
        allow_private=True,
    )
