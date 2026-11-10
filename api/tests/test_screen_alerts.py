"""Screen alerts: `evaluate_screens` over fixture snapshot rows, and the shared outbox."""

import asyncio
import threading
from collections.abc import Callable, Iterator
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session
from test_userdata import NullProvider

from tickerglass_api import models as m
from tickerglass_api.app import create_app
from tickerglass_api.live import LiveHub
from tickerglass_api.services.cache_source import ensure_cache_source
from tickerglass_api.services.screener import alerts as mod
from tickerglass_api.services.screener.alerts import evaluate_screens, fire_id, parse_state

D1, D2, D3 = date(2026, 11, 2), date(2026, 11, 3), date(2026, 11, 4)
NOW = datetime(2026, 11, 4, 22, 0, tzinfo=UTC)
SYMBOLS = ["AAA", "BBB", "CCC", "DDD"]


def spec(**kw: Any) -> dict[str, Any]:
    return {
        "schemaVersion": 1,
        "universe": {"kind": "symbols", "symbols": SYMBOLS},
        "filter": {"op": "and", "rules": [{"field": "rsi14", "op": "<", "value": 30}]},
        "sort": {"field": "rsi14", "dir": "asc"},
        **kw,
    }


def alert(**notify: bool) -> dict[str, Any]:
    return {
        "enabled": True,
        "notify": {"webhook": False, "telegram": False, "email": False, **notify},
    }


class Env:
    def __init__(self, client: TestClient) -> None:
        self.client = client
        self.app = client.app
        self.maker = self.app.state.sessionmaker  # type: ignore[attr-defined]
        self.published: list[dict[str, Any]] = []
        hub = self.app.state.live_hub  # type: ignore[attr-defined]
        orig = hub.publish_threadsafe

        def spy(topic: str, frame: dict[str, Any]) -> None:
            self.published.append({"topic": topic, **frame})
            orig(topic, frame)

        hub.publish_threadsafe = spy

    def seed(
        self, rsi: dict[str, float | None], as_of: date = D1, only: list[str] | None = None
    ) -> None:
        """One snapshot row per symbol (of `only`, default all) with the given rsi14 (tracked
        symbols are created once)."""
        with self.maker() as session:
            for i, sym in enumerate(SYMBOLS):
                if only is not None and sym not in only:
                    continue
                if session.get(m.ScreenerSymbol, sym) is None:
                    session.add(
                        m.ScreenerSymbol(
                            symbol=sym,
                            cls="stocks",
                            name=sym,
                            grp="g",
                            exchange=None,
                            rank=i + 1,
                            cap_static=None,
                            source="bundled",
                            updated_at=NOW,
                        )  # fmt: skip
                    )
                session.merge(
                    m.ScreenerSnapshot(
                        symbol=sym,
                        provider="demo",
                        as_of_date=as_of,
                        bar_ts=0,
                        computed_at=NOW,
                        bars_count=300,
                        last=10.0,
                        rsi14=rsi.get(sym),
                    )  # fmt: skip
                )
            session.commit()

    def screen(self, sid: str = "scr", name: str = "Oversold", **kw: Any) -> None:
        body = {"id": sid, "name": name, "spec": spec(), "alert": alert(), **kw}
        res = self.client.post("/api/screener/screens", json=body)
        assert res.status_code == 201, res.text

    def drop(self, *symbols: str) -> None:
        """Delete the snapshots of `symbols` (still tracked, now without data)."""
        with self.maker() as session:
            for sym in symbols:
                row = session.get(m.ScreenerSnapshot, sym)
                if row is not None:
                    session.delete(row)
            session.commit()

    def run(self, as_of: date, *, complete: bool = True) -> int:
        with self.maker() as session:
            return evaluate_screens(
                session,
                self.app.state.settings,  # type: ignore[attr-defined]
                as_of=as_of,
                hub=self.app.state.live_hub,  # type: ignore[attr-defined]
                dispatcher=self.app.state.dispatcher,  # type: ignore[attr-defined]
                now=NOW,
                complete=complete,
            )

    def logs(self) -> list[m.AlertLog]:
        with self.maker() as session:
            return list(session.scalars(select(m.AlertLog).order_by(m.AlertLog.id)))

    def deliveries(self) -> list[m.AlertDelivery]:
        with self.maker() as session:
            return list(session.scalars(select(m.AlertDelivery).order_by(m.AlertDelivery.id)))

    def state(self, sid: str = "scr") -> m.ScreenState | None:
        with self.maker() as session:
            return session.get(m.ScreenState, sid)

    def members(self, sid: str = "scr") -> list[str] | None:
        state = self.state(sid)
        parsed = parse_state(state.members) if state is not None else None
        return parsed[0] if parsed is not None else None

    def seen(self, sid: str = "scr") -> list[str] | None:
        state = self.state(sid)
        parsed = parse_state(state.members) if state is not None else None
        return parsed[1] if parsed is not None else None


