/**
 * Per-alert evaluator (docs/alerts.md §2.2-§2.5, §3.5): owns the previous
 * sample and the trigger bookkeeping of one alert revision. The service
 * computes the operand values; this decides whether a sample fires.
 */
import { intervalSeconds, parseInterval } from '@tickerglass/engine/node';
import { evaluateCondition, seriesKey } from './condition';
import {
  afterFire,
  DEFAULT_MIN_REFIRE_MS,
  DELAYED_MIN_MS,
  inStream,
  triggerAllows,
} from './trigger';
import type {
  Alert,
  AlertPrevSample,
  AlertRuntimeState,
  Sample,
  SampleKind,
  SampleValues,
} from './types';

/** What the evaluator needs from an alert (an `Alert` fits). */
export type EvaluatedAlert = Pick<Alert, 'symbol' | 'interval' | 'prepost' | 'spec' | 'expiresAt'> &
  Partial<Pick<Alert, 'updatedAt'>>;

export interface AlertEvaluatorOptions {
  /** `ALERTS_MIN_REFIRE_S * 1000` (default 60 s). */
  minRefireMs?: number;
}

export interface ClosedBarValues {
  barIndex: number;
  barTime: number;
  /** Final values of the closed bar. */
  values: SampleValues;
  /** Close event time (§2.4), ms. */
  closedAt: number;
}

/** Series facts at activation (§2.2). */
export interface SeedContext {
  /** Service wall clock, ms. */
  now: number;
  /** Tick modes: open time of bar n-1 (forming or newest), null without bars. */
  lastBarTime: number | null;
  /** Tick modes: open time of bar n-2, null if absent. */
  previousBarTime: number | null;
  /** Close mode: the newest closed bar from history (null if none). */
  lastClosed?: ClosedBarValues | null;
  /** Close mode: the closed bar before `lastClosed` (the `p` of a catch-up evaluation). */
  beforeLastClosed?: Omit<ClosedBarValues, 'closedAt'> | null;
}

export interface AlertDecision {
  fire: true;
  /** Trigger `once`: the alert becomes `triggered`. */
  final: boolean;
  /** The reported event is older than max(120 s, 1 interval) (catch-up). */
  delayed: boolean;
  values: SampleValues;
  kind: SampleKind;
  barTime: number;
  /** = sample.now, ms. */
  firedAt: number;
}

export interface AlertEvaluator {
  /** Series key of the alert (`symbol|interval|prepost`). */
  readonly seriesKey: string;
  /**
   * Activation. `state` is the persisted state of the **same** alert revision
   * (the caller checks the revision) or null. In close mode this may evaluate
   * the newest closed bar once (catch-up) and return its fire.
   */
  seed(state: AlertRuntimeState | null, ctx: SeedContext): AlertDecision | null;
  /** One sample of the series; returns a fire or null. */
  onSample(sample: Sample): AlertDecision | null;
  /** Expiry (§2.5): samples at or after `expiresAt` are not evaluated. */
  isExpired(now: number): boolean;
  /** A `once` alert has fired; nothing is evaluated any more. */
  readonly done: boolean;
  /** Snapshot for persistence. */
  state(): AlertRuntimeState;
}

function toNum(v: unknown): number {
  return typeof v === 'number' ? v : NaN;
}

function toOptNum(v: unknown): number | undefined {
  return v === undefined ? undefined : toNum(v);
}

/** Copy values, mapping JSON nulls (serialised NaN) back to NaN. */
function cloneValues(v: SampleValues): SampleValues {
  const out: SampleValues = {
    x: toNum(v.x),
    open: toNum(v.open),
    high: toNum(v.high),
    low: toNum(v.low),
    close: toNum(v.close),
    volume: toNum(v.volume),
  };
  const y = toOptNum(v.y);
  const upper = toOptNum(v.upper);
  const lower = toOptNum(v.lower);
  const ref = toOptNum(v.ref);
  if (y !== undefined) out.y = y;
  if (upper !== undefined) out.upper = upper;
  if (lower !== undefined) out.lower = lower;
  if (ref !== undefined) out.ref = ref;
  return out;
}

function timeOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** ISO string -> ms; null for null; throws on an unparsable string. */
function isoMs(s: string | null | undefined, what: string): number | null {
  if (s === null || s === undefined) return null;
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) throw new Error(`invalid ${what}: ${JSON.stringify(s)}`);
  return ms;
}

