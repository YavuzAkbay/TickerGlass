"""Which provider the API starts on: `MARKET_PROVIDER` or the choice stored from the app."""

from pathlib import Path

import pytest
from sqlalchemy import Engine

from tickerglass_api.db import make_engine, run_migrations
from tickerglass_api.providers.registry import ProviderSpec
from tickerglass_api.services.provider_choice import (
    ProviderChoice,
    clear_provider_choice,
    load_provider_choice,
    resolve_startup_provider,
    save_provider_choice,
)
from tickerglass_api.settings import Settings


@pytest.fixture
def engine(tmp_path: Path) -> Engine:
    url = f"sqlite:///{tmp_path}/c.db"
    run_migrations(url)
    return make_engine(url)


def everything(_: ProviderSpec) -> bool:
    return True


def only_demo(spec: ProviderSpec) -> bool:
    return spec.id == "demo"


def settings(**kw: object) -> Settings:
    return Settings(_env_file=None, **kw)  # type: ignore[arg-type]


def test_save_load_and_clear(engine: Engine) -> None:
    assert load_provider_choice(engine) is None
    save_provider_choice(engine, ProviderChoice("demo", "yahoo"))
    assert load_provider_choice(engine) == ProviderChoice("demo", "yahoo")
    save_provider_choice(engine, ProviderChoice("twelvedata", "yahoo"))
    assert load_provider_choice(engine) == ProviderChoice("twelvedata", "yahoo")
    clear_provider_choice(engine)
    assert load_provider_choice(engine) is None
    clear_provider_choice(engine)  # nothing to clear: fine


def test_a_malformed_row_reads_as_no_choice(engine: Engine) -> None:
    from datetime import UTC, datetime

    from sqlalchemy.orm import Session

    from tickerglass_api.models import AppMeta
    from tickerglass_api.services.provider_choice import ACTIVE_PROVIDER_KEY

    with Session(engine) as s, s.begin():
        s.add(AppMeta(key=ACTIVE_PROVIDER_KEY, value=["demo"], updated_at=datetime.now(UTC)))
    assert load_provider_choice(engine) is None
    assert resolve_startup_provider(engine, settings(), everything) == ("yahoo", "default")


def test_nothing_stored_uses_the_environment(engine: Engine) -> None:
    assert resolve_startup_provider(engine, settings(), everything) == ("yahoo", "default")
    assert resolve_startup_provider(engine, settings(market_provider="demo"), everything) == (
        "demo",
        "env",
    )
    # An explicit MARKET_PROVIDER equal to the default is still "env".
    assert resolve_startup_provider(engine, settings(market_provider="yahoo"), everything) == (
        "yahoo",
        "env",
    )


def test_a_stored_choice_stands_while_the_environment_is_unchanged(engine: Engine) -> None:
    save_provider_choice(engine, ProviderChoice("demo", "yahoo"))
    for s in (settings(), settings(market_provider="yahoo")):
        assert resolve_startup_provider(engine, s, everything) == ("demo", "ui")
    assert load_provider_choice(engine) == ProviderChoice("demo", "yahoo")


def test_a_changed_environment_wins_and_drops_the_choice(
    engine: Engine, caplog: pytest.LogCaptureFixture
) -> None:
    save_provider_choice(engine, ProviderChoice("demo", "yahoo"))
    with caplog.at_level("INFO"):
        got = resolve_startup_provider(engine, settings(market_provider="twelvedata"), everything)
    assert got == ("twelvedata", "env")
    assert load_provider_choice(engine) is None
    assert "MARKET_PROVIDER changed from yahoo to twelvedata" in caplog.text


def test_an_unconfigured_stored_provider_falls_back_and_keeps_the_choice(
    engine: Engine, caplog: pytest.LogCaptureFixture
) -> None:
    save_provider_choice(engine, ProviderChoice("twelvedata", "yahoo"))
    with caplog.at_level("WARNING"):
        got = resolve_startup_provider(engine, settings(), only_demo)
    assert got == ("yahoo", "default")
    assert "not configured" in caplog.text
    assert load_provider_choice(engine) == ProviderChoice("twelvedata", "yahoo")


def test_an_unknown_stored_provider_falls_back_and_keeps_the_choice(
    engine: Engine, caplog: pytest.LogCaptureFixture
) -> None:
    save_provider_choice(engine, ProviderChoice("gone", "yahoo"))
    with caplog.at_level("WARNING"):
        got = resolve_startup_provider(engine, settings(market_provider="demo"), everything)
    assert got == ("demo", "env")
    assert "unknown" in caplog.text
    assert load_provider_choice(engine) == ProviderChoice("gone", "yahoo")


def test_an_unconfigured_choice_is_checked_before_the_environment_change(engine: Engine) -> None:
    # Unusable stored provider and a changed environment: the row is kept (rule 3 before 4).
    save_provider_choice(engine, ProviderChoice("twelvedata", "yahoo"))
    got = resolve_startup_provider(engine, settings(market_provider="demo"), only_demo)
    assert got == ("demo", "env")
    assert load_provider_choice(engine) == ProviderChoice("twelvedata", "yahoo")


def test_switching_off_ignores_the_stored_choice(
    engine: Engine, caplog: pytest.LogCaptureFixture
) -> None:
    save_provider_choice(engine, ProviderChoice("demo", "yahoo"))
    with caplog.at_level("WARNING"):
        got = resolve_startup_provider(engine, settings(provider_switching=False), everything)
    assert got == ("yahoo", "default")
    assert "PROVIDER_SWITCHING is off" in caplog.text
    assert load_provider_choice(engine) == ProviderChoice("demo", "yahoo")
    # Stored equal to the environment's: nothing to warn about.
    caplog.clear()
    save_provider_choice(engine, ProviderChoice("yahoo", "yahoo"))
    with caplog.at_level("WARNING"):
        resolve_startup_provider(engine, settings(provider_switching=False), everything)
    assert caplog.text == ""


def test_provider_switching_reads_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    assert Settings(_env_file=None).provider_switching is True
    monkeypatch.setenv("PROVIDER_SWITCHING", "false")
    assert Settings(_env_file=None).provider_switching is False
