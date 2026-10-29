"""Provider framework: capability gates, costs, config, setting defaults, 501/503 answers."""

from collections.abc import Iterator, Mapping
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pandas as pd
import pytest
from fastapi.testclient import TestClient
from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy import select
from sqlalchemy.orm import Session

from tickerglass_api.app import build_runtime, create_app
from tickerglass_api.db import make_engine, run_migrations
from tickerglass_api.intervals import resolve_interval
from tickerglass_api.models import Bar
from tickerglass_api.providers.base import (
    Capabilities,
    CostModel,
    ProviderNotConfigured,
    ProviderUnsupported,
)
from tickerglass_api.providers.demo import DemoProvider
from tickerglass_api.providers.guard import GuardedProvider, UpstreamGuard
from tickerglass_api.providers.registry import (
    PROVIDERS,
    ProviderSpec,
    UnconfiguredProvider,
    apply_setting_defaults,
    config_fields,
    load_config,
)
from tickerglass_api.services.bars import BarService
from tickerglass_api.services.stats import CacheStats
from tickerglass_api.settings import Settings, get_settings

NOW = datetime(2026, 6, 17, 15, 0, tzinfo=UTC)
SECRET = "s3cr3t-api-key-value"

# Daily bars only, nothing else beyond symbol search.
MINIMAL = Capabilities(
    intervals=frozenset({"1d"}),
    extended_history=False,
    extended_quotes=False,
    adjusted_close=False,
    search=True,
    events=frozenset(),
    news=False,
    fundamentals_info=False,
    fundamentals_statements=False,
    streaming=False,
    markets=frozenset({"us"}),
)


class KeyedConfig(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="FAKEPROV_", env_file=None, extra="ignore")

    api_key: SecretStr
    plan: str = "basic"
    base_url: str = "https://example.test"


def _make_demo(_: Settings, __: BaseSettings | None) -> DemoProvider:
    return DemoProvider(clock=lambda: NOW)


def _spec(
    pid: str,
    *,
    config: type[BaseSettings] | None = None,
    capabilities: Capabilities | None = None,
    defaults: Mapping[str, Any] | None = None,
    plan: str | None = None,
) -> ProviderSpec:
    return ProviderSpec(
        id=pid,
        name=pid.title(),
        description="test provider",
        network=False,
        terms=None,
        probe_symbol="GLSS",
        make=_make_demo,
        config=config,
        capabilities=(lambda _: capabilities) if capabilities else (lambda _: Capabilities.full()),
        setting_defaults=lambda _: defaults or {},
        plan=lambda _: plan,
    )


def _make_live_demo(_: Settings, __: BaseSettings | None) -> DemoProvider:
    return DemoProvider()  # real clock: the bar service asks for the bars up to now


class Recorder:
    """Counts the calls that reach it; every answer is empty."""

    def __init__(self) -> None:
        self.calls: list[str] = []

    def history(
        self,
        symbol: str,
        interval: str,
        start: datetime | None,
        end: datetime | None,
        prepost: bool,
    ) -> pd.DataFrame:
        self.calls.append(f"history:{prepost}")
        return DemoProvider(clock=lambda: NOW).history(symbol, interval, start, end, prepost)

    def symbol_info(self, symbol: str) -> dict[str, Any]:
        self.calls.append("symbol_info")
        return {}

    def search(self, query: str, limit: int) -> list[dict[str, Any]]:
        self.calls.append("search")
        return []

    def quotes(self, symbols: list[str]) -> list[dict[str, Any]]:
        self.calls.append("quotes")
        return []

    def extended_quotes(self, symbols: list[str]) -> list[dict[str, Any]]:
        self.calls.append("extended_quotes")
        return []

    def events(self, symbol: str) -> dict[str, Any]:
        self.calls.append("events")
        return {}

    def news(self, symbol: str, limit: int) -> list[dict[str, Any]]:
        self.calls.append("news")
        return []

    def fundamentals(self, symbol: str) -> dict[str, Any]:
        self.calls.append("fundamentals")
        return {}


