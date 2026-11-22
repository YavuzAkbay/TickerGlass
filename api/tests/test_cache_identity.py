"""The market data cache is marked with the provider id and, where the provider has one, its
cache identity (the crypto exchange, the Alpaca feed): another exchange serves other bars."""

from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine
from test_cache_source import counts, fill, marker

from tickerglass_api.app import create_app
from tickerglass_api.db import make_engine, run_migrations
from tickerglass_api.providers import alpaca, massive, stooq, tiingo
from tickerglass_api.providers.crypto import CryptoConfig
from tickerglass_api.providers.registry import PROVIDERS, cache_source, env_cache_source
from tickerglass_api.services.cache_source import ensure_cache_source
from tickerglass_api.settings import Settings


@pytest.fixture(autouse=True)
def clean_env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    for name in list(__import__("os").environ):
        if name.startswith(("CRYPTO_", "ALPACA_")):
            monkeypatch.delenv(name)
    monkeypatch.chdir(tmp_path)  # no .env of the developer


@pytest.fixture
def engine(tmp_path: Path) -> Engine:
    url = f"sqlite:///{tmp_path}/c.db"
    run_migrations(url)
    return make_engine(url)


def crypto_source(exchange: str, **kwargs: Any) -> str:
    config = CryptoConfig(exchange=exchange, _env_file=None, **kwargs)  # type: ignore[arg-type, call-arg]
    return cache_source(PROVIDERS["crypto"], config)


def test_providers_without_an_identity_keep_their_plain_id() -> None:
    # Caches written before identities existed carry the plain id: no wipe on upgrade.
    for pid in ("yahoo", "demo", "twelvedata"):
        assert cache_source(PROVIDERS[pid], None) == pid
    assert env_cache_source(PROVIDERS["yahoo"]) == "yahoo"


def test_crypto_cache_is_per_exchange_and_per_overridden_host() -> None:
    assert crypto_source("kraken") == "crypto:kraken"
    assert crypto_source("coinbase") == "crypto:coinbase"
    assert crypto_source("binance") == "crypto:binance"
    # The default host spelled another way is still the default.
    assert crypto_source("coinbase", base_url="https://API.Coinbase.com:443/") == "crypto:coinbase"
    # A mirror or proxy is its own source.
    assert (
        crypto_source("coinbase", base_url="https://Proxy.example.com:8443/x")
        == "crypto:coinbase@proxy.example.com:8443"
    )
    assert cache_source(PROVIDERS["crypto"], None) == "crypto"  # not configured yet


def test_env_cache_source_reads_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CRYPTO_EXCHANGE", "binance")
    assert env_cache_source(PROVIDERS["crypto"]) == "crypto:binance"
    monkeypatch.setenv("CRYPTO_EXCHANGE", "nonsense")  # invalid: leave the marker alone
    assert env_cache_source(PROVIDERS["crypto"]) is None
    # A provider with required settings missing: leave the marker alone.
    monkeypatch.delenv("ALPACA_KEY_ID", raising=False)
    assert env_cache_source(PROVIDERS["alpaca"]) is None


def alpaca_source(**kwargs: Any) -> str:
    config = alpaca.AlpacaConfig(
        key_id="k",  # type: ignore[arg-type]
        secret_key="s",  # type: ignore[arg-type]
        _env_file=None,  # type: ignore[call-arg]
        **kwargs,
    )
    return cache_source(PROVIDERS["alpaca"], config)


def test_alpaca_cache_follows_the_effective_feed() -> None:
    assert alpaca_source() == "alpaca:iex"
    assert alpaca_source(feed="sip") == "alpaca:iex"  # basic is always IEX
    assert alpaca_source(plan="algo_trader_plus") == "alpaca:sip"
    assert alpaca_source(plan="algo_trader_plus", feed="iex") == "alpaca:iex"


def test_base_url_providers_differ_only_on_another_host() -> None:
    for pid, module in (("massive", massive), ("tiingo", tiingo), ("stooq", stooq)):
        spec = PROVIDERS[pid]
        assert spec.config is not None
        make = spec.config
        default = make(api_key="key", _env_file=None)  # type: ignore[call-arg]
        assert cache_source(spec, default) == pid
        same = make(api_key="key", base_url=module.BASE_URL.upper() + "/", _env_file=None)  # type: ignore[call-arg]
        assert cache_source(spec, same) == pid
        mirror = make(api_key="key", base_url="https://mirror.example.com", _env_file=None)  # type: ignore[call-arg]
        assert cache_source(spec, mirror) == f"{pid}:mirror.example.com"


def test_changing_the_source_wipes_and_repeating_it_does_not(engine: Engine) -> None:
    ensure_cache_source(engine, "crypto:kraken")
    fill(engine)
    assert ensure_cache_source(engine, "crypto:kraken") is False
    assert counts(engine)["bars"] == 1
    assert ensure_cache_source(engine, "crypto:coinbase") is True
    assert counts(engine) == {"bars": 0, "series_meta": 0, "symbol_meta": 0, "notes": 1}
    assert marker(engine) == "crypto:coinbase"


def test_a_cache_without_a_marker_stays_valid_for_yahoo_and_is_wiped_for_crypto(
    engine: Engine,
) -> None:
    fill(engine)  # written by Yahoo before the marker existed
    assert ensure_cache_source(engine, cache_source(PROVIDERS["yahoo"], None)) is False
    assert marker(engine) == "yahoo" and counts(engine)["bars"] == 1
    assert ensure_cache_source(engine, crypto_source("kraken")) is True


def start(tmp_path: Path, provider: str = "crypto") -> TestClient:
    app = create_app(
        database_url=f"sqlite:///{tmp_path}/a.db",
        settings_override=Settings(_env_file=None, market_provider=provider),
    )
    return TestClient(app)


def test_restarting_on_another_crypto_exchange_wipes_the_cache(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    url = f"sqlite:///{tmp_path}/a.db"
    run_migrations(url)
    engine = make_engine(url)
    monkeypatch.setenv("CRYPTO_EXCHANGE", "kraken")
    with start(tmp_path):
        assert marker(engine) == "crypto:kraken"
    fill(engine)

    with start(tmp_path):  # the same exchange again
        pass
    assert marker(engine) == "crypto:kraken" and counts(engine)["bars"] == 1

    monkeypatch.setenv("CRYPTO_EXCHANGE", "coinbase")
    with start(tmp_path):
        pass
    assert marker(engine) == "crypto:coinbase"
    assert counts(engine) == {"bars": 0, "series_meta": 0, "symbol_meta": 0, "notes": 1}


def test_a_missing_key_at_startup_keeps_the_cache(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    url = f"sqlite:///{tmp_path}/a.db"
    run_migrations(url)
    engine = make_engine(url)
    monkeypatch.setenv("ALPACA_KEY_ID", "AKTESTKEYID0000000")
    monkeypatch.setenv("ALPACA_SECRET_KEY", "test-secret-key-000000000000")
    with start(tmp_path, "alpaca"):
        pass
    assert marker(engine) == "alpaca:iex"
    fill(engine)

    monkeypatch.delenv("ALPACA_KEY_ID")  # removed for a while: nothing is fetched
    with start(tmp_path, "alpaca"):
        pass
    assert marker(engine) == "alpaca:iex" and counts(engine)["bars"] == 1

    monkeypatch.setenv("ALPACA_KEY_ID", "AKTESTKEYID0000000")  # back: the cache is still good
    with start(tmp_path, "alpaca"):
        pass
    assert marker(engine) == "alpaca:iex" and counts(engine)["bars"] == 1
