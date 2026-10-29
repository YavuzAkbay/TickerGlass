"""`POST /api/providers/active` and what it reports: the HTTP side of switching providers.
The switcher itself is covered in test_stack_switch.py. Providers are offline fakes, never
Yahoo or Twelve Data."""

import threading
import time
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine
from test_stack_switch import (
    BlockingDemo,
    FakePaidConfig,
    _spec,
    counts,
    fill,
    marker,
    poll,
)

from tickerglass_api.app import create_app
from tickerglass_api.db import make_engine, run_migrations
from tickerglass_api.intervals import resolve_interval
from tickerglass_api.models import AppMeta
from tickerglass_api.providers.demo import DemoProvider
from tickerglass_api.providers.guard import UpstreamGuard
from tickerglass_api.providers.registry import PROVIDERS
from tickerglass_api.services.bars import BarService
from tickerglass_api.services.cache_gate import CacheGate, CacheRetired
from tickerglass_api.services.provider_choice import ACTIVE_PROVIDER_KEY
from tickerglass_api.services.stats import CacheStats
from tickerglass_api.services.symbols import SymbolService
from tickerglass_api.settings import Settings


@pytest.fixture
def blocking() -> BlockingDemo:
    return BlockingDemo()


@pytest.fixture(autouse=True)
def specs(monkeypatch: pytest.MonkeyPatch, blocking: BlockingDemo) -> None:
    monkeypatch.delenv("FAKEPAID_API_KEY", raising=False)
    monkeypatch.delenv("MARKET_PROVIDER", raising=False)
    monkeypatch.delenv("PROVIDER_SWITCHING", raising=False)
    monkeypatch.setitem(PROVIDERS, "fakefree", _spec("fakefree", lambda *_: blocking))
    monkeypatch.setitem(
        PROVIDERS,
        "fakepaid",
        _spec(
            "fakepaid",
            lambda *_: DemoProvider(),
            config=FakePaidConfig,
            plan=lambda _: "pro",
            setting_defaults=lambda _: {"quote_ttl_s": 77.0},
        ),
    )
    # The default MARKET_PROVIDER, offline.
    monkeypatch.setitem(PROVIDERS, "yahoo", _spec("yahoo", lambda *_: DemoProvider()))


@pytest.fixture
def db_url(tmp_path: Path) -> str:
    return f"sqlite:///{tmp_path}/p.db"


@pytest.fixture
def start(db_url: str) -> Iterator[Callable[..., TestClient]]:
    """Starts an app on the shared database; `start(**settings)` again is a restart."""
    clients: list[TestClient] = []

    def make(**settings: Any) -> TestClient:
        # No cooldown unless a test asks for one.
        s = Settings(
            _env_file=None,
            **{"live_poll_interval_s": 0.05, "provider_switch_cooldown_s": 0, **settings},
        )
        app = create_app(settings_override=s, database_url=db_url, live_poller=poll)
        client = TestClient(app)
        client.__enter__()
        clients.append(client)
        return client

    yield make
    for client in clients:
        client.__exit__(None, None, None)


def stored(client: TestClient) -> Any:
    with client.app.state.sessionmaker() as s:  # type: ignore[attr-defined]
        row = s.get(AppMeta, ACTIVE_PROVIDER_KEY)
        return None if row is None else row.value


def post(client: TestClient, provider_id: str) -> Any:
    return client.post("/api/providers/active", json={"id": provider_id})


def test_get_reports_switchable_and_who_chose(start: Callable[..., TestClient]) -> None:
    body = start(market_provider="fakefree").get("/api/providers").json()
    assert body["switchable"] is True and body["selectedBy"] == "env"
    assert body["active"] == "fakefree"
    # MARKET_PROVIDER not set: the default (Yahoo, faked here).
    default = start().get("/api/providers").json()
    assert default["selectedBy"] == "default" and default["active"] == "yahoo"