@pytest.fixture
def env(tmp_path: Path) -> Iterator[Env]:
    app = create_app(provider=NullProvider(), database_url=f"sqlite:///{tmp_path}/a.db")
    with TestClient(app) as c:
        yield Env(c)


def test_first_evaluation_is_only_a_baseline(env: Env) -> None:
    env.seed({"AAA": 20, "BBB": 25, "CCC": 50})
    env.screen()
    assert env.run(D1) == 0
    assert env.logs() == [] and env.published == []
    state = env.state()
    assert state is not None and state.as_of == D1
    assert state.members == {"members": ["AAA", "BBB"], "seen": SYMBOLS}


def test_entered_symbols_log_once_with_deliveries(env: Env) -> None:
    env.seed({"AAA": 20, "CCC": 50, "DDD": 60})
    env.screen(alert=alert(webhook=True, telegram=True))
    env.client.patch("/api/screener/screens/scr", json={"alert": {
        "enabled": True,
        "notify": {"webhook": True, "telegram": True, "email": False,
                   "webhookUrl": "https://example.com/hook"}}})  # fmt: skip
    assert env.run(D1) == 0

    env.seed({"AAA": 25, "BBB": 10, "CCC": 29, "DDD": 70}, D2)  # BBB and CCC enter
    assert env.run(D2) == 1
    (entry,) = env.logs()
    assert entry.kind == "screen" and entry.alert_id is None and entry.interval == "1d"
    assert entry.fire_id == fire_id("scr", D2, ["BBB", "CCC"]) and entry.alert_name == "Oversold"
    assert len(entry.fire_id) <= 36
    assert entry.symbol == "BBB, CCC"  # sorted by rsi14 asc
    assert entry.message == "Screen 'Oversold': 2 new symbols — BBB, CCC"
    assert entry.values["screenId"] == "scr"
    assert entry.values["entered"] == ["BBB", "CCC"] and entry.values["exited"] == []
    assert entry.bar_time == int(datetime(2026, 11, 3, tzinfo=UTC).timestamp())
    assert entry.read is False and entry.final is False and entry.delayed is False

    dels = {d.channel: d for d in env.deliveries()}
    assert set(dels) == {"webhook", "telegram"}
    assert dels["webhook"].status == "pending"
    assert dels["webhook"].target == "https://example.com/hook"
    assert dels["telegram"].status == "failed" and dels["telegram"].last_error == "not configured"
    assert all(d.log_id == entry.id for d in dels.values())

    (frame,) = env.published
    assert frame["topic"] == "alerts" and frame["type"] == "alert.fired"
    assert frame["alert"] is None and frame["entry"]["alertId"] is None
    assert frame["entry"]["message"] == entry.message
    assert env.client.get("/api/alerts/log").json()["entries"][0]["message"] == entry.message


def test_rerun_of_same_date_is_idempotent(env: Env) -> None:
    env.seed({"AAA": 20})
    env.screen()
    env.run(D1)
    env.seed({"AAA": 20, "BBB": 10}, D2)
    assert env.run(D2) == 1
    assert env.run(D2) == 0
    assert len(env.logs()) == 1 and len(env.published) == 1

    # State lost (as after a spec edit) but the day was announced: no second entry either.
    with env.maker() as session:
        session.delete(session.get(m.ScreenState, "scr"))
        session.commit()
    assert env.run(D2) == 0  # becomes the baseline again
    assert len(env.logs()) == 1


def test_same_date_rerun_announces_late_entries(env: Env) -> None:
    """New members found on a re-run of an announced date are a new entry (only them)."""
    env.seed({"AAA": 20})
    env.screen()
    env.run(D1)
    env.seed({"AAA": 20, "BBB": 10}, D2)
    assert env.run(D2) == 1
    env.seed({"AAA": 20, "BBB": 10, "CCC": 5}, D2)
    assert env.run(D2) == 1
    first, second = env.logs()
    assert first.values["entered"] == ["BBB"] and second.values["entered"] == ["CCC"]
    assert first.fire_id != second.fire_id
    assert env.members() == ["AAA", "BBB", "CCC"]
    assert env.run(D2) == 0 and len(env.logs()) == 2


