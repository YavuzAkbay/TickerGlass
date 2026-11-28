"""Portfolios, transactions (with broker import + undo) and the trade journal
(docs/design/portfolio.md). Storage and validation only; no P&L math."""

import logging
from collections.abc import Callable
from typing import Annotated, Any

from fastapi import APIRouter, HTTPException, Query, Request, Response
from fastapi.routing import APIRoute
from sqlalchemy import delete, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool
from starlette.types import Message

from .. import models as m
from ..deps import OwnedSessionDep
from ..ownership import owned_get
from ..userdata import portfolio as pf
from ..userdata import schemas as s
from ..userdata import store
from ._symbol import SymbolParam

log = logging.getLogger("tickerglass.portfolio")

router = APIRouter(tags=["portfolio"])


class _CappedBodyRoute(APIRoute):
    """Answers 413 once the request body exceeds `pf.MAX_IMPORT_BYTES`: up front from
    `Content-Length`, and while reading for bodies without one (chunked). FastAPI parses the body
    before a dependency could run, hence the wrapped route handler."""

    def get_route_handler(self) -> Callable[[Request], Any]:
        handler = super().get_route_handler()

        async def capped(request: Request) -> Response:
            limit = pf.MAX_IMPORT_BYTES
            too_large = HTTPException(413, f"request body larger than {limit} bytes")
            declared = request.headers.get("content-length")
            if declared is not None and declared.isdigit() and int(declared) > limit:
                raise too_large
            received = 0
            inner = request.receive

            async def receive() -> Message:
                nonlocal received
                message = await inner()
                if message["type"] == "http.request":
                    received += len(message.get("body", b""))
                    if received > limit:
                        raise too_large
                return message

            response: Response = await handler(Request(request.scope, receive))
            return response

        return capped


#: Routes whose (large) JSON body is size-capped before parsing.
capped_router = APIRouter(tags=["portfolio"], route_class=_CappedBodyRoute)


def _portfolio(session: Session, portfolio_id: str) -> m.Portfolio:
    row = owned_get(session, m.Portfolio, portfolio_id)
    if row is None:
        raise HTTPException(404, f"portfolio not found: {portfolio_id}")
    return row


def _tx(session: Session, tx_id: str) -> m.PortfolioTransaction:
    row = session.get(m.PortfolioTransaction, tx_id)
    # Children are reached through an owned parent: a row of someone else's portfolio is 404.
    if row is None or owned_get(session, m.Portfolio, row.portfolio_id) is None:
        raise HTTPException(404, f"transaction not found: {tx_id}")
    return row


def _entry(session: Session, entry_id: str) -> m.JournalEntry:
    row = session.get(m.JournalEntry, entry_id)
    if row is None or owned_get(session, m.Portfolio, row.portfolio_id) is None:
        raise HTTPException(404, f"journal entry not found: {entry_id}")
    return row


def _conflict(what: str, row_id: str, current: Any) -> HTTPException:
    return HTTPException(
        409,
        {
            "message": f"{what} {row_id} changed elsewhere",
            "current": current.model_dump(mode="json", by_alias=True),
        },
    )


def _revision_update(
    session: Session,
    model: Any,
    row_id: str,
    revision: int | None,
    values: dict[str, Any],
    what: str,
    load: Callable[[Session, str], Any],
    out: Callable[[Any], Any],
    also: Callable[[Session], None] | None = None,
) -> Any:
    """Conditional UPDATE (no lost updates): 409 with the stored row if `revision` is stale.
    `also` runs in the same transaction once the update applied."""
    cond = [model.id == row_id]
    if revision is not None:
        cond.append(model.revision == revision)
    stmt = (
        update(model)
        .where(*cond)
        .values(**values, revision=model.revision + 1, updated_at=s.now())
        .execution_options(synchronize_session=False)
    )
    if store.rowcount(session.execute(stmt)) != 1:
        session.rollback()
        raise _conflict(what, row_id, out(load(session, row_id)))
    row = store.reload(session, model, row_id)
    if also is not None:
        also(session)
    session.commit()
    return row


# --------------------------------------------------------------- portfolios


