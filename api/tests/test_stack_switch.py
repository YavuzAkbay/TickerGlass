"""`ProviderSwitcher.switch`: the app moves to another provider while it runs. Called
directly (there is no endpoint yet); providers are offline fakes, never Yahoo or Twelve Data."""

import asyncio
import threading
import time
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import pandas as pd
import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy import func, select

from tickerglass_api.app import create_app
from tickerglass_api.models import AppMeta, Bar, Note, SeriesMeta, SymbolMeta
from tickerglass_api.providers.demo import DemoProvider
from tickerglass_api.providers.registry import PROVIDERS, ProviderSpec
from tickerglass_api.services.cache_source import CACHE_SOURCE_KEY
from tickerglass_api.settings import Settings
from tickerglass_api.stack import MarketStack, ProviderSwitcher, SwitchRefused


class FakePaidConfig(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="FAKEPAID_", env_file=None, extra="ignore")

    api_key: SecretStr


class BlockingDemo(DemoProvider):
    """Demo data whose `history` waits for `release` once `block` is set."""

    def __init__(self) -> None:
        super().__init__()
        self.block = False
        self.in_history = threading.Event()
        self.release = threading.Event()

    def history(self, *args: Any, **kwargs: Any) -> pd.DataFrame:
        frame = super().history(*args, **kwargs)
        if self.block:
            self.in_history.set()
            assert self.release.wait(10)
        return frame


def _spec(pid: str, make: Callable[..., Any], **kw: Any) -> ProviderSpec:
    return ProviderSpec(
        id=pid,
        name=pid.title(),
        description="test provider",
        network=False,
        terms=None,
        probe_symbol="GLSS",
        make=make,
        **kw,
    )


@pytest.fixture
def blocking() -> BlockingDemo:
    return BlockingDemo()


@pytest.fixture(autouse=True)
def specs(monkeypatch: pytest.MonkeyPatch, blocking: BlockingDemo) -> None:
    monkeypatch.delenv("FAKEPAID_API_KEY", raising=False)
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


async def poll(symbols: list[str]) -> dict[str, dict[str, Any]]:
    return {s: {"price": 10.0 + time.monotonic() % 1} for s in symbols}


@pytest.fixture
def make_app(tmp_path: Path) -> Iterator[Callable[..., TestClient]]:
    clients: list[TestClient] = []

    def make(start: str = "fakefree", **settings: Any) -> TestClient:
        # No cooldown unless a test asks for one.
        s = Settings(
            _env_file=None,
            market_provider=start,
            **{"live_poll_interval_s": 0.05, "provider_switch_cooldown_s": 0, **settings},
        )
        app = create_app(
            settings_override=s, database_url=f"sqlite:///{tmp_path}/s.db", live_poller=poll
        )
        client = TestClient(app)
        client.__enter__()
        clients.append(client)
        return client

    yield make
    for client in clients:
        client.__exit__(None, None, None)


def switcher_of(client: TestClient) -> ProviderSwitcher:
    sw: ProviderSwitcher = client.app.state.switcher  # type: ignore[attr-defined]
    return sw


def switch(client: TestClient, provider_id: str) -> MarketStack:
    return client.portal.call(switcher_of(client).switch, provider_id)  # type: ignore[no-any-return, union-attr]


def counts(client: TestClient) -> dict[str, int]:
    with client.app.state.sessionmaker() as s:  # type: ignore[attr-defined]
        return {
            m.__tablename__: s.scalar(select(func.count()).select_from(m)) or 0
            for m in (Bar, SeriesMeta, SymbolMeta, Note)
        }


def marker(client: TestClient) -> str | None:
    with client.app.state.sessionmaker() as s:  # type: ignore[attr-defined]
        row = s.get(AppMeta, CACHE_SOURCE_KEY)
        return None if row is None else str(row.value)