def test_exited_symbols_are_tracked(env: Env) -> None:
    env.seed({"AAA": 20, "BBB": 10})
    env.screen()
    env.run(D1)
    env.seed({"AAA": 60, "BBB": 10}, D2)  # AAA leaves, nothing enters: no alert
    assert env.run(D2) == 0 and env.logs() == []
    state = env.state()
    assert state is not None and env.members() == ["BBB"] and state.as_of == D2

    env.seed({"AAA": 10, "BBB": 60, "CCC": 11}, D3)  # AAA and CCC enter, BBB exits
    assert env.run(D3) == 1
    (entry,) = env.logs()
    assert entry.values["entered"] == ["AAA", "CCC"] and entry.values["exited"] == ["BBB"]
    assert entry.message == "Screen 'Oversold': 2 new symbols — AAA, CCC"


def test_single_symbol_message(env: Env) -> None:
    env.seed({})
    env.screen()
    env.run(D1)
    env.seed({"CCC": 1}, D2)
    env.run(D2)
    assert env.logs()[0].message == "Screen 'Oversold': 1 new symbol — CCC"


def test_disabled_and_missing_alerts_are_skipped(env: Env) -> None:
    env.seed({"AAA": 20})
    env.screen("off", "Off", alert={**alert(), "enabled": False})
    env.screen("none", "None", alert=None)
    assert env.run(D1) == 0
    assert env.state("off") is None and env.state("none") is None
    env.seed({"AAA": 20, "BBB": 10}, D2)
    assert env.run(D2) == 0 and env.logs() == []


def test_enabling_the_alert_starts_a_fresh_baseline(env: Env) -> None:
    env.seed({"AAA": 20})
    env.screen(alert=alert())
    env.run(D1)
    env.client.patch("/api/screener/screens/scr", json={"alert": {**alert(), "enabled": False}})
    env.seed({"AAA": 20, "BBB": 10}, D2)
    assert env.run(D2) == 0
    env.client.patch("/api/screener/screens/scr", json={"alert": alert()})  # state dropped
    assert env.run(D2) == 0  # baseline, not an alert for BBB
    env.seed({"AAA": 20, "BBB": 10, "CCC": 3}, D3)
    assert env.run(D3) == 1


def test_one_failing_screen_does_not_stop_the_others(
    env: Env, monkeypatch: pytest.MonkeyPatch
) -> None:
    env.seed({"AAA": 20})
    env.screen("bad", "Bad")
    env.screen("good", "Good")
    env.run(D1)
    env.seed({"AAA": 20, "BBB": 10}, D2)
    real: Callable[..., Any] = mod.scan_members

    def flaky(session: Session, settings: Any, row: m.Screen, *a: Any) -> list[str]:
        if row.id == "bad":
            raise RuntimeError("boom")
        return real(session, settings, row, *a)  # type: ignore[no-any-return]

    monkeypatch.setattr(mod, "scan_members", flaky)
    assert env.run(D2) == 1
    (entry,) = env.logs()
    assert entry.values["screenId"] == "good"


