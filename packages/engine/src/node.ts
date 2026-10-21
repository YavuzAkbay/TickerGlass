/**
 * Node-safe entry (`@tickerglass/engine/node`, docs/alerts.md §3.1): feeds,
 * expression language, intervals, anchor mapping, multi-chart time mapping
 * and the trading calendar.
 * Nothing reachable from here may import chart, render, canvas or DOM code;
 * node.test.ts walks the import graph to keep it that way.
 */
export * from './types';
export * from './feed';
export { logicalToTime, stepTime, stepsBetween, timeToLogical } from './drawings/mapping';
export type { AnchorTimeline } from './drawings/mapping';
export { mapSyncTime } from './sync/time-map';
export type { SyncTimeRef } from './sync/time-map';
export { buildTradingCalendar } from './drawings/calendar';
export type { TradingCalendar } from './drawings/calendar';
export { createTzConverter } from './scale/timezone';
export type { TimeZoneSpec, TzConverter } from './scale/timezone';
export type {
  Drawing,
  DrawingPoint,
  DrawingScope,
  DrawingStyle,
  JsonValue,
} from './drawings/types';