def fill(client: TestClient) -> None:
    assert client.get("/api/bars", params={"symbol": "AAPL", "interval": "1d"}).status_code == 200
    assert client.get("/api/symbols/AAPL").status_code == 200
    assert client.post("/api/notes", json={"symbol": "AAPL", "text": "keep me"}).status_code in (
        200,
        201,
    )


def test_switch_swaps_the_stack_wipes_the_cache_and_keeps_user_data(
    make_app: Callable[..., TestClient], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("FAKEPAID_API_KEY", "k")
    client = make_app()
    state = client.app.state  # type: ignore[attr-defined]
    old = state.market_stack
    assert old.generation == 0 and old.selected_by == "env" and marker(client) == "fakefree"
    fill(client)
    before = counts(client)
    assert before["bars"] > 0 and before["symbol_meta"] > 0 and before["notes"] == 1

    new = switch(client, "fakepaid")

    assert new is state.market_stack and new is not old
    assert new.generation == 1 and new.selected_by == "ui"
    assert state.provider_spec.id == "fakepaid" and state.runtime is new.runtime
    assert state.bar_service is new.bar_service is not old.bar_service
    assert state.symbol_service is new.symbol_service
    assert state.market_service is new.market_service
    assert state.capabilities is new.runtime.capabilities
    assert state.upstream_guard is new.runtime.guard is not old.runtime.guard
    assert state.settings.quote_ttl_s == 77.0
    limits = client.get("/api/providers").json()["effectiveLimits"]
    assert limits["quoteTtlS"] == 77.0
    after = counts(client)
    assert after["bars"] == after["series_meta"] == after["symbol_meta"] == 0
    assert after["notes"] == 1
    assert marker(client) == "fakepaid"
    # The old stack is retired: its refresher takes no more work.
    with pytest.raises(RuntimeError):
        old.refresher.submit(lambda: None)
    # The new one serves and caches.
    assert client.get("/api/bars", params={"symbol": "AAPL", "interval": "1d"}).status_code == 200
    assert counts(client)["bars"] > 0


def test_switching_to_the_active_provider_changes_nothing(
    make_app: Callable[..., TestClient],
) -> None:
    client = make_app()
    fill(client)
    old = client.app.state.market_stack  # type: ignore[attr-defined]
    assert switch(client, "fakefree") is old
    assert client.app.state.market_stack is old  # type: ignore[attr-defined]
    assert old.generation == 0 and counts(client)["bars"] > 0 and marker(client) == "fakefree"


def refused(client: TestClient, provider_id: str) -> SwitchRefused:
    with pytest.raises(SwitchRefused) as err:
        switch(client, provider_id)
    return err.value


def test_refusals_leave_everything_as_it_was(make_app: Callable[..., TestClient]) -> None:
    client = make_app()
    fill(client)
    old = client.app.state.market_stack  # type: ignore[attr-defined]

    unknown = refused(client, "nope")
    assert (unknown.status, unknown.code) == (422, "unknown_provider")
    # fakepaid has no key in this environment.
    unconfigured = refused(client, "fakepaid")
    assert (unconfigured.status, unconfigured.code) == (409, "not_configured")
    assert unconfigured.extra["missing"] == ["FAKEPAID_API_KEY"]
    assert "FAKEPAID_API_KEY" in unconfigured.detail
    switcher_of(client).switching_enabled = False
    disabled = refused(client, "demo")
    assert (disabled.status, disabled.code) == (403, "switching_disabled")

    assert client.app.state.market_stack is old  # type: ignore[attr-defined]
    assert old.generation == 0 and client.app.state.cache_gate.generation == 0  # type: ignore[attr-defined]
    assert counts(client)["bars"] > 0 and marker(client) == "fakefree"


def test_a_custom_provider_cannot_be_switched(tmp_path: Path) -> None:
    app = create_app(
        provider=DemoProvider(),
        settings_override=Settings(_env_file=None),
        database_url=f"sqlite:///{tmp_path}/c.db",
    )
    with TestClient(app) as client:
        err = refused(client, "demo")
        assert (err.status, err.code) == (409, "custom_provider")


def test_concurrent_switches_are_serialized(
    make_app: Callable[..., TestClient], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("FAKEPAID_API_KEY", "k")
    client = make_app()
    fill(client)
    sw = switcher_of(client)

    async def both() -> list[Any]:
        return await asyncio.gather(
            sw.switch("fakepaid"), sw.switch("demo"), sw.switch("fakefree"), return_exceptions=True
        )

    results = client.portal.call(both)  # type: ignore[union-attr]
    assert all(isinstance(r, MarketStack) for r in results)
    final = client.app.state.market_stack  # type: ignore[attr-defined]
    assert final is results[-1] and final.runtime.spec.id == "fakefree"
    assert final.generation == 3
    assert marker(client) == "fakefree"  # the cache holds what the last switch left


def test_a_request_in_flight_across_a_switch_is_refused_and_caches_nothing(
    make_app: Callable[..., TestClient], blocking: BlockingDemo
) -> None:
    client = make_app()
    blocking.block = True
    answer: list[Any] = []
    request = threading.Thread(
        target=lambda: answer.append(
            client.get("/api/bars", params={"symbol": "AAPL", "interval": "1d"})
        )
    )
    request.start()
    assert blocking.in_history.wait(10)
    switch(client, "demo")  # wipes while the old provider's fetch is still out
    blocking.release.set()
    request.join(10)
    assert not request.is_alive()
    resp = answer[0]
    assert resp.status_code == 503 and resp.headers["retry-after"] == "1"
    assert resp.json() == {"detail": "data source changed; retry", "code": "provider_switched"}
    after = counts(client)
    assert after["bars"] == after["series_meta"] == after["symbol_meta"] == 0
    # Asked again, the new stack answers.
    assert client.get("/api/bars", params={"symbol": "AAPL", "interval": "1d"}).status_code == 200


def test_live_clients_stay_connected_and_hear_of_the_switch(
    make_app: Callable[..., TestClient],
) -> None:
    client = make_app()
    with client.websocket_connect("/ws") as ws:
        ws.send_json({"op": "subscribe", "symbols": ["AAPL"]})
        seen = frames_until(ws, lambda f: f["type"] == "tick")
        assert seen[-1]["symbol"] == "AAPL"

        switch(client, "demo")

        seen = frames_until(ws, lambda f: f["type"] == "provider.changed")
        assert seen[-1] == {"type": "provider.changed", "id": "demo", "previous": "fakefree"}
        # No resubscribe: ticks of the new provider's poller keep arriving.
        ticks = frames_until(ws, lambda f: f["type"] == "tick")
        assert ticks[-1]["symbol"] == "AAPL"


def frames_until(ws: Any, done: Callable[[dict[str, Any]], bool]) -> list[dict[str, Any]]:
    frames: list[dict[str, Any]] = []
    for _ in range(200):
        frame: dict[str, Any] = ws.receive_json()
        frames.append(frame)
        if done(frame):
            return frames
    raise AssertionError(f"never saw the frame: {frames[-5:]}")


def test_maintenance_moves_to_the_new_stack(make_app: Callable[..., TestClient]) -> None:
    client = make_app(cache_maintenance_enabled=True)
    old = client.app.state.market_stack  # type: ignore[attr-defined]
    assert old.maintenance._task is not None
    new = switch(client, "demo")
    assert old.maintenance._task is None
    assert new.maintenance._task is not None
    assert client.app.state.cache_maintenance is new.maintenance  # type: ignore[attr-defined]


def test_a_failed_wipe_keeps_the_old_provider_and_the_cache(
    make_app: Callable[..., TestClient], monkeypatch: pytest.MonkeyPatch
) -> None:
    client = make_app()
    fill(client)
    old = client.app.state.market_stack  # type: ignore[attr-defined]

    def boom(*_: Any) -> bool:
        raise OSError("disk full")

    monkeypatch.setattr("tickerglass_api.stack.ensure_cache_source", boom)
    err = refused(client, "demo")
    assert (err.status, err.code) == (503, "switch_failed")
    monkeypatch.undo()

    now = client.app.state.market_stack  # type: ignore[attr-defined]
    assert now.runtime.spec.id == "fakefree" and now.selected_by == "env"
    # Rebuilt under a newer generation: the old stack's writes are fenced off, the new one's work.
    assert now is not old and now.generation == 1
    assert counts(client)["bars"] > 0 and marker(client) == "fakefree"
    assert client.get("/api/bars", params={"symbol": "MSFT", "interval": "1d"}).status_code == 200


def test_a_failed_wipe_does_not_reset_the_live_hub(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The same upstream keeps running: no reconfigure, no early re-poll of the symbols."""
    batches: list[list[str]] = []

    async def counting(symbols: list[str]) -> dict[str, dict[str, Any]]:
        batches.append(list(symbols))
        return await poll(symbols)

    settings = Settings(
        _env_file=None,
        market_provider="fakefree",
        live_poll_interval_s=60,
        provider_switch_cooldown_s=0,
    )
    app = create_app(
        settings_override=settings, database_url=f"sqlite:///{tmp_path}/r.db", live_poller=counting
    )
    with TestClient(app) as client:
        hub = app.state.live_hub
        with client.websocket_connect("/ws") as ws:
            ws.send_json({"op": "subscribe", "symbols": ["AAPL"]})
            frames_until(ws, lambda f: f["type"] == "tick")
            polled, last_poll, tasks = len(batches), dict(hub._last_poll), list(hub._tasks)
            assert polled == 1 and last_poll and tasks
            old = app.state.market_stack

            async def no_reconfigure(*_: Any, **__: Any) -> None:
                raise AssertionError("the hub must not be reconfigured")

            given: list[Any] = []
            set_poller = hub.set_poller
            monkeypatch.setattr(hub, "reconfigure", no_reconfigure)
            monkeypatch.setattr(hub, "set_poller", lambda *a: (given.append(a), set_poller(*a))[1])

            def boom(*_: Any) -> bool:
                raise OSError("disk full")

            monkeypatch.setattr("tickerglass_api.stack.ensure_cache_source", boom)
            err = refused(client, "demo")

            assert (err.status, err.code) == (503, "switch_failed")
            new = app.state.market_stack
            assert new is not old and new.runtime is old.runtime
            assert [a[1] for a in given] == [new.symbol_service.cached_info]
            time.sleep(0.8)  # more than the poller's tick: a reset would be polled by now
            assert len(batches) == polled
            assert hub._last_poll == last_poll
            assert hub._tasks == tasks and not any(t.done() for t in tasks)


def test_a_switch_after_shutdown_began_is_refused_as_shutting_down(
    make_app: Callable[..., TestClient],
) -> None:
    client = make_app()
    client.portal.call(switcher_of(client).close)  # type: ignore[union-attr]
    err = refused(client, "demo")
    assert (err.status, err.code) == (503, "shutting_down")


def test_shutdown_closes_the_switcher_before_the_hub(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A switch in progress is waited for, and none starts later, so the hub is never
    handed a new upstream after it closed."""
    order: list[str] = []
    app = create_app(
        settings_override=Settings(_env_file=None, market_provider="fakefree"),
        database_url=f"sqlite:///{tmp_path}/o.db",
        live_poller=poll,
    )
    with TestClient(app):
        for name, target in (("switcher", app.state.switcher), ("hub", app.state.live_hub)):
            original = target.close

            async def wrapped(name: str = name, original: Any = original) -> None:
                order.append(name)
                await original()

            monkeypatch.setattr(target, "close", wrapped)
    assert order == ["switcher", "hub"]