@router.get("/portfolios", response_model=list[pf.Portfolio])
def list_portfolios(session: OwnedSessionDep) -> list[pf.Portfolio]:
    q = select(m.Portfolio).order_by(m.Portfolio.created_at, m.Portfolio.id)
    return [pf.portfolio_out(r) for r in session.scalars(q)]


@router.post("/portfolios", response_model=pf.Portfolio, status_code=201)
def create_portfolio(session: OwnedSessionDep, body: pf.PortfolioIn) -> pf.Portfolio:
    t = s.now()
    row = m.Portfolio(
        id=s.new_id(),
        name=body.name,
        base_currency=body.base_currency,
        benchmark=body.benchmark,
        cost_method=body.cost_method,
        revision=1,
        created_at=t,
        updated_at=t,
    )
    session.add(row)
    session.commit()
    return pf.portfolio_out(row)


@router.get("/portfolios/{portfolio_id}", response_model=pf.Portfolio)
def get_portfolio(session: OwnedSessionDep, portfolio_id: str) -> pf.Portfolio:
    return pf.portfolio_out(_portfolio(session, portfolio_id))


@router.put("/portfolios/{portfolio_id}", response_model=pf.Portfolio)
def update_portfolio(
    session: OwnedSessionDep, portfolio_id: str, body: pf.PortfolioUpdate
) -> pf.Portfolio:
    """409 (with the stored portfolio) if `revision` is given and stale."""
    values: dict[str, Any] = {"name": body.name}
    if body.base_currency is not None:
        values["base_currency"] = body.base_currency
    if body.cost_method is not None:
        values["cost_method"] = body.cost_method
    if "benchmark" in body.model_fields_set:
        values["benchmark"] = body.benchmark
    _portfolio(session, portfolio_id)
    row = _revision_update(
        session,
        m.Portfolio,
        portfolio_id,
        body.revision,
        values,
        "portfolio",
        _portfolio,
        pf.portfolio_out,
    )
    return pf.portfolio_out(row)


@router.delete("/portfolios/{portfolio_id}", status_code=204)
def delete_portfolio(session: OwnedSessionDep, portfolio_id: str) -> Response:
    """Removes the portfolio with its transactions, journal entries, screenshots and the notes
    linked to those entries."""
    row = _portfolio(session, portfolio_id)
    entries = select(m.JournalEntry.id).where(m.JournalEntry.portfolio_id == portfolio_id)
    note_ids = [
        n
        for n in session.scalars(
            select(m.JournalEntry.note_id).where(m.JournalEntry.portfolio_id == portfolio_id)
        )
        if n is not None
    ]
    session.execute(delete(m.JournalScreenshot).where(m.JournalScreenshot.entry_id.in_(entries)))
    session.execute(delete(m.JournalEntry).where(m.JournalEntry.portfolio_id == portfolio_id))
    session.execute(
        delete(m.PortfolioTransaction).where(m.PortfolioTransaction.portfolio_id == portfolio_id)
    )
    if note_ids:
        session.execute(delete(m.Note).where(m.Note.id.in_(note_ids)))
    session.delete(row)
    session.commit()
    return Response(status_code=204)


# ------------------------------------------------------------ transactions


@router.get("/portfolios/{portfolio_id}/transactions", response_model=list[pf.Tx])
def list_transactions(
    session: OwnedSessionDep,
    portfolio_id: str,
    symbol: Annotated[SymbolParam | None, Query()] = None,
) -> list[pf.Tx]:
    """Ordered by time, then `seq` (insertion order); optionally only those of `symbol`."""
    _portfolio(session, portfolio_id)
    q = (
        select(m.PortfolioTransaction)
        .where(m.PortfolioTransaction.portfolio_id == portfolio_id)
        .order_by(
            m.PortfolioTransaction.time, m.PortfolioTransaction.seq, m.PortfolioTransaction.id
        )
    )
    if symbol is not None:
        q = q.where(m.PortfolioTransaction.symbol == symbol.strip().upper())
    return [pf.tx_out(r) for r in session.scalars(q)]


def _external_owner(
    session: Session, portfolio_id: str, external_id: str | None, except_id: str | None = None
) -> m.PortfolioTransaction | None:
    if external_id is None:
        return None
    q = select(m.PortfolioTransaction).where(
        m.PortfolioTransaction.portfolio_id == portfolio_id,
        m.PortfolioTransaction.external_id == external_id,
    )
    if except_id is not None:
        q = q.where(m.PortfolioTransaction.id != except_id)
    return session.scalars(q).first()


