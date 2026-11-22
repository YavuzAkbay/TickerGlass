"""ntfy transport (docs/design/notify-channels.md): JSON publish to the server root.

`NTFY_URL` is the operator's topic URL (`https://ntfy.sh/alerts`, `http://ntfy:80/team/alerts`):
the last path segment is the topic, the rest the server base. The token goes in a header only;
`user:pw@` userinfo becomes Basic auth (a `NTFY_TOKEN` bearer header wins).
"""

import json
import urllib.parse

from ..settings import Settings
from . import DeliveryError, webhook

TIMEOUT_S = 10.0


def split_topic_url(url: str) -> tuple[str, str]:
    """`http://h/p/alerts` -> (`http://h/p/`, `alerts`); a permanent error without a topic."""
    try:
        parts = urllib.parse.urlsplit(url.strip())
        _ = parts.port  # raises ValueError on a bad port
    except ValueError:
        raise DeliveryError("invalid NTFY_URL", retryable=False) from None
    path = parts.path.rstrip("/")
    prefix, _, topic = path.rpartition("/")
    if parts.scheme not in ("http", "https") or not parts.netloc or not topic:
        raise DeliveryError("invalid NTFY_URL", retryable=False)
    # userinfo stays in the base URL: `webhook.post` turns it into Basic auth.
    return f"{parts.scheme}://{parts.netloc}{prefix}/", urllib.parse.unquote(topic)


def tags(raw: str) -> list[str]:
    return [t.strip() for t in raw.split(",") if t.strip()]


def send(settings: Settings, title: str, body: str, *, timeout: float = TIMEOUT_S) -> None:
    if not settings.ntfy_url:
        raise DeliveryError("not configured", retryable=False)
    base, topic = split_topic_url(settings.ntfy_url)
    payload: dict[str, object] = {
        "topic": topic,
        "title": title,
        "message": body,
        "priority": settings.ntfy_priority,
    }
    if settings.ntfy_tags.strip():
        payload["tags"] = tags(settings.ntfy_tags)
    headers = {"Authorization": f"Bearer {settings.ntfy_token}"} if settings.ntfy_token else {}
    webhook.post(
        base,
        json.dumps(payload).encode(),
        "application/json",
        headers=headers,
        timeout=timeout,
        allow_private=True,
    )
