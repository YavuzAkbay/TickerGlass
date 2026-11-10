"""The screener universe: bundled symbol datasets, index lists and the tracked set.

Source of truth is the JSON bundle in `screener_data/` (class files `stocks|etfs|crypto|
commodities.json` plus `lists/*.json`). `seed_bundle` copies it into `screener_symbols`,
`screener_lists` and `screener_list_members` whenever its hash differs from
`app_meta['screener.bundle']`; the job and the scan SQL then read only the database.

Mapping to the web app's `Universe` type (`apps/web/src/screener/universe/types.ts`), as
returned by `universe_payload` (camelCase, built from the bundle, so it is identical for every
caller and its ETag is `bundle_hash()`):

    {cls, groupLabel: 'sector'|'category'|'group', capKind: 'mcap'|'aum'|null,
     symbols: [{symbol, name, rank, group, exchange?, cap?}], groups: [...], exchanges: [...]}

`rank` is the 1-based row index, `exchange` / `cap` are omitted when absent (null or <= 0),
`groups` / `exchanges` keep first-seen order, `cap` is USD billions. `groupLabel` / `capKind`
per class: stocks sector/mcap, etfs category/aum, commodities group/aum, crypto group/mcap.

Some ETFs are listed in both `etfs` and `commodities`. `screener_symbols` has one row per
symbol (first class in `CLASS_ORDER` wins, so those ETFs are stored as `etfs`);
`universe_payload` and `class_symbols` still return the full bundled class.
"""

import hashlib
import json
import logging
import re
from dataclasses import dataclass
from datetime import UTC, datetime
from functools import lru_cache
from pathlib import Path
from typing import Any, Literal

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from ...models import AppMeta, ScreenerList, ScreenerListMember, ScreenerSymbol, Watchlist
from ...settings import Settings

log = logging.getLogger(__name__)

_DATA_DIR = Path(__file__).resolve().parents[2] / "screener_data"

#: Class order of the bundle; also the tie-break of equal ranks across classes.
CLASS_ORDER = ("stocks", "etfs", "crypto", "commodities")
#: `app_meta` key holding the hash of the bundle last seeded.
BUNDLE_KEY = "screener.bundle"
#: Most symbols of one list.
MAX_LIST_SYMBOLS = 1500
#: Rank of the first non-bundled ("custom") symbol; bundled ranks are far below.
CUSTOM_RANK_BASE = 100_000
#: Extra tracked symbols reserved for watchlist symbols: `screener_max_symbols` caps the bundled
#: symbols and list members, watchlist symbols beyond that cut get up to this many more.
WATCHLIST_ALLOWANCE = 200
#: Same charset as the web app's symbol validation.
SYMBOL_RE = re.compile(r"^[A-Z0-9.\-=^/&_]{1,32}$")
_LIST_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,36}$")
_AS_OF_RE = re.compile(r"^\d{4}-\d{2}(-\d{2})?$")

_GROUP_LABEL = {
    "stocks": "sector",
    "etfs": "category",
    "commodities": "group",
    "crypto": "group",
}
_CAP_KIND = {"stocks": "mcap", "etfs": "aum", "commodities": "aum", "crypto": "mcap"}

ListStatus = Literal["reverted", "removed", "unchanged", "missing"]


