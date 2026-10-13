"""Import/export of all user data as one versioned JSON bundle."""

from typing import Annotated, Literal

from fastapi import APIRouter, HTTPException, Query
from sqlalchemy.exc import IntegrityError

from ..deps import SessionDep
from ..userdata import schemas as s
from ..userdata import store

router = APIRouter(tags=["import-export"])


@router.get("/export", response_model=s.Bundle)
def export_all(session: SessionDep) -> s.Bundle:
    return store.export_bundle(session)


@router.post("/import", response_model=s.ImportSummary)
def import_all(
    session: SessionDep,
    body: s.Bundle,
    mode: Literal["merge", "replace"] = "merge",
    dry_run: Annotated[bool, Query(alias="dryRun")] = False,
    confirm: bool = False,
) -> s.ImportSummary:
    """Validate and apply a bundle in one transaction. `dryRun=true` reports
    what would change and rolls back. `mode=replace` deletes data, so (unless
    dry-running) it needs `confirm=true` (400 otherwise); it only replaces the
    sections present in the bundle."""
    if mode == "replace" and not confirm and not dry_run:
        raise HTTPException(400, "mode=replace deletes data: add confirm=true")
    try:
        summary = store.import_bundle(session, body, mode)
    except store.BundleError as exc:
        session.rollback()
        raise HTTPException(422, str(exc)) from exc
    except IntegrityError as exc:
        session.rollback()
        raise HTTPException(409, f"import conflicts with stored data: {exc.orig}") from exc
    if dry_run:
        session.rollback()
    else:
        session.commit()
    summary.dry_run = dry_run
    return summary
