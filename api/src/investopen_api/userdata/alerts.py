"""Alert request/response models, spec validation and serializers (docs/alerts.md §1).

Self-contained (no import of `schemas`) because `schemas.Bundle` embeds `BundleAlert`.
The spec models mirror `@investopen/alerts` `types.ts`; they check shape only (the
TypeScript validator additionally checks indicator types, outputs and cycles).
"""

import json
import re
from datetime import UTC, datetime
from typing import Annotated, Any, Literal

from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    StrictInt,
    StrictStr,
    StringConstraints,
    model_validator,
)
from pydantic.alias_generators import to_camel

from .. import models as m

ALERT_SCHEMA_VERSION = 1
MAX_ALERTS = 1000
MAX_SPEC_BYTES = 64 * 1024
MAX_STATE_BYTES = 16 * 1024
MAX_INSTANCES = 16
MAX_STATES_PER_CALL = 1000
MAX_MESSAGE_CHARS = 2000

#: Ids that would shadow fixed `/api/alerts/...` routes.
RESERVED_ALERT_IDS = frozenset({"log", "states", "channels", "service"})

LINE_TOOLS = frozenset(
    {
        "trend-line",
        "ray",
        "extended-line",
        "measured-line",
        "arrow-line",
        "horizontal-line",
        "horizontal-ray",
    }
)

_ID = re.compile(r"^[A-Za-z0-9_-]{1,36}$")
_INSTANCE_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def utc(dt: datetime) -> datetime:
    """Aware UTC (SQLite returns naive datetimes; everything stored is UTC)."""
    return dt.replace(tzinfo=UTC) if dt.tzinfo is None else dt.astimezone(UTC)


def _json_size(value: Any) -> int:
    return len(json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode())


def _check_alert_id(value: str) -> str:
    if not _ID.match(value):
        raise ValueError("id must match [A-Za-z0-9_-]{1,36}")
    if value in RESERVED_ALERT_IDS:
        raise ValueError(f"id {value!r} is reserved")
    return value


def _check_instance_id(value: str) -> str:
    if not _INSTANCE_ID.match(value):
        raise ValueError("instance id must match [A-Za-z0-9_-]{1,64}")
    return value


def _printable(value: str) -> str:
    if not value.isprintable():
        raise ValueError("must contain printable characters only")
    return value


def _max_json(limit: int) -> Any:
    def check(value: Any) -> Any:
        size = _json_size(value)
        if size > limit:
            raise ValueError(f"JSON payload too large ({size} bytes, max {limit})")
        return value

    return AfterValidator(check)