@pytest.fixture
def specs(monkeypatch: pytest.MonkeyPatch) -> Iterator[dict[str, ProviderSpec]]:
    """Test providers registered next to the real ones for the duration of a test."""
    table = {
        "minimal": _spec("minimal", capabilities=MINIMAL),
        "keyed": _spec("keyed", config=KeyedConfig, plan="basic"),
        "regular": replace(
            _spec("regular", capabilities=replace(Capabilities.full(), extended_history=False)),
            make=_make_live_demo,
        ),
    }
    for pid, spec in table.items():
        monkeypatch.setitem(PROVIDERS, pid, spec)
    yield table


def app_for(provider_id: str, tmp_path: Path, **settings: Any) -> TestClient:
    s = Settings(_env_file=None, market_provider=provider_id, **settings)
    return TestClient(create_app(settings_override=s, database_url=f"sqlite:///{tmp_path}/c.db"))


# --- the guard's capability gate -------------------------------------------------------


def test_gate_refuses_unsupported_calls_without_taking_tokens() -> None:
    inner = Recorder()
    guard = UpstreamGuard(rate_per_min=1, burst=5)
    stats = CacheStats()
    prov = GuardedProvider(inner, guard, stats, capabilities=MINIMAL)

    refused: list[Any] = [
        lambda: prov.history("A", "5m", None, None, False),
        lambda: prov.extended_quotes(["A", "B"]),
        lambda: prov.events("A"),
        lambda: prov.news("A", 5),
        lambda: prov.fundamentals("A"),
    ]
    for call in refused:
        with pytest.raises(ProviderUnsupported):
            call()

    assert inner.calls == []
    assert guard.snapshot()["tokens"] == 5
    assert guard.snapshot()["refused"] == {
        "rate_limited": 0,
        "unavailable": 0,
        "budget": 0,
        "daily": 0,
    }

    # What the provider does serve is charged as usual.
    prov.history("GLSS", "1d", None, None, False)
    prov.search("a", 5)
    assert guard.snapshot()["tokens"] < 4  # two calls (refill during the test is negligible)


def test_gate_names_feature_and_provider() -> None:
    prov = GuardedProvider(Recorder(), UpstreamGuard(), capabilities=MINIMAL)
    with pytest.raises(ProviderUnsupported) as exc:
        prov.news("A", 1)
    assert exc.value.feature == "news"
    assert exc.value.provider is None
    assert str(ProviderUnsupported("news", "twelvedata")) == "news is not supported by twelvedata"


def test_partial_events_and_one_fundamentals_half_pass_the_gate() -> None:
    inner = Recorder()
    caps = Capabilities(
        **{
            **vars(MINIMAL),
            "events": frozenset({"dividends"}),
            "fundamentals_info": True,
        }
    )
    prov = GuardedProvider(inner, UpstreamGuard(), capabilities=caps)
    prov.events("A")
    prov.fundamentals("A")
    assert inner.calls == ["events", "fundamentals"]


def test_default_gate_allows_everything() -> None:
    inner = Recorder()
    prov = GuardedProvider(inner, UpstreamGuard())
    prov.history("GLSS", "5d", None, None, False)
    prov.extended_quotes(["A"])
    prov.news("A", 1)
    assert inner.calls == ["history:False", "extended_quotes", "news"]


def test_costs_price_calls() -> None:
    assert CostModel().quotes(0) == 0
    assert CostModel().quotes(50) == 1
    assert CostModel().quotes(51) == 2
    per_symbol = CostModel(quote_batch=120, quote_per_request=0, quote_per_symbol=1)
    assert per_symbol.quotes(3) == 3
    assert per_symbol.quotes(121) == 121

    guard = UpstreamGuard(rate_per_min=1, burst=100)
    prov = GuardedProvider(Recorder(), guard, costs=per_symbol)
    prov.quotes(["A", "B", "C"])
    assert guard.snapshot()["tokens"] == pytest.approx(97, abs=0.1)


