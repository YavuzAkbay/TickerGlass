import sys

import uvicorn

from .logredact import install_log_redaction
from .settings import get_settings


def main() -> None:
    if len(sys.argv) > 1 and sys.argv[1] == "backup":
        from .backups.cli import main as backup_main

        sys.exit(backup_main(sys.argv[2:]))
    settings = get_settings()
    install_log_redaction()
    # The app resolves X-Forwarded-For itself (TRUSTED_PROXIES / AUTH_HEADER_PROXIES,
    # docs/design/oidc-sso.md). Uvicorn's own rewrite of the peer address would hide the
    # real hop from that walk, so it stays off.
    uvicorn.run(
        "tickerglass_api.app:app",
        host=settings.api_host,
        port=settings.api_port,
        proxy_headers=False,
    )


if __name__ == "__main__":
    main()