export function createAlertEvaluator(
  alert: EvaluatedAlert,
  opts: AlertEvaluatorOptions = {},
): AlertEvaluator {
  const minRefireMs = opts.minRefireMs ?? DEFAULT_MIN_REFIRE_MS;
  const spec = alert.spec;
  const mode = spec.trigger;
  const key = seriesKey(alert.symbol, alert.interval, alert.prepost);
  const expiresMs = isoMs(alert.expiresAt, 'expiresAt');
  const updatedMs = isoMs(alert.updatedAt, 'updatedAt') ?? -Infinity;
  const delayMs = Math.max(DELAYED_MIN_MS, intervalSeconds(parseInterval(alert.interval)) * 1000);

  let prev: AlertPrevSample | null = null;
  let lastFiredBarTime: number | null = null;
  let lastFiredAt: number | null = null;
  let lastClosedBarTime: number | null = null;
  /** Newest bar time seen in this alert's stream (out-of-order guard). */
  let newestBarTime = -Infinity;
  let done = false;

  const isExpired = (now: number) => expiresMs !== null && now >= expiresMs;

  function onSample(sample: Sample): AlertDecision | null {
    if (done || isExpired(sample.now)) return null;
    if (!inStream(mode, sample.kind)) return null;
    // Out-of-order poll result, or a second close of a bar (§2.4, §2.5).
    if (sample.barTime < newestBarTime) return null;
    if (
      sample.kind === 'close' &&
      lastClosedBarTime !== null &&
      sample.barTime <= lastClosedBarTime
    )
      return null;
    const eventAt = sample.eventAt ?? sample.now;
    const values = cloneValues(sample.values);
    const p = prev;
    prev = { barTime: sample.barTime, kind: sample.kind, values };
    newestBarTime = sample.barTime;
    if (sample.kind === 'close') lastClosedBarTime = sample.barTime;
    // Close mode evaluates only bars that close after activation (§2.2).
    if (mode === 'oncePerBarClose' && !(eventAt > updatedMs)) return null;
    if (!evaluateCondition(spec.condition, p ? p.values : null, values)) return null;
    const st = { lastFiredBarTime, lastFiredAt };
    if (!triggerAllows(mode, st, sample, minRefireMs)) return null;
    const after = afterFire(sample);
    lastFiredBarTime = after.lastFiredBarTime;
    lastFiredAt = after.lastFiredAt;
    const final = mode === 'once';
    if (final) done = true;
    return {
      fire: true,
      final,
      delayed: sample.now - eventAt > delayMs,
      values,
      kind: sample.kind,
      barTime: sample.barTime,
      firedAt: sample.now,
    };
  }

  function seed(state: AlertRuntimeState | null, ctx: SeedContext): AlertDecision | null {
    const st = state && state.v === 1 && state.seriesKey === key ? state : null;
    prev = null;
    newestBarTime = -Infinity;
    // `done` survives a re-seed (history reload): a fired `once` alert never fires again.
    lastFiredBarTime = timeOrNull(st?.lastFiredBarTime);
    lastFiredAt = timeOrNull(st?.lastFiredAt);
    lastClosedBarTime = timeOrNull(st?.lastClosedBarTime);

    if (mode !== 'oncePerBarClose') {
      const sp = st?.prev;
      const t = sp ? timeOrNull(sp.barTime) : null;
      if (
        sp &&
        t !== null &&
        (t === ctx.lastBarTime || t === ctx.previousBarTime) &&
        (sp.kind === 'tick' || sp.kind === 'close')
      ) {
        prev = { barTime: t, kind: sp.kind, values: cloneValues(sp.values) };
        newestBarTime = t;
      }
      return null;
    }

    const last = ctx.lastClosed ?? null;
    if (!last) return null;
    const seen = lastClosedBarTime;
    const missed = (seen === null || seen < last.barTime) && last.closedAt > updatedMs;
    if (!missed) {
      // p = the close of the last closed bar, computed from history.
      prev = { barTime: last.barTime, kind: 'close', values: cloneValues(last.values) };
      newestBarTime = last.barTime;
      lastClosedBarTime = seen === null ? last.barTime : Math.max(seen, last.barTime);
      return null;
    }
    // Catch-up: the newest closed bar alone, once; earlier missed bars are skipped.
    const before = ctx.beforeLastClosed ?? null;
    if (before && before.barTime < last.barTime) {
      prev = { barTime: before.barTime, kind: 'close', values: cloneValues(before.values) };
      newestBarTime = before.barTime;
    }
    lastClosedBarTime = null;
    return onSample({
      kind: 'close',
      barIndex: last.barIndex,
      barTime: last.barTime,
      now: ctx.now,
      values: last.values,
      eventAt: last.closedAt,
    });
  }

  return {
    seriesKey: key,
    seed,
    onSample,
    isExpired,
    get done() {
      return done;
    },
    state(): AlertRuntimeState {
      return {
        v: 1,
        seriesKey: key,
        prev: prev ? { barTime: prev.barTime, kind: prev.kind, values: { ...prev.values } } : null,
        lastFiredBarTime,
        lastFiredAt,
        lastClosedBarTime,
      };
    },
  };
}