def test_scan_pages_through_all_matches(env: Env, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(mod, "PAGE", 1)
    env.seed({"AAA": 1, "BBB": 2, "CCC": 3, "DDD": 4})
    env.screen()
    env.run(D1)
    assert env.members() == SYMBOLS and env.seen() == SYMBOLS


def test_log_entry_prunes_to_log_max(env: Env) -> None:
    env.seed({})
    env.screen()
    env.run(D1)
    env.app.state.settings.alerts_log_max = 2  # type: ignore[attr-defined]
    for i, (day, sym) in enumerate(((D2, "AAA"), (D3, "BBB"), (date(2026, 11, 5), "CCC"))):
        env.seed({s: (10 if s in SYMBOLS[: i + 1] else 50) for s in SYMBOLS}, day)
        assert env.run(day) == 1, sym
    assert len(env.logs()) == 2


def test_symbol_column_and_message_are_bounded() -> None:
    many = [f"SYM{i:03d}" for i in range(200)]
    col = mod._symbols_column(many)
    assert len(col) == 128 and col.endswith("…") and col.startswith("SYM000, SYM001")
    assert mod._symbols_column(["A", "B"]) == "A, B"
    msg = mod._message("S", many)
    assert msg.startswith("Screen 'S': 200 new symbols — SYM000, SYM001")
    assert msg.endswith("SYM009, +190 more")


def test_evaluate_screens_is_safe_from_a_worker_thread(env: Env) -> None:
    """The screener job runs `evaluate_screens` via `asyncio.to_thread`: the real hub's
    `alert.fired` frame must reach its clients on the loop thread, not be published from the
    worker (and the dispatcher wake must not touch the loop from there either)."""
    env.seed({"AAA": 20})
    env.screen()
    assert env.run(D1) == 0
    env.seed({"AAA": 20, "BBB": 10}, D2)
    dispatcher = env.app.state.dispatcher  # type: ignore[attr-defined]
    wake_threads: list[int | None] = []
    real_wake = dispatcher.wake

    def wake() -> None:
        wake_threads.append(threading.get_ident())
        real_wake()

    dispatcher.wake = wake
    seen: dict[str, Any] = {}

    async def go() -> int:
        loop_thread = threading.get_ident()
        hub = LiveHub(None, lambda symbols: asyncio.sleep(0, {}))  # type: ignore[arg-type,return-value]
        hub.bind_loop(asyncio.get_running_loop())
        client = hub.register()
        hub.set_topics(client, ["alerts"])
        real_publish = hub.publish

        def publish(topic: str, frame: dict[str, Any]) -> None:
            seen["publish_thread_is_loop"] = threading.get_ident() == loop_thread
            real_publish(topic, frame)

        hub.publish = publish  # type: ignore[method-assign]

        def work() -> int:
            seen["worker"] = threading.get_ident()
            with env.maker() as session:
                return evaluate_screens(
                    session,
                    env.app.state.settings,  # type: ignore[attr-defined]
                    as_of=D2,
                    hub=hub,
                    dispatcher=dispatcher,
                    now=NOW,
                )

        fired = await asyncio.to_thread(work)
        while True:  # skip the status frame sent on registration
            frame = await asyncio.wait_for(client.queue.get(), 2)
            if frame["type"] != "status":
                seen["frame"] = frame
                break
        seen["loop"] = loop_thread
        return fired

    assert asyncio.run(go()) == 1
    assert seen["worker"] != seen["loop"]
    assert seen["publish_thread_is_loop"] is True
    assert seen["frame"]["type"] == "alert.fired" and seen["frame"]["topic"] == "alerts"
    assert seen["frame"]["entry"]["message"] == "Screen 'Oversold': 1 new symbol — BBB"
    assert wake_threads == [seen["worker"]]  # called from the worker, thread-safely


# ------------------------------------------------------------- coverage


def test_fire_id_fits_the_column() -> None:
    long_id = "x" * 36
    many = [f"SYM{i:04d}" for i in range(5000)]
    fid = fire_id(long_id, D2, many)
    assert fid.startswith("screen:") and len(fid) == 36
    assert m.AlertLog.__table__.c.fire_id.type.length == 36  # type: ignore[attr-defined]
    assert fire_id(long_id, D2, ["B", "A"]) == fire_id(long_id, D2, ["A", "B"])
    assert fire_id(long_id, D2, ["A"]) != fire_id(long_id, D2, ["A", "B"])
    assert fire_id(long_id, D2, ["A"]) != fire_id(long_id, D3, ["A"])
    assert fire_id("a", D2, ["A"]) != fire_id("b", D2, ["A"])


def test_members_without_current_data_are_carried(env: Env) -> None:
    env.seed({"AAA": 20, "BBB": 10})
    env.screen()
    env.run(D1)
    # D2: AAA's refresh failed (its D1 snapshot is stale), BBB lost its snapshot, CCC enters.
    env.seed({"CCC": 5}, D2, only=["CCC", "DDD"])
    env.drop("BBB")
    assert env.run(D2) == 1
    (entry,) = env.logs()
    assert entry.values["entered"] == ["CCC"] and entry.values["exited"] == []
    assert env.members() == ["AAA", "BBB", "CCC"]
    # D3: all current again; AAA no longer matches and exits, BBB is still in.
    env.seed({"BBB": 10, "CCC": 5}, D3)
    assert env.run(D3) == 0  # nothing entered: no entry
    assert env.members() == ["BBB", "CCC"]


def test_stale_matching_symbol_does_not_enter(env: Env) -> None:
    env.seed({"AAA": 20})
    env.screen()
    env.run(D1)
    old = date(2026, 10, 30)  # within the stale window, but not the D2 session's data
    env.seed({"BBB": 10}, old, only=["BBB"])  # matches, but on stale data
    env.seed({"AAA": 20}, D2, only=["AAA", "CCC", "DDD"])
    assert env.run(D2) == 0 and env.logs() == []
    assert env.members() == ["AAA"]
    env.seed({"AAA": 20, "BBB": 10}, D3)  # BBB current now: it enters
    assert env.run(D3) == 1
    assert env.logs()[0].values["entered"] == ["BBB"]


def test_first_snapshot_of_a_symbol_joins_silently(env: Env) -> None:
    env.seed({"AAA": 20})
    env.drop("CCC", "DDD")  # not covered yet
    env.screen()
    env.run(D1)
    assert env.seen() == ["AAA", "BBB"]
    env.seed({"AAA": 20, "CCC": 5, "DDD": 6}, D2)  # CCC/DDD first seen, already matching
    assert env.run(D2) == 0 and env.logs() == []
    assert env.members() == ["AAA", "CCC", "DDD"] and env.seen() == SYMBOLS
    env.seed({"AAA": 20, "BBB": 1, "CCC": 5, "DDD": 6}, D3)  # BBB was seen: it enters
    assert env.run(D3) == 1
    assert env.logs()[0].values["entered"] == ["BBB"]


def test_partial_run_takes_no_baseline_but_diffs(env: Env) -> None:
    env.seed({"AAA": 20})
    env.screen()
    assert env.run(D1, complete=False) == 0
    assert env.state() is None  # no baseline from a partial run
    assert env.run(D1) == 0 and env.members() == ["AAA"]
    env.seed({"AAA": 20, "BBB": 10}, D2, only=["BBB"])  # partial: only BBB refreshed
    assert env.run(D2, complete=False) == 1
    assert env.logs()[0].values["entered"] == ["BBB"]
    assert env.members() == ["AAA", "BBB"]


def test_legacy_list_state_is_rebaselined(env: Env) -> None:
    env.seed({"AAA": 20, "BBB": 10})
    env.screen()
    with env.maker() as session:
        session.add(m.ScreenState(screen_id="scr", as_of=D1, members=[], updated_at=NOW))
        session.commit()
    assert env.run(D2, complete=False) == 0  # legacy form: no diff from it
    assert env.state() is not None and env.members() is None
    assert env.run(D2) == 0 and env.logs() == []  # the new baseline
    assert env.members() == ["AAA", "BBB"]


def test_provider_switch_drops_screen_states(env: Env) -> None:
    engine = env.app.state.engine  # type: ignore[attr-defined]
    ensure_cache_source(engine, "one")
    env.seed({"AAA": 20})
    env.screen()
    env.run(D1)
    assert env.state() is not None
    assert ensure_cache_source(engine, "two")
    assert env.state() is None
    env.seed({"AAA": 20, "BBB": 10}, D2)  # the new provider's first data
    assert env.run(D2) == 0 and env.logs() == []  # a baseline, no burst


def test_failed_log_write_keeps_the_state(env: Env, monkeypatch: pytest.MonkeyPatch) -> None:
    """A write that fails (as a DataError would) leaves the state, so the next evaluation
    announces the same entrants instead of swallowing them."""
    env.seed({"AAA": 20})
    env.screen()
    env.run(D1)
    env.seed({"AAA": 20, "BBB": 10}, D2)
    real = mod.record_log_entry
    calls = 0

    def failing(*a: Any, **kw: Any) -> Any:
        nonlocal calls
        calls += 1
        if calls == 1:
            raise RuntimeError("value too long for type character varying(36)")
        return real(*a, **kw)

    monkeypatch.setattr(mod, "record_log_entry", failing)
    assert env.run(D2) == 0 and env.logs() == []
    state = env.state()
    assert state is not None and state.as_of == D1 and env.members() == ["AAA"]
    assert env.run(D2) == 1
    assert env.logs()[0].values["entered"] == ["BBB"]
    assert env.members() == ["AAA", "BBB"]
