"""Alert notification delivery (docs/alerts.md §4): channel configuration helpers and the
error type the stdlib transports raise. The outbox itself lives in `dispatcher.py`."""

from urllib.parse import urlsplit

from ..settings import Settings

CHANNELS = ("webhook", "telegram", "email")


class DeliveryError(Exception):
    """A failed send. `retryable=False` fails the delivery at once (permanent 4xx etc.)."""

    def __init__(self, message: str, *, retryable: bool = True, retry_after: float | None = None):
        super().__init__(message)
        self.retryable = retryable
        self.retry_after = retry_after


def effective_webhook_url(settings: Settings, per_alert: str | None) -> str | None:
    return per_alert or settings.alerts_webhook_url or None


def webhook_allow_private(settings: Settings, per_alert: str | None) -> bool:
    """May this webhook target a private/loopback address?

    Decision: the global `ALERTS_WEBHOOK_URL` is written by the operator (env/compose), who is
    trusted to point it at e.g. a LAN service or n8n container, so it bypasses the SSRF check.
    A per-alert URL arrives over the unauthenticated API and is only allowed private
    destinations when the operator opted in with `ALERTS_WEBHOOK_ALLOW_PRIVATE`.
    """
    return settings.alerts_webhook_allow_private or not per_alert


def webhook_configured(settings: Settings, per_alert: str | None = None) -> bool:
    return effective_webhook_url(settings, per_alert) is not None


def telegram_configured(settings: Settings) -> bool:
    return bool(settings.telegram_bot_token and settings.telegram_chat_id)


def email_configured(settings: Settings) -> bool:
    return bool(settings.smtp_host and settings.smtp_from and smtp_recipients(settings))


def smtp_recipients(settings: Settings) -> list[str]:
    return [a.strip() for a in (settings.smtp_to or "").split(",") if a.strip()]


def channel_configured(
    settings: Settings, channel: str, per_alert_webhook: str | None = None
) -> bool:
    if channel == "webhook":
        return webhook_configured(settings, per_alert_webhook)
    if channel == "telegram":
        return telegram_configured(settings)
    if channel == "email":
        return email_configured(settings)
    return False


def mask_url(url: str | None) -> str | None:
    """`https://host/…`: paths and queries often carry the secret (Slack, Discord, ...)."""
    if not url:
        return None
    parts = urlsplit(url)
    return f"{parts.scheme}://{parts.netloc.rpartition('@')[2]}/…"


def mask_email(address: str) -> str:
    local, _, domain = address.partition("@")
    return f"{local[:1]}***@{domain}" if domain else "***"
