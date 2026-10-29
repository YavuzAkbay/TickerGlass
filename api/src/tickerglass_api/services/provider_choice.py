"""The provider the user picked in the app, kept across restarts.

`MARKET_PROVIDER` names the provider the API starts on; switching in the app stores the
choice in `app_meta` (never exported) as `{"id", "env"}`, `env` being the `MARKET_PROVIDER`
in force when it was made. At start-up `resolve_startup_provider` decides which of the two
wins: the stored choice stands until `MARKET_PROVIDER` is changed, then the environment is
the newer decision and the stored choice is dropped.
"""

import logging
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Literal

from sqlalchemy import Engine
from sqlalchemy.orm import Session

from ..models import AppMeta
from ..providers.registry import PROVIDERS, ProviderSpec
from ..settings import Settings

log = logging.getLogger(__name__)

#: `app_meta` key holding the provider picked in the app.
ACTIVE_PROVIDER_KEY = "active_provider"

#: Who chose the active provider: the user in the app, `MARKET_PROVIDER`, or the default.
SelectedBy = Literal["ui", "env", "default"]


def env_choice(settings: Settings) -> SelectedBy:
    """How the provider named by `settings` was chosen: set explicitly, or by default."""
    return "env" if "market_provider" in settings.model_fields_set else "default"


@dataclass(frozen=True)
class ProviderChoice:
    id: str
    #: `MARKET_PROVIDER` when the choice was made.
    env: str


def load_provider_choice(engine: Engine) -> ProviderChoice | None:
    """The stored choice; None when there is none or the row is unreadable."""
    with Session(engine) as session:
        row = session.get(AppMeta, ACTIVE_PROVIDER_KEY)
        value = None if row is None else row.value
    if value is None:
        return None
    if (
        not isinstance(value, dict)
        or not isinstance(value.get("id"), str)
        or not isinstance(value.get("env"), str)
    ):
        log.warning("ignoring the stored provider choice, it is malformed: %r", value)
        return None
    return ProviderChoice(id=value["id"], env=value["env"])


def save_provider_choice(engine: Engine, choice: ProviderChoice) -> None:
    value = {"id": choice.id, "env": choice.env}
    with Session(engine) as session, session.begin():
        row = session.get(AppMeta, ACTIVE_PROVIDER_KEY)
        now = datetime.now(UTC)
        if row is None:
            session.add(AppMeta(key=ACTIVE_PROVIDER_KEY, value=value, updated_at=now))
        else:
            row.value = value
            row.updated_at = now


def clear_provider_choice(engine: Engine) -> None:
    with Session(engine) as session, session.begin():
        row = session.get(AppMeta, ACTIVE_PROVIDER_KEY)
        if row is not None:
            session.delete(row)


def resolve_startup_provider(
    engine: Engine, settings: Settings, is_configured: Callable[[ProviderSpec], bool]
) -> tuple[str, SelectedBy]:
    """The provider to start on and who chose it ("ui", "env" or "default").

    1. `PROVIDER_SWITCHING` off: `MARKET_PROVIDER` (a stored choice is ignored, with a warning).
    2. No stored choice: `MARKET_PROVIDER`.
    3. The stored provider is unknown or no longer configured: `MARKET_PROVIDER`, with a
       warning; the stored choice is kept for when its settings are back.
    4. `MARKET_PROVIDER` differs from the one in force when the choice was made: the
       environment is the newer decision; `MARKET_PROVIDER`, and the stored choice is deleted.
    5. Otherwise the stored choice ("ui").
    """
    env_id = settings.market_provider
    env_by = env_choice(settings)
    stored = load_provider_choice(engine)
    if not settings.provider_switching:
        if stored is not None and stored.id != env_id:
            log.warning(
                "ignoring the provider chosen in the app (%s): PROVIDER_SWITCHING is off, "
                "running on MARKET_PROVIDER=%s",
                stored.id,
                env_id,
            )
        return env_id, env_by
    if stored is None:
        return env_id, env_by
    spec = PROVIDERS.get(stored.id)
    if spec is None or not is_configured(spec):
        log.warning(
            "the provider chosen in the app (%s) is %s; running on MARKET_PROVIDER=%s",
            stored.id,
            "unknown" if spec is None else "not configured",
            env_id,
        )
        return env_id, env_by
    if stored.env != env_id:
        log.info(
            "MARKET_PROVIDER changed from %s to %s since the provider was chosen in the app: "
            "using it and dropping the stored choice (%s)",
            stored.env,
            env_id,
            stored.id,
        )
        clear_provider_choice(engine)
        return env_id, env_by
    return stored.id, "ui"
