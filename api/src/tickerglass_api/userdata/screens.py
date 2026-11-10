"""Saved screens: request/response models, spec validation and serializers
(docs/design/server-screener.md §4).

Self-contained (no import of `schemas`) because `schemas.Bundle` embeds `BundleScreen`.
A screen's `spec` is validated with the scanner's own pydantic models and stored in its
normalized JSON form; the optional `alert` is `{enabled, notify:{webhook, telegram, email,
webhookUrl?}}`.
"""

import re
from datetime import UTC, datetime
from typing import Annotated, Any, Literal

from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    StringConstraints,
    ValidationError,
    model_validator,
)
from pydantic.alias_generators import to_camel

from .. import models as m
from ..services.screener.schemas import Group, ScanRequest, Sort, Universe

SCREEN_SCHEMA_VERSION = 1
MAX_SCREENS = 200
MAX_COLUMNS = 40
MAX_SPEC_BYTES = 64 * 1024

_ID = re.compile(r"^[A-Za-z0-9_-]{1,36}$")


def _check_id(value: str) -> str:
    if not _ID.match(value):
        raise ValueError("id must match [A-Za-z0-9_-]{1,36}")
    return value


ScreenId = Annotated[str, AfterValidator(_check_id)]
Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
Revision = Annotated[int, Field(ge=1)]


def utc(dt: datetime) -> datetime:
    return dt.replace(tzinfo=UTC) if dt.tzinfo is None else dt.astimezone(UTC)


class ScreenModel(BaseModel):
    """camelCase on the wire; unknown keys are rejected."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")


# --------------------------------------------------------------------- spec


class ScreenSpec(ScreenModel):
    """`{schemaVersion: 1, universe, filter, sort, columns?}`; shapes come from the scanner's
    models and the filter, sort and columns are checked like a scan request would be."""

    schema_version: Literal[1]
    universe: Universe
    filter: Group | None = None
    sort: Sort
    columns: Annotated[list[str], Field(max_length=MAX_COLUMNS)] | None = None

    @model_validator(mode="after")
    def _semantics(self) -> "ScreenSpec":
        # Imported here: `query` imports `userdata.schemas`, which embeds this module.
        from ..services.screener.query import ScanError, validate_request

        if self.columns is not None and len(set(self.columns)) != len(self.columns):
            raise ValueError("duplicate column")
        req = ScanRequest(
            universe=self.universe, filter=self.filter, sort=self.sort, fields=self.columns
        )
        try:
            validate_request(req)
        except ScanError as exc:
            where = f" at {exc.path}" if exc.path else ""
            raise ValueError(f"{exc.code}: {exc.message}{where}") from None
        return self


def dump_spec(spec: ScreenSpec) -> dict[str, Any]:
    """Normalized stored JSON (camelCase; `filter` kept as null, `columns` omitted if unset)."""
    out: dict[str, Any] = spec.model_dump(mode="json", by_alias=True, exclude_none=True)
    out.setdefault("filter", None)
    return out


def check_spec(raw: Any) -> ScreenSpec:
    """Validate stored/foreign spec JSON; raises `ValueError` with a readable reason."""
    try:
        return ScreenSpec.model_validate(raw)
    except ValidationError as exc:
        raise ValueError(str(exc)) from exc


# -------------------------------------------------------------------- alert


class ScreenNotify(ScreenModel):
    webhook: StrictBool = False
    telegram: StrictBool = False
    email: StrictBool = False
    #: null = the API's `ALERTS_WEBHOOK_URL`.
    webhook_url: Annotated[str | None, StringConstraints(max_length=500, pattern=r"^https?://")] = (
        None
    )


class ScreenAlert(ScreenModel):
    enabled: StrictBool
    notify: ScreenNotify = Field(default_factory=ScreenNotify)


def dump_alert(alert: ScreenAlert | None) -> dict[str, Any] | None:
    if alert is None:
        return None
    out: dict[str, Any] = alert.model_dump(mode="json", by_alias=True, exclude_none=True)
    return out


def alert_enabled(alert: dict[str, Any] | None) -> bool:
    return bool(alert and alert.get("enabled"))


def alert_notify(alert: dict[str, Any] | None) -> ScreenNotify:
    """Notify channels of a stored alert (all off when there is none)."""
    if not alert:
        return ScreenNotify()
    return ScreenNotify.model_validate(alert.get("notify") or {})


# ------------------------------------------------------------------- bodies


def _spec_size(value: ScreenSpec) -> ScreenSpec:
    import json

    size = len(json.dumps(dump_spec(value), separators=(",", ":"), ensure_ascii=False).encode())
    if size > MAX_SPEC_BYTES:
        raise ValueError(f"spec too large ({size} bytes, max {MAX_SPEC_BYTES})")
    return value


SpecField = Annotated[ScreenSpec, AfterValidator(_spec_size)]


class ScreenIn(ScreenModel):
    #: Client-chosen id (offline creation keeps its identity); null = server assigns.
    id: ScreenId | None = None
    name: Name
    spec: SpecField
    alert: ScreenAlert | None = None


class ScreenUpdate(ScreenModel):
    name: Name
    spec: SpecField
    alert: ScreenAlert | None = None
    #: When given, 409 unless it matches the stored revision.
    revision: Revision | None = None


class ScreenPatch(ScreenModel):
    """Only the given keys change (`alert: null` removes the alert)."""

    name: Name | None = None
    spec: SpecField | None = None
    alert: ScreenAlert | None = None
    revision: Revision | None = None


class Screen(ScreenModel):
    id: str
    name: str
    spec: dict[str, Any]
    alert: dict[str, Any] | None
    revision: int
    created_at: datetime
    updated_at: datetime


class Preset(ScreenModel):
    id: str
    name: str
    spec: dict[str, Any]


class BundleScreen(ScreenModel):
    id: Annotated[str, StringConstraints(min_length=1, max_length=36)]
    name: Name
    spec: SpecField
    alert: ScreenAlert | None = None
    revision: int | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


# -------------------------------------------------------------- serializers


def screen_out(row: m.Screen) -> Screen:
    return Screen(
        id=row.id,
        name=row.name,
        spec=row.spec,
        alert=row.alert,
        revision=row.revision,
        created_at=utc(row.created_at),
        updated_at=utc(row.updated_at),
    )