def _external_conflict(row: m.PortfolioTransaction) -> HTTPException:
    return HTTPException(
        409,
        {
            "message": f"externalId {row.external_id!r} already exists in this portfolio",
            "current": pf.tx_out(row).model_dump(mode="json", by_alias=True),
        },
    )


@router.post("/portfolios/{portfolio_id}/transactions", response_model=pf.Tx, status_code=201)
def create_transaction(session: OwnedSessionDep, portfolio_id: str, body: pf.TxIn) -> pf.Tx:
    """Manual entry (`source` = manual). 409 if `externalId` already exists in the portfolio."""
    _portfolio(session, portfolio_id)
    owner = _external_owner(session, portfolio_id, body.external_id)
    if owner is not None:
        raise _external_conflict(owner)
    t = s.now()
    row = m.PortfolioTransaction(
        id=s.new_id(),
        portfolio_id=portfolio_id,
        seq=pf.next_seq(session, portfolio_id),
        **pf.tx_values(body),
        source="manual",
        import_batch=None,
        revision=1,
        created_at=t,
        updated_at=t,
    )
    session.add(row)
    try:
        session.commit()
    except IntegrityError as exc:
        session.rollback()
        log.warning("transaction conflict: %s", exc.orig)
        raise HTTPException(409, "transaction conflicts with stored data") from None
    return pf.tx_out(row)


@router.put("/transactions/{tx_id}", response_model=pf.Tx)
def update_transaction(session: OwnedSessionDep, tx_id: str, body: pf.TxUpdate) -> pf.Tx:
    """Full replace of the content fields, except `externalId`: absent keeps the stored value,
    an explicit null clears it. 409 (with the stored row) if `revision` is given and stale, or if
    `externalId` belongs to another transaction of the portfolio."""
    existing = _tx(session, tx_id)
    values = pf.tx_values(body)
    if "external_id" in body.model_fields_set:
        owner = _external_owner(session, existing.portfolio_id, body.external_id, except_id=tx_id)
        if owner is not None:
            raise _external_conflict(owner)
    else:
        del values["external_id"]
    try:
        row = _revision_update(
            session,
            m.PortfolioTransaction,
            tx_id,
            body.revision,
            values,
            "transaction",
            _tx,
            pf.tx_out,
        )
    except IntegrityError as exc:
        session.rollback()
        log.warning("transaction conflict: %s", exc.orig)
        raise HTTPException(409, "transaction conflicts with stored data") from None
    return pf.tx_out(row)


@router.delete("/transactions/{tx_id}", status_code=204)
def delete_transaction(session: OwnedSessionDep, tx_id: str) -> Response:
    """Journal entries that referenced it keep existing with `transactionId` null."""
    session.delete(_tx(session, tx_id))
    session.commit()
    return Response(status_code=204)


@capped_router.post(
    "/portfolios/{portfolio_id}/transactions/import", response_model=pf.TxImportResult
)
def import_transactions(
    session: OwnedSessionDep, portfolio_id: str, body: pf.TxImportBody
) -> pf.TxImportResult:
    """All rows are validated first: any invalid row -> 422 `detail.errors` and nothing is
    written. Rows whose `externalId` exists in the portfolio or repeats earlier in the payload
    are skipped. `dryRun` only counts. 413 if the body is larger than 32 MB."""
    _portfolio(session, portfolio_id)
    rows, errors = pf.parse_import_rows(body.transactions)
    if errors:
        raise HTTPException(
            422,
            {
                "message": f"{len(errors)} invalid row(s); nothing imported",
                "errors": [e.model_dump(mode="json", by_alias=True) for e in errors],
            },
        )
    seen = set(
        session.scalars(
            select(m.PortfolioTransaction.external_id).where(
                m.PortfolioTransaction.portfolio_id == portfolio_id,
                m.PortfolioTransaction.external_id.is_not(None),
            )
        )
    )
    fresh: list[pf.TxIn] = []
    skipped = 0
    for r in rows:
        if r.external_id is not None:
            if r.external_id in seen:
                skipped += 1
                continue
            seen.add(r.external_id)
        fresh.append(r)
    if body.dry_run or not fresh:
        return pf.TxImportResult(batch=None, created=len(fresh), skipped=skipped, errors=[])
    batch = s.new_id()
    t = s.now()
    first = pf.next_seq(session, portfolio_id)
    session.add_all(
        m.PortfolioTransaction(
            id=s.new_id(),
            portfolio_id=portfolio_id,
            seq=first + n,
            **pf.tx_values(r),
            source=body.source,
            import_batch=batch,
            revision=1,
            created_at=t,
            updated_at=t,
        )
        for n, r in enumerate(fresh)
    )
    try:
        session.commit()
    except IntegrityError as exc:
        session.rollback()
        log.warning("import conflict: %s", exc.orig)
        raise HTTPException(409, "import conflicts with stored data") from None
    return pf.TxImportResult(batch=batch, created=len(fresh), skipped=skipped, errors=[])


