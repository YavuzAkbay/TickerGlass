/**
 * Alert wire types (docs/alerts.md §1.2, §1.3, §2.1, §3.5). JSON-serialisable;
 * the API stores `AlertSpec` as is in `alerts.spec`. Change additively only.
 */
import type { InputValueMap } from '@tickerglass/indicators';

export const ALERT_SCHEMA_VERSION = 1;

// ------------------------------------------------------------------ spec

export interface AlertSpec {
  schemaVersion: 1;
  /** The value that moves ("x"). */
  left: SeriesOperand;
  condition: Condition;
  trigger: TriggerMode;
}

/** A value per bar of the alert's series. */
export type SeriesOperand = PriceOperand | IndicatorOperand;

/** Live: `close` is the last price. */
export interface PriceOperand {
  kind: 'price';
  field: PriceField;
}

export interface IndicatorOperand {
  kind: 'indicator';
  ref: IndicatorRef;
}

export type PriceField = 'close' | 'open' | 'high' | 'low' | 'hl2' | 'hlc3' | 'ohlc4';

export const PRICE_FIELDS: readonly PriceField[] = [
  'close',
  'open',
  'high',
  'low',
  'hl2',
  'hlc3',
  'ohlc4',
];

/** One indicator instance of a ref, inputs fully resolved (`resolveInputs`). */
export interface IndicatorRefInstance {
  id: string;
  type: string;
  inputs: InputValueMap;
}

export interface IndicatorRef {
  /** The target instance and all its upstream instances (indicator-on-indicator), any order. */
  instances: IndicatorRefInstance[];
  /** Which instance. */
  instanceId: string;
  /** Which plot (unshifted: plot `offset` is display only). */
  outputId: string;
  /** Legend text at creation, e.g. "RSI 14 close", for descriptions only. */
  title: string;
}

export interface ValueConstant {
  kind: 'value';
  /** Finite. */
  value: number;
}

/** The target ("y"). */
export type ValueOperand = SeriesOperand | ValueConstant | DrawingLineOperand;

export type DrawingPart = 'line' | 'upper' | 'lower' | 'middle';
export type DrawingScaleMode = 'linear' | 'log';

export interface DrawingLineOperand {
  kind: 'drawing';
  drawingId: string;
  /** 'line' for line tools; upper/lower/middle for channels. */
  part: DrawingPart;
  /** The drawing pane's price-scale mode at creation (percent/indexed -> linear). */
  scale: DrawingScaleMode;
}

export interface ChannelBounds {
  kind: 'bounds';
  upper: ValueOperand;
  lower: ValueOperand;
}

/** Parallel channel or rectangle as a whole. */
export interface ChannelDrawing {
  kind: 'drawing';
  drawingId: string;
  scale: DrawingScaleMode;
}

export type ChannelOperand = ChannelBounds | ChannelDrawing;

export type CrossOp = 'crossing' | 'crossingUp' | 'crossingDown' | 'greater' | 'less';
export type ChannelOp = 'enteringChannel' | 'exitingChannel' | 'insideChannel' | 'outsideChannel';
export type MovingOp = 'movingUp' | 'movingDown' | 'movingUpPercent' | 'movingDownPercent';
export type ConditionOp = CrossOp | ChannelOp | MovingOp;

export interface CrossCondition {
  op: CrossOp;
  right: ValueOperand;
}

export interface ChannelCondition {
  op: ChannelOp;
  channel: ChannelOperand;
}

export interface MovingCondition {
  op: MovingOp;
  amount: number;
  bars: number;
}

export type Condition = CrossCondition | ChannelCondition | MovingCondition;

export const CROSS_OPS: readonly CrossOp[] = [
  'crossing',
  'crossingUp',
  'crossingDown',
  'greater',
  'less',
];
export const CHANNEL_OPS: readonly ChannelOp[] = [
  'enteringChannel',
  'exitingChannel',
  'insideChannel',
  'outsideChannel',
];
export const MOVING_OPS: readonly MovingOp[] = [
  'movingUp',
  'movingDown',
  'movingUpPercent',
  'movingDownPercent',
];

export type TriggerMode = 'once' | 'oncePerBar' | 'oncePerBarClose' | 'everyTime';

export const TRIGGER_MODES: readonly TriggerMode[] = [
  'once',
  'oncePerBar',
  'oncePerBarClose',
  'everyTime',
];

