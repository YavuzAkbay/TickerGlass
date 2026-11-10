"""Screen alerts (docs/design/server-screener.md §4, §5): after a snapshot run, every screen
with `alert.enabled` is scanned again and symbols that entered it since the last evaluation
are logged as one `screen` entry of the alert log (and delivered like any other fire).

Coverage. Only *evaluable* symbols take part in the diff: in the screen's universe, with a
snapshot that is current for the target session (`ScanRow.stale` false). A member that is not
evaluable now (failed refresh, credit rotation, too old) is carried forward: it neither enters
nor exits. A symbol can enter only if it was evaluable at an earlier evaluation and was not a
member then (`seen`), so symbols whose first snapshot arrives late join silently. The state is
`{"members": [...], "seen": [...]}` (a bare list is the pre-`seen` form and is re-baselined).
A baseline is taken from a complete (`done`) run only; after a partial run a screen without
state is skipped.
"""

import hashlib
import logging
from datetime import UTC, date, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ... import models as m
from ...live import LiveHub
from ...notifications.dispatcher import Dispatcher
from ...notifications.outbox import record_log_entry
from ...settings import Settings
from ...userdata import alerts as al
from ...userdata import screens as sc
from .query import run_scan
from .schemas import ScanRequest, ScanRow

log = logging.getLogger(__name__)

PAGE = 500
#: Most members of one screen the evaluation tracks.
MAX_MEMBERS = 5000
#: Longest `entered` / `exited` list stored in a log entry's values (counts are exact).
MAX_LISTED = 500
#: Symbols named in the message before "+N more".
MESSAGE_SYMBOLS = 10
SYMBOL_COLUMN = 128
#: `alert_log.fire_id` is `String(36)`.
FIRE_ID_MAX = 36
_FIRE_PREFIX = "screen:"
#: Stale window of the universe scan: every universe symbol is listed, however old.
_ALL_DAYS = 36500


def fire_id(screen_id: str, as_of: date, entered: list[str]) -> str:
    """`screen:` + 29 hex digits of a hash of the screen, the date and the entered set: a
    re-run of the same date with other entrants is a new entry, the same one is not."""
    key = f"{screen_id}:{as_of.isoformat()}:{','.join(sorted(entered))}"
    digest = hashlib.sha1(key.encode(), usedforsecurity=False).hexdigest()
    return _FIRE_PREFIX + digest[: FIRE_ID_MAX - len(_FIRE_PREFIX)]


def _scan(
    session: Session,
    settings: Settings,
    row: m.Screen,
    now: datetime,
    *,
    target: date | None,
    filtered: bool,
    cap: int | None,
) -> list[ScanRow]:
    spec = row.spec
    out: list[ScanRow] = []
    offset = 0
    while cap is None or len(out) < cap:
        req = ScanRequest.model_validate(
            {
                "universe": spec["universe"],
                "filter": spec.get("filter") if filtered else None,
                "sort": spec["sort"],
                "limit": PAGE,
                "offset": offset,
                "fields": [],
            }
        )
        res = run_scan(session, req, settings=settings, now=now, target=target)
        out.extend(res.rows)
        offset += PAGE
        if not res.rows or offset >= res.total:
            break
    return out[:cap] if cap is not None else out


def scan_members(
    session: Session, settings: Settings, row: m.Screen, now: datetime, target: date | None = None
) -> list[str]:
    """Symbols matching the screen, in its sort order (at most `MAX_MEMBERS`)."""
    rows = _scan(session, settings, row, now, target=target, filtered=True, cap=MAX_MEMBERS)
    return [r.symbol for r in rows]


def scan_coverage(
    session: Session, settings: Settings, row: m.Screen, now: datetime, target: date | None = None
) -> tuple[set[str], set[str]]:
    """(universe, evaluable): every tracked symbol of the screen's universe, and those with a
    snapshot current for `target`."""
    wide = settings.model_copy(update={"screener_stale_days": _ALL_DAYS})
    rows = _scan(session, wide, row, now, target=target, filtered=False, cap=None)
    universe = {r.symbol for r in rows}
    snapped = set(
        session.scalars(
            select(m.ScreenerSnapshot.symbol).where(m.ScreenerSnapshot.symbol.in_(universe))
        )
    )
    return universe, {r.symbol for r in rows if not r.stale and r.symbol in snapped}


def parse_state(raw: Any) -> tuple[list[str], list[str]] | None:
    """(members, seen) of a stored state; None for the legacy bare list (re-baselined)."""
    if not isinstance(raw, dict):
        return None
    members, seen = raw.get("members"), raw.get("seen")
    if not isinstance(members, list) or not isinstance(seen, list):
        return None
    return [str(x) for x in members], [str(x) for x in seen]