@router.delete("/portfolios/{portfolio_id}/imports/{batch}", response_model=pf.ImportUndo)
def undo_import(session: OwnedSessionDep, portfolio_id: str, batch: str) -> pf.ImportUndo:
    """Removes every transaction of one import batch (0 if there is none)."""
    _portfolio(session, portfolio_id)
    result = session.execute(
        delete(m.PortfolioTransaction).where(
            m.PortfolioTransaction.portfolio_id == portfolio_id,
            m.PortfolioTransaction.import_batch == batch,
        )
    )
    n = store.rowcount(result)
    session.commit()
    return pf.ImportUndo(deleted=n)


# ----------------------------------------------------------------- journal


def _check_links(session: Session, portfolio_id: str, body: pf.JournalIn) -> None:
    if body.note_id is not None:
        # Someone else's note reads as a missing one (no existence oracle).
        linked = owned_get(session, m.Note, body.note_id)
        if linked is None:
            raise HTTPException(422, f"noteId: note not found: {body.note_id}")
        if linked.kind != "journal":
            raise HTTPException(422, f"noteId: not a journal note: {body.note_id}")
    if body.transaction_id is not None:
        tx = session.get(m.PortfolioTransaction, body.transaction_id)
        # `portfolio_id` was checked as the owner's, so a transaction of it is theirs too.
        if tx is None or tx.portfolio_id != portfolio_id:
            raise HTTPException(
                422, f"transactionId: not a transaction of this portfolio: {body.transaction_id}"
            )


def _with_screenshot(session: Session, rows: list[m.JournalEntry]) -> list[pf.JournalEntry]:
    ids = [r.id for r in rows]
    have: set[str] = set()
    if ids:
        have = set(
            session.scalars(
                select(m.JournalScreenshot.entry_id).where(m.JournalScreenshot.entry_id.in_(ids))
            )
        )
    return [pf.journal_out(r, r.id in have) for r in rows]


def _entry_out(session: Session, row: m.JournalEntry) -> pf.JournalEntry:
    return _with_screenshot(session, [row])[0]


@router.get("/portfolios/{portfolio_id}/journal", response_model=list[pf.JournalEntry])
def list_journal(session: OwnedSessionDep, portfolio_id: str) -> list[pf.JournalEntry]:
    """Oldest first."""
    _portfolio(session, portfolio_id)
    q = (
        select(m.JournalEntry)
        .where(m.JournalEntry.portfolio_id == portfolio_id)
        .order_by(m.JournalEntry.created_at, m.JournalEntry.id)
    )
    return _with_screenshot(session, list(session.scalars(q)))


@router.post("/portfolios/{portfolio_id}/journal", response_model=pf.JournalEntry, status_code=201)
def create_journal_entry(
    session: OwnedSessionDep, portfolio_id: str, body: pf.JournalIn
) -> pf.JournalEntry:
    _portfolio(session, portfolio_id)
    _check_links(session, portfolio_id, body)
    t = s.now()
    row = m.JournalEntry(
        id=s.new_id(),
        portfolio_id=portfolio_id,
        **pf.journal_values(body),
        revision=1,
        created_at=t,
        updated_at=t,
    )
    session.add(row)
    session.commit()
    return pf.journal_out(row, False)


