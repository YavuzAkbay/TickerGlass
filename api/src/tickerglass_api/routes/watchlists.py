"""Watchlists (whole-list revisions, client-chosen ids) and global symbol flags."""

from fastapi import APIRouter, HTTPException, Response
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError

from .. import models as m
from ..deps import SessionDep
from ..userdata import schemas as s
from ..userdata import store

router = APIRouter(prefix="/watchlists", tags=["watchlists"])
flags_router = APIRouter(prefix="/flags", tags=["watchlists"])
_FLAG_RETRIES = 3


def _get(session: SessionDep, watchlist_id: str) -> m.Watchlist:
    row = session.get(m.Watchlist, watchlist_id)
    if row is None:
        raise HTTPException(404, f"watchlist not found: {watchlist_id}")
    return row


def _conflict(row: m.Watchlist) -> HTTPException:
    return HTTPException(
        409,
        {
            "message": f"watchlist {row.id} changed elsewhere",
            "current": store.watchlist(row).model_dump(mode="json", by_alias=True),
        },
    )


@router.get("", response_model=list[s.Watchlist])
def list_watchlists(session: SessionDep) -> list[s.Watchlist]:
    """All watchlists with their items (oldest first)."""
    q = select(m.Watchlist).order_by(m.Watchlist.created_at, m.Watchlist.id)
    return [store.watchlist(r) for r in session.scalars(q)]


@router.post("", response_model=s.Watchlist, status_code=201)
def create_watchlist(session: SessionDep, body: s.WatchlistIn) -> s.Watchlist:
    """409 (with the stored list) if a client-chosen `id` already exists."""
    wid = body.id or s.new_id()
    existing = session.get(m.Watchlist, wid)
    if existing is not None:
        raise _conflict(existing)
    t = s.now()
    row = m.Watchlist(
        id=wid,
        name=body.name,
        items=store.dump_items(body.items),
        revision=1,
        created_at=t,
        updated_at=t,
    )
    session.add(row)
    try:
        session.commit()
    except IntegrityError:
        # A concurrent POST claimed this id between our check and insert.
        session.rollback()
        winner = session.get(m.Watchlist, wid)
        if winner is None:
            raise
        raise _conflict(winner) from None
    return store.watchlist(row)


@router.get("/{watchlist_id}", response_model=s.Watchlist)
def get_watchlist(session: SessionDep, watchlist_id: str) -> s.Watchlist:
    return store.watchlist(_get(session, watchlist_id))


@router.put("/{watchlist_id}", response_model=s.Watchlist)
def update_watchlist(
    session: SessionDep, watchlist_id: str, body: s.WatchlistUpdate
) -> s.Watchlist:
    """409 (with the stored list) if `revision` is given and stale.

    Check and write are one conditional UPDATE (no lost updates under concurrency).
    """
    cond = [m.Watchlist.id == watchlist_id]
    if body.revision is not None:
        cond.append(m.Watchlist.revision == body.revision)
    stmt = (
        update(m.Watchlist)
        .where(*cond)
        .values(
            name=body.name,
            items=store.dump_items(body.items),
            revision=m.Watchlist.revision + 1,
            updated_at=s.now(),
        )
        .execution_options(synchronize_session=False)
    )
    if store.rowcount(session.execute(stmt)) != 1:
        session.rollback()
        raise _conflict(_get(session, watchlist_id))
    row = store.reload(session, m.Watchlist, watchlist_id)
    session.commit()
    return store.watchlist(row)


@router.delete("/{watchlist_id}", status_code=204)
def delete_watchlist(session: SessionDep, watchlist_id: str) -> Response:
    session.delete(_get(session, watchlist_id))
    session.commit()
    return Response(status_code=204)


def _all_flags(session: SessionDep) -> list[s.Flag]:
    q = select(m.SymbolFlag).order_by(m.SymbolFlag.created_at, m.SymbolFlag.symbol)
    return [store.flag(r) for r in session.scalars(q)]


@flags_router.get("", response_model=list[s.Flag])
def list_flags(session: SessionDep) -> list[s.Flag]:
    return _all_flags(session)


@flags_router.patch("", response_model=list[s.Flag])
def patch_flags(session: SessionDep, body: s.FlagsPatch) -> list[s.Flag]:
    """Set (color) or remove (null) flags in one transaction; returns all flags."""
    t = s.now()
    for attempt in range(_FLAG_RETRIES):
        try:
            # Autoflush can raise inside the loop too, so the whole attempt is guarded.
            for symbol, color in body.items():
                row = session.get(m.SymbolFlag, symbol)
                if color is None:
                    if row is not None:
                        session.delete(row)
                elif row is None:
                    session.add(
                        m.SymbolFlag(symbol=symbol, color=color, created_at=t, updated_at=t)
                    )
                elif row.color != color:
                    row.color, row.created_at, row.updated_at = color, t, t
            session.commit()
            break
        except IntegrityError:
            # A concurrent PATCH inserted the same symbol: redo against the new state.
            session.rollback()
            if attempt == _FLAG_RETRIES - 1:
                raise HTTPException(409, "flags changed elsewhere; retry") from None
    return _all_flags(session)