class AlertModel(BaseModel):
    """camelCase on the wire (responses are serialized by alias)."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")


AlertId = Annotated[str, AfterValidator(_check_alert_id)]
InstanceId = Annotated[str, AfterValidator(_check_instance_id)]
Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
SymbolStr = Annotated[
    str, StringConstraints(min_length=1, max_length=128), AfterValidator(_printable)
]
Interval = Annotated[str, StringConstraints(pattern=r"^[1-9][0-9]{0,5}[mhDWM]$")]
Revision = Annotated[int, Field(ge=1)]
DrawingId = Annotated[str, StringConstraints(min_length=1, max_length=64)]
ShortId = Annotated[str, StringConstraints(min_length=1, max_length=64)]
FiniteFloat = Annotated[float, Field(strict=True, allow_inf_nan=False)]
#: Ints stay ints (smart union picks the exact match), floats must be finite.
Number = StrictInt | FiniteFloat
Message = Annotated[str, StringConstraints(max_length=MAX_MESSAGE_CHARS)]
Reason = Annotated[str, StringConstraints(max_length=500)]
Status = Literal["active", "paused", "triggered", "expired", "error"]

# --------------------------------------------------------------------- spec

PriceField = Literal["close", "open", "high", "low", "hl2", "hlc3", "ohlc4"]
Scale = Literal["linear", "log"]
DrawingPart = Literal["line", "upper", "lower", "middle"]


class OutputRef(AlertModel):
    instance_id: InstanceId
    output_id: ShortId


InputValue = (
    StrictBool
    | StrictInt
    | FiniteFloat
    | Annotated[StrictStr, StringConstraints(max_length=200)]
    | OutputRef
)


class IndicatorInstance(AlertModel):
    id: InstanceId
    type: ShortId
    inputs: dict[ShortId, InputValue] = Field(max_length=64)


class IndicatorRef(AlertModel):
    instances: list[IndicatorInstance] = Field(min_length=1, max_length=MAX_INSTANCES)
    instance_id: InstanceId
    output_id: ShortId
    title: Annotated[str, StringConstraints(max_length=200)]

    @model_validator(mode="after")
    def _check_graph(self) -> "IndicatorRef":
        ids = [i.id for i in self.instances]
        if len(set(ids)) != len(ids):
            raise ValueError("duplicate indicator instance id")
        known = set(ids)
        if self.instance_id not in known:
            raise ValueError(f"instanceId {self.instance_id!r} is not among the instances")
        for inst in self.instances:
            for key, value in inst.inputs.items():
                if isinstance(value, OutputRef) and value.instance_id not in known:
                    raise ValueError(
                        f"instance {inst.id!r} input {key!r} points to unknown instance "
                        f"{value.instance_id!r}"
                    )
        return self


class PriceOperand(AlertModel):
    kind: Literal["price"]
    field: PriceField


class IndicatorOperand(AlertModel):
    kind: Literal["indicator"]
    ref: IndicatorRef


class ConstOperand(AlertModel):
    kind: Literal["value"]
    value: Number


class DrawingLineOperand(AlertModel):
    kind: Literal["drawing"]
    drawing_id: DrawingId
    part: DrawingPart
    scale: Scale


SeriesOperand = Annotated[PriceOperand | IndicatorOperand, Field(discriminator="kind")]
ValueOperand = Annotated[
    PriceOperand | IndicatorOperand | ConstOperand | DrawingLineOperand,
    Field(discriminator="kind"),
]


class BoundsChannel(AlertModel):
    kind: Literal["bounds"]
    upper: ValueOperand
    lower: ValueOperand


class DrawingChannel(AlertModel):
    kind: Literal["drawing"]
    drawing_id: DrawingId
    scale: Scale


ChannelOperand = Annotated[BoundsChannel | DrawingChannel, Field(discriminator="kind")]


class CompareCondition(AlertModel):
    op: Literal["crossing", "crossingUp", "crossingDown", "greater", "less"]
    right: ValueOperand


class ChannelCondition(AlertModel):
    op: Literal["enteringChannel", "exitingChannel", "insideChannel", "outsideChannel"]
    channel: ChannelOperand


class MovingCondition(AlertModel):
    op: Literal["movingUp", "movingDown", "movingUpPercent", "movingDownPercent"]
    amount: Number
    bars: Annotated[int, Field(strict=True, ge=1, le=1000)]

    @model_validator(mode="after")
    def _check_amount(self) -> "MovingCondition":
        if not self.amount > 0:
            raise ValueError("amount must be > 0")
        if self.op.endswith("Percent") and self.amount > 10000:
            raise ValueError("percent amount must be <= 10000")
        return self


Condition = Annotated[
    CompareCondition | ChannelCondition | MovingCondition, Field(discriminator="op")
]


class AlertSpec(AlertModel):
    schema_version: Literal[1]
    left: SeriesOperand
    condition: Condition
    trigger: Literal["once", "oncePerBar", "oncePerBarClose", "everyTime"]

    @model_validator(mode="after")
    def _check_limits(self) -> "AlertSpec":
        total = sum(len(r.instances) for r in indicator_refs(self))
        if total > MAX_INSTANCES:
            raise ValueError(f"at most {MAX_INSTANCES} indicator instances per spec (got {total})")
        size = _json_size(self.model_dump(mode="json", by_alias=True))
        if size > MAX_SPEC_BYTES:
            raise ValueError(f"spec too large ({size} bytes, max {MAX_SPEC_BYTES})")
        return self


def _operands(spec: AlertSpec) -> list[Any]:
    """Every operand of the spec in document order (left, then the condition's)."""
    out: list[Any] = [spec.left]
    cond = spec.condition
    if isinstance(cond, CompareCondition):
        out.append(cond.right)
    elif isinstance(cond, ChannelCondition):
        ch = cond.channel
        if isinstance(ch, BoundsChannel):
            out.extend([ch.upper, ch.lower])
        else:
            out.append(ch)
    return out


def indicator_refs(spec: AlertSpec) -> list[IndicatorRef]:
    return [o.ref for o in _operands(spec) if isinstance(o, IndicatorOperand)]


class DrawingUse(BaseModel):
    """One drawing reference of a spec (what the route validates against the drawing)."""

    drawing_id: str
    #: `None` = the whole channel (`ChannelOperand`).
    part: DrawingPart | None


def drawing_uses(spec: AlertSpec) -> list[DrawingUse]:
    out: list[DrawingUse] = []
    for o in _operands(spec):
        if isinstance(o, DrawingLineOperand):
            out.append(DrawingUse(drawing_id=o.drawing_id, part=o.part))
        elif isinstance(o, DrawingChannel):
            out.append(DrawingUse(drawing_id=o.drawing_id, part=None))
    return out


def derive_drawing_id(spec: AlertSpec) -> str | None:
    uses = drawing_uses(spec)
    return uses[0].drawing_id if uses else None


def dump_spec(spec: AlertSpec) -> dict[str, Any]:
    return spec.model_dump(mode="json", by_alias=True)


# ------------------------------------------------------------------- notify


class AlertNotify(AlertModel):
    toast: bool = True
    sound: bool = True
    browser: bool = False
    webhook: bool = False
    #: null = the API's `ALERTS_WEBHOOK_URL`.
    webhook_url: Annotated[str | None, StringConstraints(max_length=500, pattern=r"^https?://")] = (
        None
    )
    webhook_raw: bool = False
    telegram: bool = False
    email: bool = False


def dump_notify(notify: AlertNotify) -> dict[str, Any]:
    return notify.model_dump(mode="json", by_alias=True)


# ------------------------------------------------------------------- bodies


class AlertFields(AlertModel):
    name: Name
    symbol: SymbolStr
    interval: Interval
    prepost: bool = False
    spec: AlertSpec
    #: Template (§4.3); '' = default template.
    message: Message = ""
    notify: AlertNotify = Field(default_factory=AlertNotify)
    expires_at: datetime | None = None


class AlertIn(AlertFields):
    #: Client-chosen id (a retried POST keeps its identity); null = server assigns.
    id: AlertId | None = None
    #: Create/PUT only these; null = `active` on create, keep `active`/`paused` on PUT.
    status: Literal["active", "paused"] | None = None


class AlertUpdate(AlertIn):
    #: When given, 409 unless it matches the stored revision.
    revision: Revision | None = None


class AlertPatch(AlertModel):
    status: Literal["active", "paused"]
    #: Absent = unchanged; null = open-ended.
    expires_at: datetime | None = None
    revision: Revision | None = None


class AlertStatusIn(AlertModel):
    revision: Revision
    status: Literal["expired", "error"]
    reason: Reason = ""


class FireIn(AlertModel):
    fire_id: Annotated[str, StringConstraints(min_length=1, max_length=36)]
    revision: Revision
    fired_at: datetime
    bar_time: int
    final: bool = False
    delayed: bool = False
    message: Message
    values: Annotated[dict[str, Any], _max_json(MAX_STATE_BYTES)]
    state: Annotated[dict[str, Any], _max_json(MAX_STATE_BYTES)] | None = None


class StateIn(AlertModel):
    alert_id: Annotated[str, StringConstraints(min_length=1, max_length=36)]
    revision: Revision
    state: Annotated[dict[str, Any], _max_json(MAX_STATE_BYTES)]


class StatesPut(AlertModel):
    states: list[StateIn] = Field(max_length=MAX_STATES_PER_CALL)


class StatesWritten(AlertModel):
    written: list[str]
    ignored: list[str]


class LogRead(AlertModel):
    up_to: Annotated[int, Field(ge=0)] | None = None
    ids: list[int] | None = Field(default=None, max_length=10_000)


class ChannelTest(AlertModel):
    webhook_url: Annotated[str | None, StringConstraints(max_length=500, pattern=r"^https?://")] = (
        None
    )


class ServiceHeartbeat(AlertModel):
    version: Annotated[str, StringConstraints(max_length=64)]
    started_at: datetime
    series: Annotated[int, Field(ge=0)]
    live_symbols: Annotated[int, Field(ge=0)]
    polled_series: Annotated[int, Field(ge=0)]
    last_error: Annotated[str, StringConstraints(max_length=1000)] | None = None


# ---------------------------------------------------------------- responses


class Alert(AlertModel):
    id: str
    name: str
    symbol: str
    interval: str
    prepost: bool
    spec: dict[str, Any]
    message: str
    notify: AlertNotify
    expires_at: datetime | None
    status: Status
    status_reason: str | None
    drawing_id: str | None
    revision: int
    fire_count: int
    last_fired_at: datetime | None
    created_at: datetime
    updated_at: datetime


class Delivery(AlertModel):
    channel: Literal["webhook", "telegram", "email"]
    status: Literal["pending", "sent", "failed"]
    attempts: int
    last_error: str | None


class AlertLogEntry(AlertModel):
    id: int
    alert_id: str | None
    alert_name: str
    symbol: str
    interval: str
    fired_at: datetime
    bar_time: int
    message: str
    values: dict[str, Any]
    delayed: bool
    final: bool
    read: bool
    deliveries: list[Delivery]


class LogPage(AlertModel):
    entries: list[AlertLogEntry]
    has_more: bool
    unread: int


class StateOut(AlertModel):
    alert_id: str
    revision: int
    state: dict[str, Any]


class WebhookChannel(AlertModel):
    configured: bool
    url: str | None


class TelegramChannel(AlertModel):
    configured: bool


class EmailChannel(AlertModel):
    configured: bool
    to: str | None


class Channels(AlertModel):
    webhook: WebhookChannel
    telegram: TelegramChannel
    email: EmailChannel


# ------------------------------------------------------------------- bundle


class BundleAlert(AlertFields):
    """`AlertIn` + status, statusReason, fireCount, lastFiredAt (no states, no log)."""

    id: Annotated[str, StringConstraints(min_length=1, max_length=36)]
    status: Status = "active"
    status_reason: Reason | None = None
    fire_count: Annotated[int, Field(ge=0)] = 0
    last_fired_at: datetime | None = None
    revision: int | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


# -------------------------------------------------------------- serializers


def alert_out(row: m.Alert) -> Alert:
    return Alert(
        id=row.id,
        name=row.name,
        symbol=row.symbol,
        interval=row.interval,
        prepost=row.prepost,
        spec=row.spec,
        message=row.message,
        notify=AlertNotify.model_validate(row.notify),
        expires_at=None if row.expires_at is None else utc(row.expires_at),
        status=row.status,  # type: ignore[arg-type]
        status_reason=row.status_reason,
        drawing_id=row.drawing_id,
        revision=row.revision,
        fire_count=row.fire_count,
        last_fired_at=None if row.last_fired_at is None else utc(row.last_fired_at),
        created_at=utc(row.created_at),
        updated_at=utc(row.updated_at),
    )


def log_entry(row: m.AlertLog, deliveries: list[m.AlertDelivery]) -> AlertLogEntry:
    return AlertLogEntry(
        id=row.id,
        alert_id=row.alert_id,
        alert_name=row.alert_name,
        symbol=row.symbol,
        interval=row.interval,
        fired_at=utc(row.fired_at),
        bar_time=row.bar_time,
        message=row.message,
        values=row.values,
        delayed=row.delayed,
        final=row.final,
        read=row.read,
        deliveries=[
            Delivery(
                channel=d.channel,  # type: ignore[arg-type]
                status=d.status,  # type: ignore[arg-type]
                attempts=d.attempts,
                last_error=d.last_error,
            )
            for d in deliveries
        ],
    )
