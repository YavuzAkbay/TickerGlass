"""Email transport (stdlib `smtplib`)."""

import smtplib
import ssl
from email.message import EmailMessage

from ..settings import Settings
from . import DeliveryError, smtp_recipients

TIMEOUT_S = 10.0


def send(settings: Settings, subject: str, body: str, *, timeout: float = TIMEOUT_S) -> None:
    """Plain-text mail via `SMTP_HOST` honoring `SMTP_TLS`; raises `DeliveryError`."""
    if not settings.smtp_host or not settings.smtp_from:
        raise DeliveryError("not configured", retryable=False)
    msg = EmailMessage()
    msg["Subject"] = " ".join(subject.split())
    msg["From"] = settings.smtp_from
    msg["To"] = ", ".join(smtp_recipients(settings))
    msg.set_content(body)
    try:
        if settings.smtp_tls == "ssl":
            smtp: smtplib.SMTP = smtplib.SMTP_SSL(
                settings.smtp_host,
                settings.smtp_port,
                timeout=timeout,
                context=ssl.create_default_context(),
            )
        else:
            smtp = smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=timeout)
        with smtp:
            if settings.smtp_tls == "starttls":
                smtp.starttls(context=ssl.create_default_context())
            if settings.smtp_user:
                smtp.login(settings.smtp_user, settings.smtp_password or "")
            smtp.send_message(msg)
    except smtplib.SMTPResponseException as exc:
        # 5xx replies (auth, rejected recipients, ...) will not improve on retry.
        raise DeliveryError(
            f"SMTP {exc.smtp_code}: {_text(exc.smtp_error)}", retryable=exc.smtp_code < 500
        ) from None
    except smtplib.SMTPRecipientsRefused as exc:
        raise DeliveryError(
            f"recipients refused: {sorted(exc.recipients)}", retryable=False
        ) from None
    except (smtplib.SMTPException, OSError) as exc:
        raise DeliveryError(f"{type(exc).__name__}: {exc}") from None


def _text(value: bytes | str) -> str:
    return value.decode(errors="replace") if isinstance(value, bytes) else value
