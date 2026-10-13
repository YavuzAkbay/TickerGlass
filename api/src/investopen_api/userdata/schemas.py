"""Request/response models for user data. JSON payloads are opaque to the
server: only their size, top-level type and `schemaVersion` are validated."""

import json
import re
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Annotated, Any, Literal
from uuid import uuid4

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, StringConstraints
from pydantic.alias_generators import to_camel

#: Version of the import/export bundle format (`Bundle.version`).
BUNDLE_VERSION = 1

MAX_STATE_BYTES = 2_000_000
MAX_DRAWING_BYTES = 512_000
MAX_TEMPLATE_BYTES = 256_000
MAX_SETTING_BYTES = 512_000
MAX_NOTE_CHARS = 200_000
MAX_BATCH_OPS = 5_000
MAX_BUNDLE_ITEMS = 100_000


def now() -> datetime:
    return datetime.now(UTC)


def new_id() -> str:
    return str(uuid4())


def aware(dt: datetime) -> datetime:
    """SQLite returns naive datetimes; everything stored is UTC."""
    return dt if dt.tzinfo else dt.replace(tzinfo=UTC)


def json_size(value: Any) -> int:
    return len(json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode())


def _max_size(limit: int) -> Callable[[Any], Any]:
    def check(value: Any) -> Any:
        size = json_size(value)
        if size > limit:
            raise ValueError(f"JSON payload too large ({size} bytes, max {limit})")
        return value

    return check


StateJson = Annotated[dict[str, Any], AfterValidator(_max_size(MAX_STATE_BYTES))]
DrawingJson = Annotated[dict[str, Any], AfterValidator(_max_size(MAX_DRAWING_BYTES))]
TemplateJson = Annotated[dict[str, Any], AfterValidator(_max_size(MAX_TEMPLATE_BYTES))]
TemplateList = Annotated[list[Any], AfterValidator(_max_size(MAX_TEMPLATE_BYTES))]
SettingValue = Annotated[Any, AfterValidator(_max_size(MAX_SETTING_BYTES))]

Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
Id = Annotated[str, StringConstraints(min_length=1, max_length=36)]
DrawingId = Annotated[str, StringConstraints(min_length=1, max_length=64)]
ToolType = Annotated[str, StringConstraints(min_length=1, max_length=64)]
SchemaVersion = Annotated[int, Field(ge=1, le=1_000_000)]
Revision = Annotated[int, Field(ge=1)]
NoteText = Annotated[str, StringConstraints(max_length=MAX_NOTE_CHARS)]

_SETTING_KEY = re.compile(r"^[A-Za-z0-9_.\-]{1,64}$")


def check_setting_key(key: str) -> str:
    if not _SETTING_KEY.match(key):
        raise ValueError("setting key must match [A-Za-z0-9_.-]{1,64}")
    return key


SettingKey = Annotated[str, AfterValidator(check_setting_key)]


def _norm_symbol(value: str | None) -> str | None:
    if value is None:
        return None
    value = value.strip().upper()
    if len(value) > 32:
        raise ValueError("symbol longer than 32 characters")
    return value


Symbol = Annotated[str | None, AfterValidator(_norm_symbol)]


