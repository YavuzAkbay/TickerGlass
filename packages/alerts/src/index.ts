/**
 * @investopen/alerts: alert wire types, validation, condition and trigger
 * evaluation, drawing levels, bar close, warm-up and message templates
 * (docs/alerts.md). Pure TS without DOM; imports only `@investopen/engine/node`.
 */
export * from './types';
export {
  conditionKind,
  evaluateCondition,
  isChannelOp,
  isCrossOp,
  isMovingOp,
  isPriceAlert,
  isValid,
  orderBounds,
  priceValue,
  seriesKey,
} from './condition';
export type { ConditionKind } from './condition';
export {
  afterFire,
  DEFAULT_CLOSE_GRACE_S,
  DEFAULT_MIN_REFIRE_MS,
  DELAYED_MIN_MS,
  inStream,
  triggerAllows,
} from './trigger';
export type { TriggerState } from './trigger';
export { createAlertEvaluator } from './evaluator';
export { upgradeAlertSpec } from './legacy';
export type {
  AlertDecision,
  AlertEvaluator,
  AlertEvaluatorOptions,
  ClosedBarValues,
  EvaluatedAlert,
  SeedContext,
} from './evaluator';
export {
  CHANNEL_TOOLS,
  DrawingLevelError,
  drawingChannel,
  drawingLevel,
  isChannelTool,
  LINE_TOOLS,
  supportsPart,
  TOOL_POINTS,
} from './drawing-levels';
export type { DrawingLike } from './drawing-levels';
export { barEnd, closeDeadline, closeEventTime, CloseTracker } from './close';
export type { CloseEvent, CloseSeries, CloseSymbolInfo, CloseTrackerOptions } from './close';
export {
  alertBars,
  DEFAULT_MAX_BARS,
  instanceWarmup,
  MIN_WARMUP_BARS,
  specRefs,
  TIMEFRAME_WARMUP_BARS,
  warmupBars,
  warmupSince,
} from './warmup';
export type { WarmupOptions } from './warmup';
export {
  DEFAULT_TEMPLATE,
  isoSeconds,
  MAX_MESSAGE_LENGTH,
  renderMessage,
  truncateMessage,
} from './template';
export type { MessageContext } from './template';
export {
  buildIndicatorRef,
  defaultAlertName,
  describeCondition,
  OP_LABELS,
  PRICE_FIELD_LABELS,
} from './describe';
export type { ChartInstance, DescribeNames } from './describe';
export {
  ALERT_ID_RE,
  INSTANCE_ID_RE,
  INTERVAL_RE,
  LIMITS,
  RESERVED_ALERT_IDS,
  validateAlert,
  WEBHOOK_URL_RE,
} from './validate';
export type {
  DrawingInfo,
  ValidateOptions,
  ValidationCode,
  ValidationError,
  ValidationResult,
} from './validate';