class ListError(ValueError):
    """An invalid list id, name, date or symbol; `code` is a stable machine-readable reason."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class BundleRow:
    symbol: str
    name: str
    group: str
    exchange: str | None
    cap: float | None
    rank: int


@dataclass(frozen=True)
class BundleList:
    id: str
    name: str
    as_of: str
    symbols: tuple[str, ...]


@dataclass(frozen=True)
class Bundle:
    as_of: dict[str, str]
    classes: dict[str, tuple[BundleRow, ...]]
    lists: dict[str, BundleList]
    hash: str


@lru_cache(maxsize=4)
def _load(data_dir: Path) -> Bundle:
    classes: dict[str, tuple[BundleRow, ...]] = {}
    as_of: dict[str, str] = {}
    canonical: dict[str, Any] = {}
    for cls in CLASS_ORDER:
        doc = json.loads((data_dir / f"{cls}.json").read_text(encoding="utf-8"))
        canonical[cls] = doc
        as_of[cls] = str(doc["asOf"])
        rows = []
        for i, (symbol, name, group, exchange, cap) in enumerate(doc["rows"]):
            usable = isinstance(cap, int | float) and cap > 0
            rows.append(
                BundleRow(
                    symbol, name, group, exchange or None, float(cap) if usable else None, i + 1
                )
            )
        classes[cls] = tuple(rows)
    lists: dict[str, BundleList] = {}
    for path in sorted((data_dir / "lists").glob("*.json")):
        doc = json.loads(path.read_text(encoding="utf-8"))
        canonical[f"lists/{path.stem}"] = doc
        lists[doc["id"]] = BundleList(
            doc["id"], doc["name"], str(doc["asOf"]), tuple(doc["symbols"])
        )
    digest = hashlib.sha1(
        json.dumps(canonical, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    return Bundle(as_of, classes, lists, digest)


def bundle() -> Bundle:
    return _load(_DATA_DIR)


def bundle_hash() -> str:
    """Hash of the parsed bundle content (the ETag of `GET /api/screener/universe`)."""
    return bundle().hash


def class_symbols(cls: str) -> list[str]:
    """Bundled symbols of a class in rank order (includes ETFs that are stored as `etfs`)."""
    return [r.symbol for r in bundle().classes[cls]]


def universe_payload(session: Session, cls: str) -> dict[str, Any]:
    """The web app's `Universe` JSON of a bundled class (see the module docstring). Read from
    the bundle, not the database, so custom symbols never appear; `session` is kept for a
    stable signature. Raises KeyError for an unknown class."""
    rows = bundle().classes[cls]
    symbols: list[dict[str, Any]] = []
    groups: list[str] = []
    exchanges: list[str] = []
    for r in rows:
        item: dict[str, Any] = {"symbol": r.symbol, "name": r.name, "group": r.group}
        if r.exchange:
            item["exchange"] = r.exchange
        if r.cap is not None:
            item["cap"] = r.cap
        item["rank"] = r.rank
        symbols.append(item)
        if r.group not in groups:
            groups.append(r.group)
        if r.exchange and r.exchange not in exchanges:
            exchanges.append(r.exchange)
    return {
        "cls": cls,
        "groupLabel": _GROUP_LABEL[cls],
        "capKind": _CAP_KIND[cls],
        "symbols": symbols,
        "groups": groups,
        "exchanges": exchanges,
    }


# ------------------------------------------------------------------ seeding


def _bundled_symbols(b: Bundle) -> dict[str, tuple[str, BundleRow]]:
    """symbol -> (class, row); the first class in `CLASS_ORDER` wins a duplicate."""
    out: dict[str, tuple[str, BundleRow]] = {}
    for cls in CLASS_ORDER:
        for row in b.classes[cls]:
            out.setdefault(row.symbol, (cls, row))
    return out


def seed_bundle(
    session: Session, settings: Settings | None = None, *, now: datetime | None = None
) -> bool:
    """Upsert the bundle into the database unless `app_meta['screener.bundle']` already holds
    its hash. Returns True when it seeded. Symbols whose class, name, group, exchange or cap
    changed (and new ones) lose their tombstone; bundled symbols dropped from the bundle become
    'custom'; bundled lists are replaced except ones the user overrode (source 'upload'). The
    caller commits."""
    b = bundle()
    meta = session.get(AppMeta, BUNDLE_KEY)
    if meta is not None and meta.value == b.hash:
        return False
    stamp = now or datetime.now(UTC)

    wanted = _bundled_symbols(b)
    existing = {s.symbol: s for s in session.scalars(select(ScreenerSymbol))}
    for symbol, (cls, row) in wanted.items():
        cur = existing.get(symbol)
        if cur is None:
            session.add(
                ScreenerSymbol(
                    symbol=symbol,
                    cls=cls,
                    name=row.name,
                    grp=row.group,
                    exchange=row.exchange,
                    rank=row.rank,
                    cap_static=row.cap,
                    source="bundled",
                    fail_count=0,
                    updated_at=stamp,
                )
            )
            continue
        changed = (
            cur.source != "bundled"
            or cur.cls != cls
            or cur.name != row.name
            or cur.grp != row.group
            or cur.exchange != row.exchange
            or cur.cap_static != row.cap
        )
        if changed:
            cur.fail_count = 0
            cur.last_error = None
            cur.tombstoned_at = None
        if changed or cur.rank != row.rank:
            cur.cls, cur.name, cur.grp, cur.exchange = cls, row.name, row.group, row.exchange
            cur.rank, cur.cap_static, cur.source = row.rank, row.cap, "bundled"
            cur.updated_at = stamp
    custom_rank = max(
        [CUSTOM_RANK_BASE - 1, *(s.rank for s in existing.values() if s.source == "custom")]
    )
    for symbol, cur in existing.items():
        if symbol not in wanted and cur.source == "bundled":
            custom_rank += 1
            cur.source, cur.rank, cur.updated_at = "custom", custom_rank, stamp

    lists = {lst.id: lst for lst in session.scalars(select(ScreenerList))}
    for lid, bl in b.lists.items():
        cur_list = lists.get(lid)
        if cur_list is not None and cur_list.source == "upload":
            continue
        _write_list(session, lid, bl.name, "index", bl.as_of, "bundled", bl.symbols, stamp)
    for lid, cur_list in lists.items():
        if cur_list.source == "bundled" and lid not in b.lists:
            session.delete(cur_list)

    if meta is None:
        session.add(AppMeta(key=BUNDLE_KEY, value=b.hash, updated_at=stamp))
    else:
        meta.value, meta.updated_at = b.hash, stamp
    session.flush()
    log.info("screener bundle seeded: %d symbols, %d lists", len(wanted), len(b.lists))
    return True


def _write_list(
    session: Session,
    list_id: str,
    name: str,
    kind: str,
    as_of: str,
    source: str,
    symbols: tuple[str, ...] | list[str],
    stamp: datetime,
) -> ScreenerList:
    row = session.get(ScreenerList, list_id)
    if row is None:
        row = ScreenerList(
            id=list_id, name=name, kind=kind, as_of=as_of, source=source, updated_at=stamp
        )
        session.add(row)
    else:
        row.name, row.kind, row.as_of, row.source, row.updated_at = name, kind, as_of, source, stamp
    session.execute(delete(ScreenerListMember).where(ScreenerListMember.list_id == list_id))
    session.flush()
    session.add_all(ScreenerListMember(list_id=list_id, symbol=s) for s in dict.fromkeys(symbols))
    session.flush()
    return row


# -------------------------------------------------------------- tracked set


def _guess_class(symbol: str) -> str:
    if symbol.endswith("=F"):
        return "commodities"
    if re.search(r"-USDT?$", symbol):
        return "crypto"
    return "stocks"


def _watchlist_symbols(session: Session) -> list[str]:
    out: dict[str, None] = {}
    for items in session.scalars(select(Watchlist.items).order_by(Watchlist.created_at)):
        for item in items:
            if isinstance(item, dict) and item.get("type") == "symbol":
                sym = str(item.get("symbol", "")).upper()
                if SYMBOL_RE.match(sym):
                    out[sym] = None
    return list(out)


def tracked_symbols(session: Session, settings: Settings) -> list[str]:
    """Symbols the screener job snapshots, ordered by rank (rank 1 of every class first, then
    rank 2, ...; non-bundled symbols last in the order they were first seen):

    - the base set: non-tombstoned bundled symbols plus members of any list, cut to
      `screener_max_symbols`;
    - with `screener_include_watchlists`, the watchlist symbols the cut left out (custom ones,
      or bundled ones beyond it), up to `WATCHLIST_ALLOWANCE` more by the same order. So a few
      hundred list-only symbols can never push a watchlist symbol out of the tracked set.

    Non-bundled symbols get a 'custom' `screener_symbols` row (flushed, not committed: the
    caller commits)."""
    listed: dict[str, None] = {}
    for sym in session.scalars(
        select(ScreenerListMember.symbol).order_by(
            ScreenerListMember.list_id, ScreenerListMember.symbol
        )
    ):
        listed[sym] = None
    watched: dict[str, None] = {}
    if settings.screener_include_watchlists:
        for sym in _watchlist_symbols(session):
            watched[sym] = None

    rows = {s.symbol: s for s in session.scalars(select(ScreenerSymbol))}
    next_rank = max([CUSTOM_RANK_BASE - 1, *(s.rank for s in rows.values())]) + 1
    stamp = datetime.now(UTC)
    for sym in (*listed, *watched):
        if sym not in rows and SYMBOL_RE.match(sym):
            row = ScreenerSymbol(
                symbol=sym,
                cls=_guess_class(sym),
                name=sym,
                grp="Other",
                exchange=None,
                rank=next_rank,
                cap_static=None,
                source="custom",
                fail_count=0,
                updated_at=stamp,
            )
            next_rank += 1
            session.add(row)
            rows[sym] = row
    session.flush()

    order = {c: i for i, c in enumerate(CLASS_ORDER)}

    def key(s: ScreenerSymbol) -> tuple[int, int, str]:
        return (s.rank, order.get(s.cls, len(order)), s.symbol)

    live = [s for s in rows.values() if s.tombstoned_at is None]
    base = sorted((s for s in live if s.source == "bundled" or s.symbol in listed), key=key)
    base = base[: max(0, settings.screener_max_symbols)]
    taken = {s.symbol for s in base}
    extra = sorted((s for s in live if s.symbol in watched and s.symbol not in taken), key=key)
    chosen = sorted([*base, *extra[:WATCHLIST_ALLOWANCE]], key=key)
    return [s.symbol for s in chosen]


# --------------------------------------------------------------------- lists


def _summary(row: ScreenerList, count: int) -> dict[str, Any]:
    return {
        "id": row.id,
        "name": row.name,
        "kind": row.kind,
        "asOf": row.as_of,
        "source": row.source,
        "count": count,
    }


def list_lists(session: Session) -> list[dict[str, Any]]:
    """`[{id, name, kind, asOf, source, count}]`: index lists first, then custom, by name."""
    counts: dict[str, int] = {}
    for lid in session.scalars(select(ScreenerListMember.list_id)):
        counts[lid] = counts.get(lid, 0) + 1
    rows = session.scalars(select(ScreenerList)).all()
    rows = sorted(rows, key=lambda r: (r.kind != "index", r.name.lower(), r.id))
    return [_summary(r, counts.get(r.id, 0)) for r in rows]


def list_symbols(session: Session, list_id: str) -> list[str] | None:
    """Members of a list (sorted); None if the list does not exist."""
    if session.get(ScreenerList, list_id) is None:
        return None
    return sorted(
        session.scalars(
            select(ScreenerListMember.symbol).where(ScreenerListMember.list_id == list_id)
        )
    )


def put_list(
    session: Session,
    list_id: str,
    name: str,
    as_of: str,
    symbols: list[str],
    *,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Create or override a list (source 'upload'; a bundled id stays an 'index' list). Symbols
    are upper-cased and de-duplicated. Raises `ListError` for a bad id, name, date, a missing or
    malformed symbol or more than `MAX_LIST_SYMBOLS` symbols. The caller commits."""
    if not _LIST_ID_RE.match(list_id):
        raise ListError("bad_id", "list id must be 1-36 letters, digits, '-' or '_'")
    name = name.strip()
    if not 1 <= len(name) <= 200:
        raise ListError("bad_name", "name must be 1-200 characters")
    if not _AS_OF_RE.match(as_of):
        raise ListError("bad_as_of", "asOf must be YYYY-MM or YYYY-MM-DD")
    if len(symbols) > MAX_LIST_SYMBOLS:
        raise ListError("too_many_symbols", f"at most {MAX_LIST_SYMBOLS} symbols")
    clean: list[str] = []
    for raw in symbols:
        sym = raw.strip().upper()
        if not SYMBOL_RE.match(sym):
            raise ListError("bad_symbol", f"invalid symbol: {raw!r}")
        clean.append(sym)
    existing = session.get(ScreenerList, list_id)
    kind = (
        existing.kind
        if existing is not None
        else ("index" if list_id in bundle().lists else "custom")
    )
    row = _write_list(
        session, list_id, name, kind, as_of, "upload", clean, now or datetime.now(UTC)
    )
    return _summary(row, len(set(clean)))


def delete_list(session: Session, list_id: str, *, now: datetime | None = None) -> ListStatus:
    """'reverted': an overridden bundled list is back to the bundle content; 'removed': a
    custom list was deleted; 'unchanged': a bundled list that was not overridden (nothing to
    do); 'missing': no such list. The caller commits."""
    row = session.get(ScreenerList, list_id)
    if row is None:
        return "missing"
    bl = bundle().lists.get(list_id)
    if bl is not None:
        if row.source == "bundled":
            return "unchanged"
        _write_list(
            session,
            list_id,
            bl.name,
            "index",
            bl.as_of,
            "bundled",
            bl.symbols,
            now or datetime.now(UTC),
        )
        return "reverted"
    session.delete(row)
    session.flush()
    return "removed"