def test_post_switches_and_answers_like_get(
    start: Callable[..., TestClient], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("FAKEPAID_API_KEY", "k")
    client = start(market_provider="fakefree")
    fill(client)
    assert counts(client)["bars"] > 0

    resp = post(client, "fakepaid")

    assert resp.status_code == 200
    body = resp.json()
    assert body == client.get("/api/providers").json()
    assert body["active"] == "fakepaid" and body["selectedBy"] == "ui" and body["switchable"]
    assert body["effectiveLimits"]["quoteTtlS"] == 77.0
    after = counts(client)
    assert after["bars"] == after["series_meta"] == after["symbol_meta"] == 0
    assert after["notes"] == 1
    assert marker(client) == "fakepaid"
    assert stored(client) == {"id": "fakepaid", "env": "fakefree"}
    assert client.get("/api/bars", params={"symbol": "AAPL", "interval": "1d"}).status_code == 200


def test_the_active_provider_again_changes_nothing(start: Callable[..., TestClient]) -> None:
    client = start(market_provider="fakefree")
    fill(client)
    resp = post(client, "fakefree")
    assert resp.status_code == 200
    assert resp.json()["selectedBy"] == "env"
    assert stored(client) is None and counts(client)["bars"] > 0
    assert client.app.state.market_stack.generation == 0  # type: ignore[attr-defined]


def test_refusals_answer_detail_code_and_extras(start: Callable[..., TestClient]) -> None:
    client = start(market_provider="fakefree")
    fill(client)

    unknown = post(client, "nope")
    assert unknown.status_code == 422
    assert unknown.json()["code"] == "unknown_provider" and "nope" in unknown.json()["detail"]

    unconfigured = post(client, "fakepaid")  # no key in this environment
    assert unconfigured.status_code == 409
    body = unconfigured.json()
    assert body["code"] == "not_configured" and body["missing"] == ["FAKEPAID_API_KEY"]
    assert "FAKEPAID_API_KEY" in body["detail"]

    assert client.post("/api/providers/active", json={}).status_code == 422
    # Nothing changed.
    assert client.get("/api/providers").json()["active"] == "fakefree"
    assert stored(client) is None and marker(client) == "fakefree" and counts(client)["bars"] > 0


def test_switching_off_refuses_and_reports_not_switchable(
    start: Callable[..., TestClient],
) -> None:
    client = start(market_provider="fakefree", provider_switching=False)
    body = client.get("/api/providers").json()
    assert body["switchable"] is False and body["active"] == "fakefree"
    resp = post(client, "demo")
    assert resp.status_code == 403 and resp.json()["code"] == "switching_disabled"
    assert client.get("/api/providers").json()["active"] == "fakefree"


def test_a_custom_provider_is_not_switchable(db_url: str) -> None:
    app = create_app(
        provider=DemoProvider(), settings_override=Settings(_env_file=None), database_url=db_url
    )
    with TestClient(app) as client:
        body = client.get("/api/providers").json()
        assert body["active"] is None and body["switchable"] is False
        resp = post(client, "demo")
        assert resp.status_code == 409 and resp.json()["code"] == "custom_provider"


def test_concurrent_posts_are_serialized(
    start: Callable[..., TestClient], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("FAKEPAID_API_KEY", "k")
    client = start(market_provider="fakefree")
    statuses: list[int] = []

    def go(provider_id: str) -> None:
        statuses.append(post(client, provider_id).status_code)

    threads = [threading.Thread(target=go, args=(p,)) for p in ("fakepaid", "demo", "fakefree")]
    for t in threads:
        t.start()
    for t in threads:
        t.join(20)
    assert statuses == [200, 200, 200]
    active = client.get("/api/providers").json()["active"]
    assert marker(client) == active  # the cache holds what the last switch left
    assert client.app.state.market_stack.runtime.spec.id == active  # type: ignore[attr-defined]


def test_export_does_not_carry_the_choice(start: Callable[..., TestClient]) -> None:
    client = start(market_provider="fakefree")
    assert post(client, "demo").status_code == 200
    assert stored(client) is not None
    exported = client.get("/api/export")
    assert exported.status_code == 200
    assert "active_provider" not in exported.text and "cache_source" not in exported.text


def test_the_choice_survives_a_restart_until_the_environment_changes(
    start: Callable[..., TestClient],
) -> None:
    first = start(market_provider="fakefree")
    assert post(first, "demo").status_code == 200
    first.__exit__(None, None, None)

    again = start(market_provider="fakefree").get("/api/providers").json()
    assert again["active"] == "demo" and again["selectedBy"] == "ui"

    # MARKET_PROVIDER edited: the environment is newer than the choice.
    moved = start(market_provider="yahoo")
    body = moved.get("/api/providers").json()
    assert body["active"] == "yahoo" and body["selectedBy"] == "env"
    assert stored(moved) is None


def test_switching_off_ignores_the_stored_choice(start: Callable[..., TestClient]) -> None:
    first = start(market_provider="fakefree")
    assert post(first, "demo").status_code == 200
    first.__exit__(None, None, None)

    locked = start(market_provider="fakefree", provider_switching=False)
    body = locked.get("/api/providers").json()
    assert body["active"] == "fakefree" and body["switchable"] is False
    assert body["selectedBy"] == "env"
    assert stored(locked) == {"id": "demo", "env": "fakefree"}  # kept for when it is on again


def test_a_read_after_the_switch_is_refused(start: Callable[..., TestClient]) -> None:
    """`sync` finished on the old stack, the switch wiped the cache, then the read ran."""
    client = start(market_provider="fakefree")
    state = client.app.state  # type: ignore[attr-defined]
    old_bars = state.bar_service
    sync = old_bars.sync

    def sync_then_switch(*args: Any, **kwargs: Any) -> None:
        sync(*args, **kwargs)
        client.portal.call(state.switcher.switch, "demo")  # type: ignore[union-attr]

    old_bars.sync = sync_then_switch
    resp = client.get("/api/bars", params={"symbol": "AAPL", "interval": "1d"})
    assert resp.status_code == 503 and resp.headers["retry-after"] == "1"
    assert resp.json() == {"detail": "data source changed; retry", "code": "provider_switched"}
    assert state.provider_spec.id == "demo"
    after = counts(client)
    assert after["bars"] == after["series_meta"] == after["symbol_meta"] == 0
    assert client.get("/api/bars", params={"symbol": "AAPL", "interval": "1d"}).status_code == 200


@pytest.fixture
def engine(db_url: str) -> Engine:
    run_migrations(db_url)
    return make_engine(db_url)


def test_symbol_info_read_after_the_switch_is_refused(engine: Engine) -> None:
    gate = CacheGate()
    service = SymbolService(engine, DemoProvider(), stats=CacheStats(), gate=gate, generation=0)
    service.info("AAPL")  # stored
    assert service.info("AAPL")  # served from the store
    gate.advance()
    with pytest.raises(CacheRetired):
        service.info("AAPL")  # a stored row is read, but not by the current generation


def test_bar_service_read_after_the_switch_is_refused(engine: Engine) -> None:
    gate = CacheGate()
    service = BarService(engine, DemoProvider(), stats=CacheStats(), gate=gate, generation=0)
    spec = resolve_interval("1d")
    assert not service.get_bars("AAPL", spec, False).bars.empty
    gate.advance()
    with pytest.raises(CacheRetired):
        service.get_bars("AAPL", spec, False)


def test_a_second_switch_within_the_cooldown_is_refused_with_retry_after(
    start: Callable[..., TestClient],
) -> None:
    client = start(market_provider="fakefree", provider_switch_cooldown_s=60)
    assert post(client, "demo").status_code == 200  # the first one is free
    again = post(client, "fakefree")
    assert again.status_code == 429
    body = again.json()
    assert body["code"] == "switch_cooldown" and "retry in" in body["detail"]
    assert 1 <= int(again.headers["retry-after"]) <= 60
    # Nothing changed; the active provider again is not a switch, so not refused.
    assert client.get("/api/providers").json()["active"] == "demo"
    assert marker(client) == "demo" and stored(client) == {"id": "demo", "env": "fakefree"}
    assert post(client, "demo").status_code == 200


def test_the_cooldown_ends_and_refused_or_failed_switches_do_not_start_it(
    start: Callable[..., TestClient], monkeypatch: pytest.MonkeyPatch
) -> None:
    client = start(market_provider="fakefree", provider_switch_cooldown_s=0.3)
    assert post(client, "nope").status_code == 422
    assert post(client, "fakepaid").status_code == 409  # not configured
    assert post(client, "demo").status_code == 200  # still the first switch
    assert post(client, "fakefree").status_code == 429
    time.sleep(0.4)
    assert post(client, "fakefree").status_code == 200


class SeenPriority(DemoProvider):
    """Demo data; remembers the guard priority each upstream call ran at."""

    def __init__(self) -> None:
        super().__init__()
        self.seen: list[str] = []

    def history(self, *args: Any, **kwargs: Any) -> Any:
        self.seen.append(UpstreamGuard.current_priority())
        return super().history(*args, **kwargs)

    def symbol_info(self, symbol: str) -> dict[str, Any]:
        self.seen.append(UpstreamGuard.current_priority())
        return super().symbol_info(symbol)


@pytest.mark.parametrize(
    ("header", "expected"),
    [
        (None, "interactive"),
        ("visible", "visible"),
        ("background", "background"),
        ("Background", "background"),
        ("prefetch", "interactive"),  # not offered to clients
        ("urgent", "interactive"),
        ("", "interactive"),
    ],
)
def test_bars_and_symbol_info_run_at_the_priority_the_header_asks_for(
    db_url: str, header: str | None, expected: str
) -> None:
    provider = SeenPriority()
    app = create_app(
        provider=provider, settings_override=Settings(_env_file=None), database_url=db_url
    )
    headers = {} if header is None else {"X-TickerGlass-Priority": header}
    with TestClient(app) as client:
        bars = client.get("/api/bars", params={"symbol": "AAPL", "interval": "1d"}, headers=headers)
        assert bars.status_code == 200
        info = client.get("/api/symbols/MSFT", headers=headers)
        assert info.status_code == 200
    assert provider.seen
    assert set(provider.seen) == {expected}