def test_full_capabilities_json_is_camel_case() -> None:
    caps = Capabilities.full().to_json()
    assert caps["intervals"][:2] == ["1m", "2m"]
    assert caps["events"] == ["dividends", "earnings", "splits"]
    assert caps["extendedHistory"] is True
    assert caps["fundamentalsStatements"] is True
    assert caps["markets"] == ["crypto", "futures", "fx", "index", "intl", "us"]


# --- bars ------------------------------------------------------------------------------


def test_prepost_is_coerced_when_provider_has_no_extended_history(tmp_path: Path) -> None:
    url = f"sqlite:///{tmp_path}/b.db"
    run_migrations(url)
    engine = make_engine(url)
    spec = resolve_interval("5m")

    for extended, expect in ((False, False), (True, True)):
        inner = Recorder()
        svc = BarService(engine, inner, extended_history=extended)
        svc.get_bars("GLSS" if extended else "GLSX", spec, True, now=NOW)
        assert inner.calls[0] == f"history:{expect}"

    with Session(engine) as s:
        stored = {(b.symbol, b.prepost) for b in s.scalars(select(Bar))}
    assert stored == {("GLSX", False), ("GLSS", True)}


def test_bars_echo_the_effective_prepost(specs: dict[str, ProviderSpec], tmp_path: Path) -> None:
    params = {"symbol": "GLSS", "interval": "5m", "prepost": "true"}
    with app_for("regular", tmp_path) as client:
        assert client.get("/api/bars", params=params).json()["prepost"] is False
    with app_for("demo", tmp_path) as client:
        assert client.get("/api/bars", params=params).json()["prepost"] is True
        daily = client.get("/api/bars", params={**params, "interval": "1d"}).json()
        assert daily["prepost"] is False


# --- the HTTP surface ------------------------------------------------------------------


def test_unsupported_features_answer_501(specs: dict[str, ProviderSpec], tmp_path: Path) -> None:
    with app_for("minimal", tmp_path) as client:
        r = client.get("/api/bars", params={"symbol": "GLSS", "interval": "5m"})
        assert r.status_code == 501
        assert r.json() == {
            "detail": "5m bars is not supported by minimal",
            "code": "unsupported",
            "feature": "5m bars",
            "provider": "minimal",
        }
        for url in (
            "/api/quotes/extended?symbols=GLSS",
            "/api/events/GLSS",
            "/api/news/GLSS",
            "/api/news?symbols=GLSS,LENS",
            "/api/fundamentals/GLSS",
        ):
            r = client.get(url)
            assert r.status_code == 501, url
            assert r.json()["code"] == "unsupported"
        assert (
            client.get("/api/bars", params={"symbol": "GLSS", "interval": "1d"}).status_code == 200
        )


def test_news_multi_checks_capability_before_any_symbol(
    specs: dict[str, ProviderSpec], tmp_path: Path
) -> None:
    with app_for("minimal", tmp_path) as client:
        r = client.get("/api/news", params={"symbols": "GLSS"})
        assert r.status_code == 501
        assert r.json()["feature"] == "news"


# --- /providers ------------------------------------------------------------------------


