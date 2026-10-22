"""Demo provider: deterministic, internally consistent, served through the normal API."""

from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from tickerglass_api.app import create_app
from tickerglass_api.providers.demo import DemoProvider
from tickerglass_api.settings import get_settings

# A Wednesday, 11:00 in New York (15:00 UTC in summer time).
NOW = datetime(2026, 6, 17, 15, 0, tzinfo=UTC)


def provider() -> DemoProvider:
    return DemoProvider(clock=lambda: NOW)


def test_daily_bars_are_deterministic_and_end_today() -> None:
    a = provider().history("GLSS", "1d", None, None, False)
    b = provider().history("GLSS", "1d", None, None, False)
    assert a.equals(b)
    assert len(a) > 5000
    last = datetime.fromtimestamp(int(a["ts"].iloc[-1]), UTC)
    assert last.date() == NOW.date()
    assert (a["high"] >= a[["open", "close"]].max(axis=1)).all()
    assert (a["low"] <= a[["open", "close"]].min(axis=1)).all()


def test_symbols_differ() -> None:
    p = provider()
    a = p.history("GLSS", "1d", None, None, False)["close"].iloc[-1]
    b = p.history("LENS", "1d", None, None, False)["close"].iloc[-1]
    assert a != b


def test_intraday_agrees_with_daily_and_stops_at_now() -> None:
    p = provider()
    start = NOW - timedelta(days=3)
    minutes = p.history("GLSS", "1m", start, None, False)
    daily = p.history("GLSS", "1d", None, None, False)
    assert int(minutes["ts"].iloc[-1]) <= NOW.timestamp()
    today = minutes[minutes["ts"] >= int(daily["ts"].iloc[-1])]
    assert today["close"].iloc[-1] == pytest.approx(daily["close"].iloc[-1])
    assert today["high"].max() == pytest.approx(daily["high"].iloc[-1])
    five = p.history("GLSS", "5m", start, None, False)
    assert len(five) == pytest.approx(len(minutes) / 5, abs=3)


def test_quotes_follow_the_bars() -> None:
    p = provider()
    quote = p.quotes(["glss"])[0]
    daily = p.history("GLSS", "1d", None, None, False)
    assert quote["symbol"] == "GLSS"
    assert quote["last"] == pytest.approx(daily["close"].iloc[-1])
    assert quote["prevClose"] == pytest.approx(daily["close"].iloc[-2])
    assert quote["marketState"] == "REGULAR"


def test_weekly_resample() -> None:
    weeks = provider().history("GLSS", "1wk", None, None, False)
    assert len(weeks) > 1000
    gaps = weeks["ts"].diff().dropna()
    assert (gaps >= 6 * 86400).all()


def test_app_serves_demo_data(monkeypatch: pytest.MonkeyPatch, tmp_path: object) -> None:
    monkeypatch.setenv("MARKET_PROVIDER", "demo")
    get_settings.cache_clear()
    app = create_app(database_url=f"sqlite:///{tmp_path}/demo.db")
    with TestClient(app) as client:
        info = client.get("/api/symbols/GLSS").json()
        assert info["exchange"] == "DEMO"
        bars = client.get("/api/bars", params={"symbol": "GLSS", "interval": "1d"}).json()
        assert len(bars["t"]) > 100


def test_providers_endpoint_and_connection_test(
    monkeypatch: pytest.MonkeyPatch, tmp_path: object
) -> None:
    monkeypatch.setenv("MARKET_PROVIDER", "demo")
    get_settings.cache_clear()
    app = create_app(database_url=f"sqlite:///{tmp_path}/p.db")
    with TestClient(app) as client:
        listing = client.get("/api/providers").json()
        assert listing["active"] == "demo"
        assert listing["setting"] == "MARKET_PROVIDER"
        assert {p["id"] for p in listing["providers"]} >= {"yahoo", "demo"}
        yahoo = next(p for p in listing["providers"] if p["id"] == "yahoo")
        assert yahoo["network"] is True and "personal use" in yahoo["terms"]
        test = client.post("/api/providers/test").json()
        assert test["ok"] is True
        assert test["symbol"] == "GLSS"
        assert test["price"] > 0


def test_custom_provider_reports_no_active_spec(tmp_path: object) -> None:
    app = create_app(
        provider=DemoProvider(clock=lambda: NOW), database_url=f"sqlite:///{tmp_path}/c.db"
    )
    with TestClient(app) as client:
        assert client.get("/api/providers").json()["active"] is None