def _symbols_column(entered: list[str]) -> str:
    text = ", ".join(entered)
    return text if len(text) <= SYMBOL_COLUMN else text[: SYMBOL_COLUMN - 1] + "…"


def _message(name: str, entered: list[str]) -> str:
    n = len(entered)
    shown = ", ".join(entered[:MESSAGE_SYMBOLS])
    if n > MESSAGE_SYMBOLS:
        shown += f", +{n - MESSAGE_SYMBOLS} more"
    noun = "symbol" if n == 1 else "symbols"
    return f"Screen '{name}': {n} new {noun} — {shown}"


def _notify(alert: dict[str, Any] | None) -> al.AlertNotify:
    n = sc.alert_notify(alert)
    return al.AlertNotify(
        toast=True, sound=True, webhook=n.webhook, webhook_url=n.webhook_url,
        telegram=n.telegram, email=n.email,
    )  # fmt: skip


def _store_state(
    session: Session, screen_id: str, as_of: date, members: set[str], seen: set[str]
) -> None:
    payload = {"members": sorted(members), "seen": sorted(seen)}
    stamp = datetime.now(UTC)
    state = session.get(m.ScreenState, screen_id)
    if state is None:
        session.add(
            m.ScreenState(screen_id=screen_id, as_of=as_of, members=payload, updated_at=stamp)
        )
    else:
        state.as_of, state.members, state.updated_at = as_of, payload, stamp


def _evaluate(
    session: Session,
    settings: Settings,
    row: m.Screen,
    *,
    as_of: date,
    complete: bool,
    hub: LiveHub,
    dispatcher: Dispatcher,
    now: datetime,
) -> bool:
    """Evaluate one screen; True if it logged an alert."""
    state = session.get(m.ScreenState, row.id)
    if state is not None and state.as_of > as_of:
        return False  # a newer evaluation already ran
    prior = parse_state(state.members) if state is not None else None
    if prior is None and not complete:
        return False  # no baseline from a partial run
    screen_id, name, alert = row.id, row.name, row.alert
    matching = scan_members(session, settings, row, now, as_of)
    universe, evaluable = scan_coverage(session, settings, row, now, as_of)
    now_in = [x for x in matching if x in evaluable]
    if prior is None:
        _store_state(session, screen_id, as_of, set(now_in), evaluable)
        session.commit()  # first evaluation is only the baseline
        return False

    old_members, old_seen = set(prior[0]), set(prior[1])
    carried = {x for x in old_members if x in universe and x not in evaluable}
    members = set(now_in) | carried
    seen = (old_seen | evaluable) & universe
    entered = [x for x in now_in if x not in old_members and x in old_seen]
    exited = sorted(old_members - members)
    _store_state(session, screen_id, as_of, members, seen)
    if not entered:
        session.commit()
        return False

    recorded = record_log_entry(
        session,
        settings,
        hub,
        dispatcher,
        fire_id=fire_id(screen_id, as_of, entered),
        name=name,
        symbol=_symbols_column(entered),
        interval="1d",
        kind="screen",
        bar_time=int(datetime(as_of.year, as_of.month, as_of.day, tzinfo=UTC).timestamp()),
        message=_message(name, entered),
        values={
            "screenId": screen_id,
            "entered": entered[:MAX_LISTED],
            "exited": exited[:MAX_LISTED],
            "enteredCount": len(entered),
            "exitedCount": len(exited),
        },
        notify=_notify(alert),
        fired_at=now,
    )
    if not recorded.created:
        # These entrants were announced already (a re-run, or a concurrent insert that rolled
        # this transaction back): the state still moves on.
        _store_state(session, screen_id, as_of, members, seen)
        session.commit()
    return recorded.created


def evaluate_screens(
    session: Session,
    settings: Settings,
    *,
    as_of: date,
    hub: LiveHub,
    dispatcher: Dispatcher,
    now: datetime,
    complete: bool = True,
) -> int:
    """Scan every alerting screen and log the symbols that entered it; returns the number of
    alerts fired. The first evaluation of a screen only records its members (no alert), and
    only when `complete` (the snapshot run was `done`). Re-running the same `as_of` fires the
    same entrants once. One screen failing is logged and skipped (its state is unchanged)."""
    rows = list(session.scalars(select(m.Screen).order_by(m.Screen.created_at, m.Screen.id)))
    fired = 0
    for row in rows:
        if not sc.alert_enabled(row.alert):
            continue
        screen_id = row.id
        try:
            if _evaluate(
                session,
                settings,
                row,
                as_of=as_of,
                complete=complete,
                hub=hub,
                dispatcher=dispatcher,
                now=now,
            ):
                fired += 1
        except Exception:
            session.rollback()
            log.exception("screen alert evaluation failed for %s", screen_id)
    return fired
