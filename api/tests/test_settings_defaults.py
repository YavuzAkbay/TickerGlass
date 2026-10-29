"""`model_fields_set` separates env-set fields from defaults, which the registry relies on to
apply a provider's `setting_defaults` only where the user did not choose a value."""

import pytest

from tickerglass_api.settings import Settings


@pytest.fixture(autouse=True)
def clean_env(monkeypatch: pytest.MonkeyPatch) -> None:
    # The suite's autouse fixtures set some settings through the environment.
    for field in Settings.model_fields:
        monkeypatch.delenv(field.upper(), raising=False)


def make() -> Settings:
    # `_env_file=None` keeps a developer's .env out of the test.
    return Settings(_env_file=None)  # type: ignore[call-arg]


def test_env_sourced_fields_are_in_fields_set(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("UPSTREAM_RATE_PER_MIN", "8")
    settings = make()
    assert "upstream_rate_per_min" in settings.model_fields_set
    assert settings.upstream_rate_per_min == 8
    assert "upstream_daily_limit" not in settings.model_fields_set
    assert "quote_ttl_s" not in settings.model_fields_set


def test_nothing_set_without_env() -> None:
    assert make().model_fields_set == set()


def test_model_copy_update_marks_only_updated_fields_set(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("UPSTREAM_RATE_PER_MIN", "8")
    original = make()
    copied = original.model_copy(update={"quote_ttl_s": 300.0, "upstream_daily_limit": 800})
    assert copied.quote_ttl_s == 300.0
    assert copied.upstream_daily_limit == 800
    assert copied.upstream_rate_per_min == 8
    assert copied.model_fields_set == {
        "upstream_rate_per_min",
        "quote_ttl_s",
        "upstream_daily_limit",
    }
    # The copy does not change the original.
    assert original.model_fields_set == {"upstream_rate_per_min"}
    assert original.quote_ttl_s == 15
