"""Keep the `auth_token` query parameter (the alerts service's legacy WebSocket credential)
out of the logs: uvicorn logs the full request path, WebSocket handshakes included."""

import logging
import re

_AUTH_TOKEN = re.compile(r"(?i)(\bauth_token=)[^&\s\"']*")
_REDACTED = r"\1[redacted]"

#: Loggers that print request URLs: `uvicorn.access` (HTTP) and `uvicorn.error` ("WebSocket
#: /ws?... [accepted]"). A logger's filters see only records logged on it, so list each.
_LOGGERS = ("uvicorn", "uvicorn.access", "uvicorn.error")


def redact(text: str) -> str:
    return _AUTH_TOKEN.sub(_REDACTED, text)


class RedactAuthToken(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        try:
            message = record.getMessage()
        except Exception:  # noqa: BLE001 - a malformed log call is not ours to raise
            return True
        redacted = redact(message)
        if redacted != message:
            record.msg = redacted
            record.args = None
        return True


def install_log_redaction() -> None:
    """Idempotent; call at app creation and before `uvicorn.run`."""
    for name in _LOGGERS:
        logger = logging.getLogger(name)
        if not any(isinstance(f, RedactAuthToken) for f in logger.filters):
            logger.addFilter(RedactAuthToken())
