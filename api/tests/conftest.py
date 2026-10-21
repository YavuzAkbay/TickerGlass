"""Shared fixtures: the user-data `client` / `race_client` (defined in test_userdata) and
the alerts `make_client` factory (defined in test_alerts)."""

import ipaddress
from collections.abc import Iterator

import pytest
from test_alerts import make_client  # noqa: F401
from test_userdata import client, race_client  # noqa: F401

from tickerglass_api.notifications import webhook
from tickerglass_api.settings import get_settings


@pytest.fixture(autouse=True)
def permissive_guard(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Apps built in tests get an upstream guard that never throttles or cools down, so
    fakes see every call. Tests of the guard itself construct it directly or override
    these settings."""
    for name, value in {
        "UPSTREAM_RATE_PER_MIN": "1e9",
        "UPSTREAM_BURST": "1000000",
        "UPSTREAM_COOLDOWN_MAX_S": "0",
        "UPSTREAM_UNAVAILABLE_COOLDOWN_S": "0",
    }.items():
        monkeypatch.setenv(name, value)
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest.fixture(autouse=True)
def fake_dns(monkeypatch: pytest.MonkeyPatch) -> dict[str, list[str]]:
    """No real DNS: IP literals resolve to themselves, other names to a public address unless
    a test maps them in the returned dict (e.g. `fake_dns["evil.example"] = ["10.0.0.5"]`)."""
    table: dict[str, list[str]] = {}

    def resolve(host: str, port: int) -> list[ipaddress.IPv4Address | ipaddress.IPv6Address]:
        try:
            return [ipaddress.ip_address(host.strip("[]"))]
        except ValueError:
            return [ipaddress.ip_address(a) for a in table.get(host, ["93.184.216.34"])]

    monkeypatch.setattr(webhook, "_resolve", resolve)
    return table