def test_providers_payload_never_contains_secrets(
    specs: dict[str, ProviderSpec], tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("FAKEPROV_API_KEY", SECRET)
    monkeypatch.setenv("FAKEPROV_PLAN", "grow")
    # Not conftest's permissive guard: the budget is the provider's (here the defaults).
    for name in ("UPSTREAM_RATE_PER_MIN", "UPSTREAM_BURST"):
        monkeypatch.delenv(name)
    with app_for("keyed", tmp_path) as client:
        r = client.get("/api/providers")
        assert SECRET not in r.text
        body = r.json()
    keyed = next(p for p in body["providers"] if p["id"] == "keyed")
    fields = {f["name"]: f for f in keyed["config"]}
    assert fields["api_key"] == {
        "name": "api_key",
        "env": "FAKEPROV_API_KEY",
        "label": "Api key",
        "secret": True,
        "required": True,
        "set": True,
        "value": None,
    }
    assert fields["plan"]["value"] == "grow" and fields["plan"]["set"] is True
    assert (
        fields["base_url"]["set"] is False and fields["base_url"]["value"] == "https://example.test"
    )
    assert keyed["configured"] is True
    assert body["active"] == "keyed"
    assert body["activeCapabilities"] == Capabilities.full().to_json()
    limits = body["effectiveLimits"]
    assert limits["source"] == "plan"
    assert limits["creditsPerMin"] == 60 and limits["dailyCredits"] is None
    assert limits["quoteTtlS"] == 15 and limits["pollIntervalS"] == 15

    yahoo = next(p for p in body["providers"] if p["id"] == "yahoo")
    assert yahoo["config"] == [] and yahoo["plan"] is None and yahoo["configured"] is True
    assert yahoo["budget"] == {"ratePerMin": 60, "burst": 20, "daily": None}
    assert yahoo["costs"]["fundamentals"] == 7 and yahoo["costs"]["quoteBatch"] == 50
    assert yahoo["capabilities"]["streaming"] is True


def test_unset_field_values_are_the_defaults_or_null() -> None:
    class Cfg(BaseSettings):
        model_config = SettingsConfigDict(env_prefix="FAKEPROV_", env_file=None, extra="ignore")

        api_key: SecretStr
        region: str  # required, no default
        plan: str = "basic"
        cap: int | None = None
        tags: list[str] = Field(default_factory=lambda: ["a"])

    spec = _spec("keyed", config=Cfg)
    for config in (None, Cfg(api_key=SecretStr(SECRET), region="eu")):
        fields = {f.name: f for f in config_fields(spec, config)}
        assert fields["api_key"].value is None
        assert fields["plan"].value == "basic" and fields["plan"].set is False
        assert fields["cap"].value is None
        assert fields["tags"].value == ["a"]
        assert fields["region"].required is True
    assert {f.name: f.value for f in config_fields(spec, None)}["region"] is None
    set_fields = {
        f.name: f for f in config_fields(spec, Cfg(api_key=SecretStr(SECRET), region="eu"))
    }
    assert set_fields["region"].value == "eu" and set_fields["region"].set is True


def test_secret_field_value_is_not_exposed_even_if_set() -> None:
    config = KeyedConfig(api_key=SecretStr(SECRET))
    spec = _spec("keyed", config=KeyedConfig)
    key = next(f for f in config_fields(spec, config) if f.name == "api_key")
    assert key.set and key.value is None
    assert SECRET not in repr(config_fields(spec, config))


def test_unconfigured_provider_starts_and_answers_503(
    specs: dict[str, ProviderSpec], tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("FAKEPROV_API_KEY", raising=False)
    with app_for("keyed", tmp_path) as client:
        r = client.get("/api/quotes", params={"symbols": "GLSS"})
        assert r.status_code == 503
        assert r.json() == {"detail": "FAKEPROV_API_KEY is not set", "code": "not_configured"}
        assert client.get("/api/bars", params={"symbol": "GLSS"}).status_code == 503
        # Not-configured is a state, not a failure of the listing.
        listing = client.get("/api/providers").json()
        keyed = next(p for p in listing["providers"] if p["id"] == "keyed")
        assert keyed["configured"] is False
        assert next(f for f in keyed["config"] if f["name"] == "api_key")["set"] is False
        test = client.post("/api/providers/test").json()
        assert test == {
            "ok": False,
            "symbol": "GLSS",
            "error": "FAKEPROV_API_KEY is not set",
            "code": "not_configured",
        }


def test_load_config_names_missing_variables(
    specs: dict[str, ProviderSpec], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("FAKEPROV_API_KEY", raising=False)
    with pytest.raises(ProviderNotConfigured, match="FAKEPROV_API_KEY is not set"):
        load_config(specs["keyed"])
    monkeypatch.setenv("FAKEPROV_API_KEY", SECRET)
    assert load_config(specs["keyed"]) is not None
    assert load_config(PROVIDERS["yahoo"]) is None


def test_unconfigured_stub_fails_every_call() -> None:
    stub = UnconfiguredProvider("X_KEY is not set")
    for call in (
        lambda: stub.history("A", "1d", None, None, False),
        lambda: stub.symbol_info("A"),
        lambda: stub.search("a", 1),
        lambda: stub.quotes(["A"]),
        lambda: stub.extended_quotes(["A"]),
        lambda: stub.events("A"),
        lambda: stub.news("A", 1),
        lambda: stub.fundamentals("A"),
    ):
        with pytest.raises(ProviderNotConfigured, match="X_KEY is not set"):
            call()


# --- MARKET_PROVIDER and setting defaults ------------------------------------------------


def test_unknown_market_provider_is_rejected(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match=r"unknown MARKET_PROVIDER 'nope'; valid: yahoo, demo"):
        create_app(
            settings_override=Settings(_env_file=None, market_provider="nope"),
            database_url=f"sqlite:///{tmp_path}/u.db",
        )


def test_unknown_market_provider_from_env_is_rejected(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("MARKET_PROVIDER", "nope")
    get_settings.cache_clear()
    with pytest.raises(ValueError, match="unknown MARKET_PROVIDER"):
        create_app(database_url=f"sqlite:///{tmp_path}/u.db")


def test_setting_defaults_fill_only_unset_fields(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("QUOTE_TTL_S", "5")
    spec = _spec("d", defaults={"quote_ttl_s": 999, "live_poll_interval_s": 77, "news_ttl_s": 1})

    settings = Settings(_env_file=None, news_ttl_s=42)
    eff = apply_setting_defaults(spec, settings, None)

    assert eff.quote_ttl_s == 5  # environment wins
    assert eff.news_ttl_s == 42  # constructor argument wins
    assert eff.live_poll_interval_s == 77  # untouched: the default applies
    assert settings.live_poll_interval_s == 15  # the original is not modified
    # A setting repeating its own default still counts as set.
    monkeypatch.setenv("LIVE_POLL_INTERVAL_S", "15")
    assert apply_setting_defaults(spec, Settings(_env_file=None), None).live_poll_interval_s == 15


def test_setting_defaults_reject_unknown_names() -> None:
    spec = _spec("d", defaults={"quote_ttl": 1})
    with pytest.raises(ValueError, match="unknown settings"):
        apply_setting_defaults(spec, Settings(_env_file=None), None)


def test_runtime_follows_plan_defaults_unless_env_sets_the_budget(
    specs: dict[str, ProviderSpec], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("FAKEPROV_API_KEY", SECRET)
    planned = _spec(
        "planned",
        config=KeyedConfig,
        plan="basic",
        defaults={"upstream_rate_per_min": 8, "upstream_burst": 8, "quote_ttl_s": 300},
    )
    for name in ("UPSTREAM_RATE_PER_MIN", "UPSTREAM_BURST"):
        monkeypatch.delenv(name)

    runtime = build_runtime(planned, Settings(_env_file=None), CacheStats())
    assert (runtime.budget.rate_per_min, runtime.budget.burst) == (8, 8)
    assert runtime.settings.quote_ttl_s == 300
    assert runtime.limits_source == "plan"

    # The permissive test guard (conftest) is an env setting: the plan must not override it.
    monkeypatch.setenv("UPSTREAM_RATE_PER_MIN", "1e9")
    runtime = build_runtime(planned, Settings(_env_file=None), CacheStats())
    assert runtime.budget.rate_per_min == 1e9
    assert runtime.budget.burst == 8  # still unset: the plan's value
    assert runtime.limits_source == "env"


def test_runtime_of_a_custom_provider_is_full_and_keeps_yahoo_relay() -> None:
    runtime = build_runtime(None, Settings(_env_file=None), CacheStats(), provider=Recorder())
    assert runtime.spec is None
    assert runtime.capabilities == Capabilities.full()
    assert runtime.costs == CostModel()
    assert runtime.live_source is not None
