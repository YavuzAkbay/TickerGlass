"""Portfolio + trade journal: request/response models, per-kind validation, serializers and
the bundle import/export helpers (docs/design/portfolio.md).

Self-contained (no import of `schemas`) because `schemas.Bundle` embeds the `Bundle*` models.
The server stores and validates only; ledger / P&L math lives in `packages/portfolio`.
"""

import base64
import binascii
import re
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Annotated, Any, Literal

from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    PrivateAttr,
    StringConstraints,
    ValidationError,
    model_validator,
)
from pydantic.alias_generators import to_camel
from sqlalchemy import delete, func, select, update
from sqlalchemy.orm import Session

from .. import models as m
from ..ownership import id_taken_by_other, owned_get

MAX_IMPORT_ROWS = 20_000
#: Cap on the request body of `POST .../transactions/import` (413 above it, before parsing).
MAX_IMPORT_BYTES = 32 * 1024 * 1024
MAX_IMPORT_ERRORS = 1000
MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024
MAX_TAGS = 20
MAX_TAG_CHARS = 40
MAX_NOTE_CHARS = 2000
#: Base64 of the largest screenshot (4 chars per 3 bytes, padded).
MAX_SCREENSHOT_B64 = (MAX_SCREENSHOT_BYTES + 2) // 3 * 4

IMAGE_TYPES = ("image/png", "image/jpeg", "image/webp")

_ID = re.compile(r"^[A-Za-z0-9_-]{1,36}$")
_CURRENCY = re.compile(r"^[A-Z]{3}$")
_SOURCE = re.compile(r"^(manual|import:[A-Za-z0-9_.-]{1,32})$")
_IMPORT_SOURCE = re.compile(r"^import:[A-Za-z0-9_.-]{1,32}$")


def utc(dt: datetime) -> datetime:
    """Aware UTC (SQLite returns naive datetimes; everything stored is UTC)."""
    return dt.replace(tzinfo=UTC) if dt.tzinfo is None else dt.astimezone(UTC)


