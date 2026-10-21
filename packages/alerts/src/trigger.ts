/** Trigger modes (docs/alerts.md §2.2, §2.5). */
import type { SampleKind, TriggerMode } from './types';

/** `ALERTS_MIN_REFIRE_S` default, in ms. */
export const DEFAULT_MIN_REFIRE_MS = 60_000;

/** `ALERTS_CLOSE_GRACE_S` default, in seconds. */
export const DEFAULT_CLOSE_GRACE_S = 60;

/** A fire is `delayed` when it reports an event older than max(this, 1 interval). */
export const DELAYED_MIN_MS = 120_000;

export interface TriggerState {
  lastFiredBarTime: number | null;
  /** ms */
  lastFiredAt: number | null;
}

/** Tick modes see tick and close samples; close mode only close samples (§2.2). */
export function inStream(mode: TriggerMode, kind: SampleKind): boolean {
  return mode !== 'oncePerBarClose' || kind === 'close';
}

/**
 * Whether a sample whose condition is true fires under `mode` (§2.5). `once`
 * always allows; the evaluator stops after its first fire.
 */
export function triggerAllows(
  mode: TriggerMode,
  st: Readonly<TriggerState>,
  sample: { barTime: number; now: number },
  minRefireMs: number,
): boolean {
  switch (mode) {
    case 'once':
    case 'oncePerBarClose':
      return true;
    case 'oncePerBar':
      return st.lastFiredBarTime !== sample.barTime;
    case 'everyTime':
      return st.lastFiredAt === null || sample.now - st.lastFiredAt >= minRefireMs;
  }
}

/** Trigger state after a fire (both fields are recorded for every mode). */
export function afterFire(sample: { barTime: number; now: number }): TriggerState {
  return { lastFiredBarTime: sample.barTime, lastFiredAt: sample.now };
}
