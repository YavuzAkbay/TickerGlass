"""Import/export of all user data as one versioned JSON bundle."""

import logging
from typing import Annotated, Literal

from fastapi import APIRouter, HTTPException, Query
from sqlalchemy.exc import IntegrityError

from ..deps import HubDep, OwnedSessionDep, SettingsDep, UserDep
from ..userdata import schemas as s
from ..userdata import store

log = logging.getLogger("tickerglass.transfer")

router = APIRouter(tags=["import-export"])


@router.get("/export", response_model=s.Bundle)
def export_all(session: OwnedSessionDep) -> s.Bundle:
    return store.export_bundle(session)


@router.post("/import", response_model=s.ImportSummary)
def import_all(
    session: OwnedSessionDep,
    user: UserDep,
    hub: HubDep,
    settings: SettingsDep,
    body: s.Bundle,
    mode: Literal["merge", "replace"] = "merge",
    dry_run: Annotated[bool, Query(alias="dryRun")] = False,
    confirm: bool = False,
) -> s.ImportSummary:
    """Validate and apply a bundle in one transaction. `dryRun=true` reports
    what would change and rolls back. `mode=replace` deletes data, so (unless
    dry-running) it needs `confirm=true` (400 otherwise); it only replaces the
    sections present in the bundle. Everything lands under the signed-in user and `replace`
    deletes only their rows. An id that belongs to another user is stored under a fresh id
    (references inside the bundle follow), except user scripts: layouts, templates and alerts
    name them as `user:<id>`, so those answer 409 "id in use" and nothing is imported."""
    if mode == "replace" and not confirm and not dry_run:
        raise HTTPException(400, "mode=replace deletes data: add confirm=true")
    try:
        touched = store.Touched()
        summary = store.import_bundle(session, body, mode, touched, settings)
    except store.BundleError as exc:
        session.rollback()
        raise HTTPException(422, str(exc)) from exc
    except store.IdInUse as exc:
        session.rollback()
        log.info("import refused: %s", exc)
        raise HTTPException(409, "id in use") from None
    except IntegrityError as exc:
        # The database's message can name other users' rows: log it, answer generically.
        session.rollback()
        log.warning("import conflict: %s", exc.orig)
        raise HTTPException(409, "import conflicts with stored data") from None
    if dry_run:
        session.rollback()
    else:
        session.commit()
        if touched.alerts or touched.alerts_deleted:
            hub.publish_threadsafe(
                "alerts",
                {
                    "type": "alerts.changed",
                    "ids": sorted(touched.alerts),
                    "deleted": sorted(touched.alerts_deleted),
                },
                owner_id=user.id,
            )
        if touched.drawings or touched.drawings_deleted:
            hub.publish_threadsafe(
                "drawings",
                {
                    "type": "drawings.changed",
                    "ids": sorted(touched.drawings),
                    "deleted": sorted(touched.drawings_deleted),
                },
                owner_id=user.id,
            )
    summary.dry_run = dry_run
    return summary