class PfModel(BaseModel):
    """camelCase on the wire (responses are serialized by alias)."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")


# ------------------------------------------------------------------- types


def _check_id(value: str) -> str:
    if not _ID.match(value):
        raise ValueError("id must match [A-Za-z0-9_-]{1,36}")
    return value


def _symbol(value: str | None) -> str | None:
    if value is None:
        return None
    value = value.strip().upper()
    if len(value) > 32:
        raise ValueError("symbol longer than 32 characters")
    return value or None


def _currency(value: str) -> str:
    value = value.strip().upper()
    if not _CURRENCY.match(value):
        raise ValueError("currency must be a 3-letter ISO-4217 code")
    return value


def _blank_to_none(limit: int) -> Any:
    def check(value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        if len(value) > limit:
            raise ValueError(f"longer than {limit} characters")
        return value or None

    return check


def _tags(value: list[str]) -> list[str]:
    out: list[str] = []
    for raw in value:
        tag = raw.strip()
        if not tag:
            continue
        if len(tag) > MAX_TAG_CHARS:
            raise ValueError(f"tag longer than {MAX_TAG_CHARS} characters")
        if tag not in out:
            out.append(tag)
    if len(out) > MAX_TAGS:
        raise ValueError(f"at most {MAX_TAGS} tags")
    return out


Id = Annotated[str, AfterValidator(_check_id)]
PfSymbol = Annotated[str | None, AfterValidator(_symbol)]
Currency = Annotated[str, AfterValidator(_currency)]
Revision = Annotated[int, Field(ge=1)]
Num = Annotated[float, Field(allow_inf_nan=False)]
Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=80)]
CostMethod = Literal["fifo", "average"]
TxKind = Literal["buy", "sell", "dividend", "split", "fee", "interest", "cashIn", "cashOut"]
Source = Annotated[str, StringConstraints(pattern=_SOURCE.pattern)]
ImportSource = Annotated[str, StringConstraints(pattern=_IMPORT_SOURCE.pattern)]
TxNote = Annotated[str | None, AfterValidator(_blank_to_none(MAX_NOTE_CHARS))]
Setup = Annotated[str | None, AfterValidator(_blank_to_none(80))]
Tags = Annotated[list[str], Field(max_length=200), AfterValidator(_tags)]
ExternalId = Annotated[str | None, StringConstraints(min_length=1, max_length=128)]


# -------------------------------------------------------------- portfolios


class PortfolioIn(PfModel):
    name: Name
    base_currency: Currency = "USD"
    #: Benchmark symbol; null = none.
    benchmark: PfSymbol = "SPY"
    cost_method: CostMethod = "fifo"


class PortfolioUpdate(PfModel):
    """Absent `baseCurrency` / `costMethod` / `benchmark` keep the stored value (`benchmark`
    null clears it)."""

    name: Name
    base_currency: Currency | None = None
    benchmark: PfSymbol = None
    cost_method: CostMethod | None = None
    #: When given, 409 unless it matches the stored revision.
    revision: Revision | None = None


class Portfolio(PfModel):
    id: str
    name: str
    base_currency: str
    benchmark: str | None
    cost_method: CostMethod
    revision: int
    created_at: datetime
    updated_at: datetime


def portfolio_out(row: m.Portfolio) -> Portfolio:
    return Portfolio(
        id=row.id,
        name=row.name,
        base_currency=row.base_currency,
        benchmark=row.benchmark,
        cost_method=row.cost_method,  # type: ignore[arg-type]
        revision=row.revision,
        created_at=utc(row.created_at),
        updated_at=utc(row.updated_at),
    )


# ------------------------------------------------------------ transactions

#: kind -> (symbol, quantity, price, amount): "req" = required, "opt" = optional, "null" = must
#: be absent. Numeric signs: quantity > 0, price >= 0, amount > 0.
_KIND_FIELDS: dict[str, tuple[str, str, str, str]] = {
    "buy": ("req", "req", "req", "null"),
    "sell": ("req", "req", "req", "null"),
    "dividend": ("req", "null", "null", "req"),
    "split": ("req", "req", "null", "null"),
    "fee": ("opt", "null", "null", "req"),
    "interest": ("null", "null", "null", "req"),
    "cashIn": ("null", "null", "null", "req"),
    "cashOut": ("null", "null", "null", "req"),
}


_FIELD_NAMES = ("symbol", "quantity", "price", "amount")

#: Kinds that carry no separate fee (their `amount` / `quantity` is the whole movement).
_NO_FEE_KINDS = frozenset({"cashIn", "cashOut", "split", "fee"})
#: Kinds whose fee is withheld from `amount`, so it cannot exceed it.
_FEE_WITHIN_AMOUNT_KINDS = frozenset({"dividend", "interest"})


class TxIn(PfModel):
    kind: TxKind
    time: datetime
    symbol: PfSymbol = None
    quantity: Num | None = None
    price: Num | None = None
    amount: Num | None = None
    fee: Annotated[float, Field(ge=0, allow_inf_nan=False)] = 0.0
    currency: Currency
    note: TxNote = None
    #: Broker-side id; unique per portfolio (null = never deduplicated).
    external_id: ExternalId = None

    @model_validator(mode="after")
    def _check_kind(self) -> "TxIn":
        self.time = utc(self.time)
        rules = _KIND_FIELDS[self.kind]
        values = (self.symbol, self.quantity, self.price, self.amount)
        for name, rule, value in zip(_FIELD_NAMES, rules, values, strict=True):
            if rule == "req" and value is None:
                raise ValueError(f"{self.kind}: {name} is required")
            if rule == "null" and value is not None:
                raise ValueError(f"{self.kind}: {name} must be null")
        if self.quantity is not None and not self.quantity > 0:
            raise ValueError(f"{self.kind}: quantity must be > 0")
        if self.price is not None and self.price < 0:
            raise ValueError(f"{self.kind}: price must be >= 0")
        if self.amount is not None and not self.amount > 0:
            raise ValueError(f"{self.kind}: amount must be > 0")
        if self.kind in _NO_FEE_KINDS and self.fee != 0:
            raise ValueError(f"{self.kind}: fee must be 0")
        if (
            self.kind in _FEE_WITHIN_AMOUNT_KINDS
            and self.amount is not None
            and self.fee > self.amount
        ):
            raise ValueError(f"{self.kind}: fee must be <= amount")
        return self


class TxUpdate(TxIn):
    #: When given, 409 unless it matches the stored revision.
    revision: Revision | None = None


class Tx(PfModel):
    id: str
    portfolio_id: str
    #: Insertion order within the portfolio (1-based); ties on `time` sort by it.
    seq: int
    kind: TxKind
    time: datetime
    symbol: str | None
    quantity: float | None
    price: float | None
    amount: float | None
    fee: float
    currency: str
    note: str | None
    source: str
    external_id: str | None
    import_batch: str | None
    revision: int
    created_at: datetime
    updated_at: datetime


def tx_out(row: m.PortfolioTransaction) -> Tx:
    return Tx(
        id=row.id,
        portfolio_id=row.portfolio_id,
        seq=row.seq,
        kind=row.kind,  # type: ignore[arg-type]
        time=utc(row.time),
        symbol=row.symbol,
        quantity=row.quantity,
        price=row.price,
        amount=row.amount,
        fee=row.fee,
        currency=row.currency,
        note=row.note,
        source=row.source,
        external_id=row.external_id,
        import_batch=row.import_batch,
        revision=row.revision,
        created_at=utc(row.created_at),
        updated_at=utc(row.updated_at),
    )


def tx_values(x: TxIn) -> dict[str, Any]:
    """Column values of the content fields shared by create and update."""
    return {
        "kind": x.kind,
        "time": x.time,
        "symbol": x.symbol,
        "quantity": x.quantity,
        "price": x.price,
        "amount": x.amount,
        "fee": x.fee,
        "currency": x.currency,
        "note": x.note,
        "external_id": x.external_id,
    }


def next_seq(session: Session, portfolio_id: str) -> int:
    """The `seq` after the highest one of the portfolio (1 when it has no transactions).

    A no-op UPDATE of the portfolio row first takes the write lock (SQLite) / row lock
    (Postgres), so concurrent writers to one portfolio serialize here instead of both reading
    the same maximum. The unique (portfolio_id, seq) constraint backs this up."""
    session.execute(
        update(m.Portfolio).where(m.Portfolio.id == portfolio_id).values(id=m.Portfolio.id)
    )
    top = session.scalar(
        select(func.max(m.PortfolioTransaction.seq)).where(
            m.PortfolioTransaction.portfolio_id == portfolio_id
        )
    )
    return (top or 0) + 1


class TxImportBody(PfModel):
    #: Raw rows: each is validated as a `TxIn` so errors can be reported per index.
    transactions: list[dict[str, Any]] = Field(max_length=MAX_IMPORT_ROWS)
    dry_run: bool = False
    source: ImportSource


class RowError(PfModel):
    index: int
    message: str


class TxImportResult(PfModel):
    #: Id given to the created rows (undo with `DELETE .../imports/{batch}`); null when dry-running
    #: or nothing was created.
    batch: str | None
    created: int
    skipped: int
    errors: list[RowError]


class ImportUndo(PfModel):
    deleted: int


def format_validation_error(exc: ValidationError) -> str:
    parts: list[str] = []
    for err in exc.errors():
        msg = err["msg"].removeprefix("Value error, ")
        loc = ".".join(str(p) for p in err["loc"])
        parts.append(f"{loc}: {msg}" if loc else msg)
    return "; ".join(parts)


def parse_import_rows(rows: list[dict[str, Any]]) -> tuple[list[TxIn], list[RowError]]:
    """Validate every row like `POST .../transactions` would; collect per-row errors."""
    parsed: list[TxIn] = []
    errors: list[RowError] = []
    for i, raw in enumerate(rows):
        try:
            parsed.append(TxIn.model_validate(raw))
        except ValidationError as exc:
            if len(errors) < MAX_IMPORT_ERRORS:
                errors.append(RowError(index=i, message=format_validation_error(exc)))
    return parsed, errors


# ----------------------------------------------------------------- journal


class JournalIn(PfModel):
    #: Must belong to the same portfolio (422 otherwise).
    transaction_id: Id | None = None
    symbol: PfSymbol = None
    #: Must reference an existing note of kind 'journal' (422 otherwise); deleted with the entry.
    note_id: Id | None = None
    setup: Setup = None
    tags: Tags = Field(default_factory=list)
    #: Initial stop price (drives R).
    stop: Annotated[float, Field(ge=0, allow_inf_nan=False)] | None = None
    #: Manual R override.
    r_multiple: Num | None = None


class JournalUpdate(JournalIn):
    #: When given, 409 unless it matches the stored revision.
    revision: Revision | None = None


class JournalEntry(PfModel):
    id: str
    portfolio_id: str
    transaction_id: str | None
    symbol: str | None
    note_id: str | None
    setup: str | None
    tags: list[str]
    stop: float | None
    r_multiple: float | None
    has_screenshot: bool
    revision: int
    created_at: datetime
    updated_at: datetime


def journal_out(row: m.JournalEntry, has_screenshot: bool) -> JournalEntry:
    return JournalEntry(
        id=row.id,
        portfolio_id=row.portfolio_id,
        transaction_id=row.transaction_id,
        symbol=row.symbol,
        note_id=row.note_id,
        setup=row.setup,
        tags=[str(t) for t in row.tags],
        stop=row.stop,
        r_multiple=row.r_multiple,
        has_screenshot=has_screenshot,
        revision=row.revision,
        created_at=utc(row.created_at),
        updated_at=utc(row.updated_at),
    )


def journal_values(x: JournalIn) -> dict[str, Any]:
    return {
        "transaction_id": x.transaction_id,
        "symbol": x.symbol,
        "note_id": x.note_id,
        "setup": x.setup,
        "tags": x.tags,
        "stop": x.stop,
        "r_multiple": x.r_multiple,
    }


def sniff_image(data: bytes) -> str | None:
    """MIME type from the magic bytes (png, jpeg, webp), else None."""
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def check_screenshot(mime: str, data: bytes) -> None:
    """Raises ValueError unless `data` is a non-empty image of the stated type within the cap."""
    if mime not in IMAGE_TYPES:
        raise ValueError(f"screenshot type must be one of {', '.join(IMAGE_TYPES)}")
    if not data:
        raise ValueError("screenshot is empty")
    if len(data) > MAX_SCREENSHOT_BYTES:
        raise ValueError(f"screenshot larger than {MAX_SCREENSHOT_BYTES} bytes")
    if sniff_image(data) != mime:
        raise ValueError(f"screenshot content does not match {mime}")


# ------------------------------------------------------------------ bundle


class BundleScreenshot(PfModel):
    mime: Literal["image/png", "image/jpeg", "image/webp"]
    #: Base64 of the image bytes.
    data: Annotated[str, Field(max_length=MAX_SCREENSHOT_B64)]

    #: The decoded bytes, filled in once by validation.
    _raw: bytes = PrivateAttr(default=b"")

    @model_validator(mode="after")
    def _check_image(self) -> "BundleScreenshot":
        try:
            raw = base64.b64decode(self.data, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise ValueError("screenshot data is not valid base64") from exc
        check_screenshot(self.mime, raw)
        self._raw = raw
        return self

    def decoded(self) -> bytes:
        return self._raw


class BundlePortfolio(PortfolioIn):
    id: Id
    revision: int | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


class BundleTx(TxIn):
    id: Id
    portfolio_id: Id
    #: Optional (older bundles have none). Import renumbers: when every transaction of a
    #: portfolio carries one they are ordered by (time, seq), else by position in the bundle.
    seq: Annotated[int, Field(ge=1, le=2**31 - 1)] | None = None
    source: Source = "manual"
    import_batch: Annotated[str | None, StringConstraints(min_length=1, max_length=36)] = None
    revision: int | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


class BundleJournalEntry(JournalIn):
    id: Id
    portfolio_id: Id
    screenshot: BundleScreenshot | None = None
    revision: int | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


class PortfolioBundleError(ValueError):
    """The portfolio part of a bundle cannot be imported (422)."""


@dataclass
class ImportTally:
    portfolios_created: int = 0
    portfolios_updated: int = 0
    transactions_created: int = 0
    transactions_updated: int = 0
    entries_created: int = 0
    entries_updated: int = 0


def export_rows(
    session: Session,
) -> tuple[list[BundlePortfolio], list[BundleTx], list[BundleJournalEntry]]:
    portfolios = [
        BundlePortfolio(**portfolio_out(r).model_dump())
        for r in session.scalars(
            select(m.Portfolio).order_by(m.Portfolio.created_at, m.Portfolio.id)
        )
    ]
    # Children have no owner column: limit them to the owner's portfolios (the session's
    # criteria scope the subquery).
    mine = select(m.Portfolio.id)
    my_entries = select(m.JournalEntry.id).where(m.JournalEntry.portfolio_id.in_(mine))
    txs = [
        BundleTx(**tx_out(r).model_dump())
        for r in session.scalars(
            select(m.PortfolioTransaction)
            .where(m.PortfolioTransaction.portfolio_id.in_(mine))
            .order_by(
                m.PortfolioTransaction.portfolio_id,
                m.PortfolioTransaction.time,
                m.PortfolioTransaction.seq,
                m.PortfolioTransaction.id,
            )
        )
    ]
    shots = {
        r.entry_id: BundleScreenshot(
            mime=r.mime,  # type: ignore[arg-type]
            data=base64.b64encode(r.data).decode("ascii"),
        )
        for r in session.scalars(
            select(m.JournalScreenshot).where(m.JournalScreenshot.entry_id.in_(my_entries))
        )
    }
    entries = [
        BundleJournalEntry(
            **journal_out(r, r.id in shots).model_dump(exclude={"has_screenshot"}),
            screenshot=shots.get(r.id),
        )
        for r in session.scalars(
            select(m.JournalEntry)
            .where(m.JournalEntry.portfolio_id.in_(mine))
            .order_by(m.JournalEntry.created_at, m.JournalEntry.id)
        )
    ]
    return portfolios, txs, entries


def _dupes(keys: list[Any], what: str) -> None:
    seen: set[Any] = set()
    for k in keys:
        if k in seen:
            raise PortfolioBundleError(f"duplicate {what} in bundle: {k}")
        seen.add(k)


def _bundle_seqs(
    session: Session, txs: list[BundleTx], portfolio_ids: dict[str, str]
) -> dict[str, int]:
    """New `seq` of every bundle transaction, numbered above the portfolio's current maximum.
    A portfolio whose bundle rows all carry a `seq` is ordered by (time, seq), else by position
    in the bundle (the stable sort keeps ties in bundle order). `portfolio_ids` maps the
    bundle's portfolio ids to the stored ones; only the session owner's portfolios are scanned."""
    groups: dict[str, list[BundleTx]] = {}
    for x in txs:
        groups.setdefault(portfolio_ids.get(x.portfolio_id, x.portfolio_id), []).append(x)
    top = {
        pid: mx
        for pid, mx in session.execute(
            select(m.PortfolioTransaction.portfolio_id, func.max(m.PortfolioTransaction.seq))
            .where(
                m.PortfolioTransaction.portfolio_id.in_(groups),
                m.PortfolioTransaction.portfolio_id.in_(select(m.Portfolio.id)),
            )
            .group_by(m.PortfolioTransaction.portfolio_id)
        )
    }
    out: dict[str, int] = {}
    for pid, group in groups.items():
        if all(x.seq is not None for x in group):
            group.sort(key=lambda x: (x.time, x.seq or 0))
        for n, x in enumerate(group, start=(top.get(pid) or 0) + 1):
            out[x.id] = n
    return out


def delete_all_rows(session: Session) -> None:
    """Empty the session owner's journal / transaction / portfolio rows (children first)."""
    mine = select(m.Portfolio.id)
    entries = select(m.JournalEntry.id).where(m.JournalEntry.portfolio_id.in_(mine))
    session.execute(delete(m.JournalScreenshot).where(m.JournalScreenshot.entry_id.in_(entries)))
    session.execute(delete(m.JournalEntry).where(m.JournalEntry.portfolio_id.in_(mine)))
    session.execute(
        delete(m.PortfolioTransaction).where(m.PortfolioTransaction.portfolio_id.in_(mine))
    )
    session.execute(delete(m.Portfolio))