@router.put("/journal/{entry_id}", response_model=pf.JournalEntry)
def update_journal_entry(
    session: OwnedSessionDep, entry_id: str, body: pf.JournalUpdate
) -> pf.JournalEntry:
    """Full replace of the content fields (the screenshot is separate). 409 (with the stored
    entry) if `revision` is given and stale. Changing or clearing `noteId` deletes the note it
    pointed to (an entry owns its note)."""
    existing = _entry(session, entry_id)
    _check_links(session, existing.portfolio_id, body)
    old_note = existing.note_id

    def drop_replaced_note(sess: Session) -> None:
        if old_note is not None and old_note != body.note_id:
            sess.execute(delete(m.Note).where(m.Note.id == old_note))

    def load(sess: Session, eid: str) -> Any:
        return _entry_out(sess, _entry(sess, eid))

    row = _revision_update(
        session,
        m.JournalEntry,
        entry_id,
        body.revision,
        pf.journal_values(body),
        "journal entry",
        load,
        lambda x: x,
        also=drop_replaced_note,
    )
    return _entry_out(session, row)


@router.delete("/journal/{entry_id}", status_code=204)
def delete_journal_entry(session: OwnedSessionDep, entry_id: str) -> Response:
    """Also deletes the linked note and the screenshot."""
    row = _entry(session, entry_id)
    note_id = row.note_id
    session.execute(delete(m.JournalScreenshot).where(m.JournalScreenshot.entry_id == entry_id))
    session.delete(row)
    session.flush()
    if note_id is not None:
        session.execute(delete(m.Note).where(m.Note.id == note_id))
    session.commit()
    return Response(status_code=204)


# ------------------------------------------------------------- screenshots


def _store_screenshot(session: Session, entry_id: str, mime: str, data: bytes) -> pf.JournalEntry:
    row = _entry(session, entry_id)
    try:
        pf.check_screenshot(mime, data)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    t = s.now()
    shot = session.get(m.JournalScreenshot, entry_id)
    if shot is None:
        session.add(m.JournalScreenshot(entry_id=entry_id, mime=mime, data=data, created_at=t))
    else:
        shot.mime, shot.data, shot.created_at = mime, data, t
    session.commit()
    return pf.journal_out(row, True)


def _too_large() -> HTTPException:
    return HTTPException(413, f"screenshot larger than {pf.MAX_SCREENSHOT_BYTES} bytes")


@router.put("/journal/{entry_id}/screenshot", response_model=pf.JournalEntry)
async def put_screenshot(
    session: OwnedSessionDep, entry_id: str, request: Request
) -> pf.JournalEntry:
    """Raw image body (`Content-Type` image/png|jpeg|webp, at most 5 MB, magic bytes must match).
    415 for another type, 413 when too large, 422 for empty or mismatching content."""
    mime = request.headers.get("content-type", "").split(";")[0].strip().lower()
    if mime not in pf.IMAGE_TYPES:
        raise HTTPException(415, f"Content-Type must be one of {', '.join(pf.IMAGE_TYPES)}")
    await run_in_threadpool(_entry, session, entry_id)
    declared = request.headers.get("content-length")
    if declared is not None and declared.isdigit() and int(declared) > pf.MAX_SCREENSHOT_BYTES:
        raise _too_large()
    chunks: list[bytes] = []
    size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > pf.MAX_SCREENSHOT_BYTES:
            raise _too_large()
        chunks.append(chunk)
    return await run_in_threadpool(_store_screenshot, session, entry_id, mime, b"".join(chunks))


@router.get("/journal/{entry_id}/screenshot")
def get_screenshot(session: OwnedSessionDep, entry_id: str) -> Response:
    _entry(session, entry_id)
    shot = session.get(m.JournalScreenshot, entry_id)
    if shot is None:
        raise HTTPException(404, f"no screenshot for journal entry: {entry_id}")
    return Response(
        content=shot.data,
        media_type=shot.mime,
        headers={"Cache-Control": "private, max-age=0"},
    )


@router.delete("/journal/{entry_id}/screenshot", status_code=204)
def delete_screenshot(session: OwnedSessionDep, entry_id: str) -> Response:
    _entry(session, entry_id)
    shot = session.get(m.JournalScreenshot, entry_id)
    if shot is None:
        raise HTTPException(404, f"no screenshot for journal entry: {entry_id}")
    session.delete(shot)
    session.commit()
    return Response(status_code=204)


router.include_router(capped_router)