class ApiModel(BaseModel):
    """camelCase on the wire (responses are serialized by alias)."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")


# ------------------------------------------------------------------ layouts


class LayoutSummary(ApiModel):
    id: str
    name: str
    schema_version: int
    revision: int
    is_last_used: bool
    created_at: datetime
    updated_at: datetime


class Layout(LayoutSummary):
    state: dict[str, Any]


class LayoutCreate(ApiModel):
    name: Name
    state: StateJson
    schema_version: SchemaVersion = 1


class LayoutSave(ApiModel):
    state: StateJson
    schema_version: SchemaVersion = 1
    #: Revision the client's state is based on; 409 if the server moved on.
    revision: Revision


class LayoutRename(ApiModel):
    name: Name


class LastUsed(ApiModel):
    id: Id


class LayoutDocument(ApiModel):
    name: Name
    state: StateJson
    schema_version: SchemaVersion = 1


class LayoutExport(ApiModel):
    """Single-layout file (`GET /api/layouts/{id}/export`)."""

    version: int = BUNDLE_VERSION
    kind: Literal["layout"] = "layout"
    exported_at: datetime | None = None
    layout: LayoutDocument


# ----------------------------------------------------------------- drawings


class Drawing(ApiModel):
    id: str
    #: null = synced across all symbols (scope 'all').
    symbol: str | None
    pane_id: str
    z: int
    #: The engine `Drawing` JSON, as sent.
    data: dict[str, Any]
    schema_version: int
    revision: int
    updated_at: datetime


class DrawingList(ApiModel):
    drawings: list[Drawing]


class DrawingUpsert(ApiModel):
    drawing: DrawingJson
    #: Revision the edit is based on; null = new drawing (409 if it exists).
    base_revision: Revision | None = None


class DrawingDelete(ApiModel):
    id: DrawingId
    #: null = delete whatever is stored.
    base_revision: Revision | None = None


class DrawingBatch(ApiModel):
    upserts: list[DrawingUpsert] = Field(default_factory=list, max_length=MAX_BATCH_OPS)
    deletes: list[DrawingDelete] = Field(default_factory=list, max_length=MAX_BATCH_OPS)
    schema_version: SchemaVersion = 1
    #: Skip revision checks (last writer wins), e.g. "keep mine" after a conflict.
    force: bool = False


class DrawingBatchResult(ApiModel):
    drawings: list[Drawing]
    deleted: list[str]


class DrawingConflict(ApiModel):
    id: str
    #: Stored revision; null when the drawing no longer exists.
    revision: int | None
    drawing: Drawing | None


# ---------------------------------------------------------------- templates


class IndicatorTemplateIn(ApiModel):
    name: Name
    instances: TemplateList
    schema_version: SchemaVersion = 1


class IndicatorTemplate(ApiModel):
    id: str
    name: str
    instances: list[Any]
    schema_version: int
    created_at: datetime
    updated_at: datetime


class DrawingTemplateIn(ApiModel):
    tool_type: ToolType
    name: Name
    style: TemplateJson
    is_default: bool = False
    schema_version: SchemaVersion = 1


class DrawingTemplate(ApiModel):
    id: str
    tool_type: str
    name: str
    style: dict[str, Any]
    is_default: bool
    schema_version: int
    created_at: datetime
    updated_at: datetime


class ChartTemplateIn(ApiModel):
    name: Name
    data: TemplateJson
    schema_version: SchemaVersion = 1


class ChartTemplate(ApiModel):
    id: str
    name: str
    data: dict[str, Any]
    schema_version: int
    created_at: datetime
    updated_at: datetime


# ----------------------------------------------------------------- settings


class SettingIn(ApiModel):
    value: SettingValue


# -------------------------------------------------------------------- notes


class NoteIn(ApiModel):
    symbol: Symbol = None
    text: NoteText


class NoteUpdate(ApiModel):
    symbol: Symbol = None
    text: NoteText
    #: When given, 409 unless it matches the stored revision.
    revision: Revision | None = None


class Note(ApiModel):
    id: str
    symbol: str | None
    text: str
    revision: int
    created_at: datetime
    updated_at: datetime


# ------------------------------------------------------------ import/export


class BundleLayout(ApiModel):
    id: Id
    name: Name
    state: StateJson
    schema_version: SchemaVersion = 1
    is_last_used: bool = False
    revision: int | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


class BundleDrawing(ApiModel):
    data: DrawingJson
    schema_version: SchemaVersion = 1
    # Informational on import (derived from `data`):
    id: str | None = None
    symbol: str | None = None
    pane_id: str | None = None
    z: int | None = None
    revision: int | None = None
    updated_at: datetime | None = None


class BundleIndicatorTemplate(IndicatorTemplateIn):
    id: Id | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


class BundleDrawingTemplate(DrawingTemplateIn):
    id: Id | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


class BundleChartTemplate(ChartTemplateIn):
    id: Id | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


class BundleNote(ApiModel):
    id: Id
    symbol: Symbol = None
    text: NoteText
    revision: int | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


class Bundle(ApiModel):
    """All user data (`GET /api/export`, `POST /api/import`)."""

    version: int = BUNDLE_VERSION
    app: Literal["investopen"] = "investopen"
    exported_at: datetime | None = None
    layouts: list[BundleLayout] = Field(default_factory=list, max_length=MAX_BUNDLE_ITEMS)
    drawings: list[BundleDrawing] = Field(default_factory=list, max_length=MAX_BUNDLE_ITEMS)
    indicator_templates: list[BundleIndicatorTemplate] = Field(
        default_factory=list, max_length=MAX_BUNDLE_ITEMS
    )
    drawing_templates: list[BundleDrawingTemplate] = Field(
        default_factory=list, max_length=MAX_BUNDLE_ITEMS
    )
    chart_templates: list[BundleChartTemplate] = Field(
        default_factory=list, max_length=MAX_BUNDLE_ITEMS
    )
    settings: dict[SettingKey, SettingValue] = Field(default_factory=dict)
    notes: list[BundleNote] = Field(default_factory=list, max_length=MAX_BUNDLE_ITEMS)


class ImportCounts(ApiModel):
    created: int = 0
    updated: int = 0
    deleted: int = 0


class ImportSummary(ApiModel):
    mode: Literal["merge", "replace"]
    dry_run: bool
    layouts: ImportCounts = Field(default_factory=ImportCounts)
    drawings: ImportCounts = Field(default_factory=ImportCounts)
    indicator_templates: ImportCounts = Field(default_factory=ImportCounts)
    drawing_templates: ImportCounts = Field(default_factory=ImportCounts)
    chart_templates: ImportCounts = Field(default_factory=ImportCounts)
    settings: ImportCounts = Field(default_factory=ImportCounts)
    notes: ImportCounts = Field(default_factory=ImportCounts)