def import_rows(
    session: Session,
    portfolios: list[BundlePortfolio],
    txs: list[BundleTx],
    entries: list[BundleJournalEntry],
    t: datetime,
    note_ids: dict[str, str] | None = None,
) -> ImportTally:
    """Merge by id: matches are overwritten (revision bumped), the rest created. Raises
    `PortfolioBundleError` for dangling or inconsistent references.

    Everything is the session owner's: an id of the bundle that belongs to another user (a
    bundle exported by someone else) is stored under a fresh id, and the references inside the
    bundle follow. `note_ids` maps the bundle's note ids to the stored ones (the notes section
    ran first); a journal entry linking a note that is not the owner's just unlinks."""
    _dupes([x.id for x in portfolios], "portfolio id")
    _dupes([x.id for x in txs], "portfolio transaction id")
    _dupes([x.id for x in entries], "journal entry id")
    _dupes(
        [(x.portfolio_id, x.external_id) for x in txs if x.external_id is not None],
        "portfolio transaction externalId",
    )
    tally = ImportTally()
    note_ids = note_ids or {}

    portfolio_ids: dict[str, str] = {}  # bundle id -> stored id
    for p in portfolios:
        pid = p.id
        prow = owned_get(session, m.Portfolio, pid)
        if prow is None and id_taken_by_other(session, m.Portfolio, pid):
            pid = _fresh_id()
        portfolio_ids[p.id] = pid
        if prow is None:
            session.add(
                m.Portfolio(
                    id=pid,
                    name=p.name,
                    base_currency=p.base_currency,
                    benchmark=p.benchmark,
                    cost_method=p.cost_method,
                    revision=1,
                    created_at=p.created_at or t,
                    updated_at=t,
                )
            )
            tally.portfolios_created += 1
        else:
            prow.name, prow.base_currency = p.name, p.base_currency
            prow.benchmark, prow.cost_method = p.benchmark, p.cost_method
            prow.revision += 1
            prow.updated_at = t
            tally.portfolios_updated += 1
    session.flush()

    seqs = _bundle_seqs(session, txs, portfolio_ids)
    # (portfolio, externalId) -> transaction, of the owner's portfolios only.
    taken: dict[tuple[str, str], str] = {
        (pid, ext): tid
        for tid, pid, ext in session.execute(
            select(
                m.PortfolioTransaction.id,
                m.PortfolioTransaction.portfolio_id,
                m.PortfolioTransaction.external_id,
            ).where(
                m.PortfolioTransaction.external_id.is_not(None),
                m.PortfolioTransaction.portfolio_id.in_(select(m.Portfolio.id)),
            )
        )
        if ext is not None
    }
    tx_ids: dict[str, str] = {}  # bundle id -> stored id
    for x in txs:
        pid = portfolio_ids.get(x.portfolio_id, x.portfolio_id)
        if owned_get(session, m.Portfolio, pid) is None:
            raise PortfolioBundleError(
                f"transaction {x.id}: portfolio {x.portfolio_id} is not in the bundle or database"
            )
        tid = x.id
        trow = session.get(m.PortfolioTransaction, tid)
        if trow is not None and owned_get(session, m.Portfolio, trow.portfolio_id) is None:
            tid, trow = _fresh_id(), None  # another user's transaction has this id
        tx_ids[x.id] = tid
        if trow is not None and trow.portfolio_id != pid:
            raise PortfolioBundleError(f"transaction {x.id} already exists in another portfolio")
        if x.external_id is not None:
            owner = taken.get((pid, x.external_id))
            if owner is not None and owner != tid:
                raise PortfolioBundleError(
                    f"transaction {x.id}: externalId {x.external_id!r} already used by {owner}"
                )
        if trow is None:
            session.add(
                m.PortfolioTransaction(
                    id=tid,
                    portfolio_id=pid,
                    seq=seqs[x.id],
                    **tx_values(x),
                    source=x.source,
                    import_batch=x.import_batch,
                    revision=1,
                    created_at=x.created_at or t,
                    updated_at=t,
                )
            )
            tally.transactions_created += 1
        else:
            if trow.external_id is not None:
                taken.pop((trow.portfolio_id, trow.external_id), None)
            for key, value in tx_values(x).items():
                setattr(trow, key, value)
            trow.source, trow.import_batch = x.source, x.import_batch
            trow.seq = seqs[x.id]
            trow.revision += 1
            trow.updated_at = t
            tally.transactions_updated += 1
        if x.external_id is not None:
            taken[(pid, x.external_id)] = tid
    session.flush()

    for e in entries:
        pid = portfolio_ids.get(e.portfolio_id, e.portfolio_id)
        if owned_get(session, m.Portfolio, pid) is None:
            raise PortfolioBundleError(
                f"journal entry {e.id}: portfolio {e.portfolio_id} is not in the bundle or database"
            )
        if e.transaction_id is not None:
            linked = session.get(
                m.PortfolioTransaction, tx_ids.get(e.transaction_id, e.transaction_id)
            )
            # `pid` is the owner's portfolio: a transaction of it is the owner's too.
            if linked is None or linked.portfolio_id != pid:
                raise PortfolioBundleError(
                    f"journal entry {e.id}: transaction {e.transaction_id} "
                    "is not in the same portfolio"
                )
        # A note that is gone (e.g. the bundle has no notes section), not the owner's, or not
        # a journal note just unlinks.
        linked_note = (
            owned_get(session, m.Note, note_ids.get(e.note_id, e.note_id)) if e.note_id else None
        )
        note_id = (
            linked_note.id if linked_note is not None and linked_note.kind == "journal" else None
        )
        values = {
            **journal_values(e),
            "note_id": note_id,
            "transaction_id": None
            if e.transaction_id is None
            else tx_ids.get(e.transaction_id, e.transaction_id),
        }
        eid = e.id
        erow = session.get(m.JournalEntry, eid)
        if erow is not None and owned_get(session, m.Portfolio, erow.portfolio_id) is None:
            eid, erow = _fresh_id(), None  # another user's entry has this id
        if erow is not None and erow.portfolio_id != pid:
            raise PortfolioBundleError(f"journal entry {e.id} already exists in another portfolio")
        if erow is None:
            session.add(
                m.JournalEntry(
                    id=eid,
                    portfolio_id=pid,
                    **values,
                    revision=1,
                    created_at=e.created_at or t,
                    updated_at=t,
                )
            )
            tally.entries_created += 1
        else:
            for key, value in values.items():
                setattr(erow, key, value)
            erow.revision += 1
            erow.updated_at = t
            tally.entries_updated += 1
        session.flush()
        shot = session.get(m.JournalScreenshot, eid)
        if e.screenshot is None:
            if shot is not None:
                session.delete(shot)
        elif shot is None:
            session.add(
                m.JournalScreenshot(
                    entry_id=eid,
                    mime=e.screenshot.mime,
                    data=e.screenshot.decoded(),
                    created_at=t,
                )
            )
        else:
            shot.mime, shot.data = e.screenshot.mime, e.screenshot.decoded()
    session.flush()
    return tally


def _fresh_id() -> str:
    return uuid.uuid4().hex