export interface AlertNotify {
  /** In-app toast in open tabs (default true). */
  toast: boolean;
  /** Default true. */
  sound: boolean;
  /** Notification API in hidden tabs (default false; needs permission). */
  browser: boolean;
  webhook: boolean;
  /** null = ALERTS_WEBHOOK_URL. */
  webhookUrl: string | null;
  /** Body = rendered message instead of the JSON envelope. */
  webhookRaw: boolean;
  telegram: boolean;
  email: boolean;
}

export const DEFAULT_NOTIFY: Readonly<AlertNotify> = {
  toast: true,
  sound: true,
  browser: false,
  webhook: false,
  webhookUrl: null,
  webhookRaw: false,
  telegram: false,
  email: false,
};

// ------------------------------------------------------------------ wire

export type AlertStatus = 'active' | 'paused' | 'triggered' | 'expired' | 'error';

export interface AlertIn {
  /** Client-chosen UUID v4 (keeps identity if the POST is retried). */
  id?: string;
  /** 1..200 chars; the client sends describeCondition(...) when the user leaves it empty. */
  name: string;
  symbol: string;
  interval: string;
  prepost: boolean;
  spec: AlertSpec;
  /** Template (§4.3); '' = default template. */
  message: string;
  notify: AlertNotify;
  expiresAt: string | null;
  /** Create/PUT only these; default 'active'. */
  status?: 'active' | 'paused';
}

export interface Alert extends Required<Omit<AlertIn, 'status'>> {
  status: AlertStatus;
  statusReason: string | null;
  drawingId: string | null;
  revision: number;
  fireCount: number;
  lastFiredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type DeliveryChannel = 'webhook' | 'telegram' | 'email';

export interface AlertDelivery {
  channel: DeliveryChannel;
  status: 'pending' | 'sent' | 'failed';
  attempts: number;
  lastError: string | null;
}

export interface AlertLogEntry {
  id: number;
  alertId: string | null;
  alertName: string;
  symbol: string;
  interval: string;
  firedAt: string;
  /** Unix s, open time of the bar the sample belongs to. */
  barTime: number;
  /** Rendered. */
  message: string;
  values: SampleValues;
  /** Fired more than max(120 s, 1 interval) after the bar event it reports (catch-up). */
  delayed: boolean;
  /** This fire ended the alert (once). */
  final: boolean;
  read: boolean;
  deliveries: AlertDelivery[];
}

/** `POST /alerts/{id}/fire` body (§1.5). */
export interface FireIn {
  fireId: string;
  revision: number;
  firedAt: string;
  barTime: number;
  final: boolean;
  delayed: boolean;
  message: string;
  values: SampleValues;
  state?: AlertRuntimeState;
}

/** `POST /alerts/service/heartbeat` body (§1.4). */
export interface ServiceHeartbeat {
  version: string;
  startedAt: string;
  series: number;
  liveSymbols: number;
  polledSeries: number;
  lastError: string | null;
}

// ---------------------------------------------------------------- samples

/**
 * Operand values of one sample. Non-finite = invalid (NaN after a JSON round
 * trip arrives as null; the evaluator treats anything non-finite as invalid).
 */
export interface SampleValues {
  /** Left operand at bar i. */
  x: number;
  /** Right operand (crossing/greater/less). */
  y?: number;
  upper?: number;
  /** Channel, already ordered: lower <= upper when both finite. */
  lower?: number;
  /** moving*: left operand at the close of bar i - N. */
  ref?: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Bar i as of this sample. */
  volume: number;
}

export type SampleKind = 'tick' | 'close';

export interface Sample {
  /** A live/poll update of the forming bar, or the final values of a closed bar. */
  kind: SampleKind;
  barIndex: number;
  /** Open time of bar i, unix s. */
  barTime: number;
  /** Service wall clock, ms. */
  now: number;
  values: SampleValues;
  /**
   * When the event the sample reports happened (ms): the close event for a
   * close sample (§2.4). Defaults to `now`. Used for the close-mode activation
   * rule and for `delayed`. Additive to §2.1.
   */
  eventAt?: number;
}

// ----------------------------------------------------------------- state

export interface AlertPrevSample {
  barTime: number;
  kind: SampleKind;
  values: SampleValues;
}

/** Service-owned runtime state (`alert_states.state`, §3.5). */
export interface AlertRuntimeState {
  v: 1;
  seriesKey: string;
  prev: AlertPrevSample | null;
  lastFiredBarTime: number | null;
  /** ms */
  lastFiredAt: number | null;
  lastClosedBarTime: number | null;
  /**
   * Fires accepted by the service but not yet acknowledged by `POST /fire`
   * (resent on startup; `fireId` makes that idempotent). Optional: older blobs lack it.
   */
  pendingFires?: { revision: number; body: FireIn }[];
}
