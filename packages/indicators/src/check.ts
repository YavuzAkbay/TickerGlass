/**
 * "Check" of a user script (docs/indicators.md §5a): the live computation (a
 * full compute on n−K bars, then K ticks through `updateBar`) must equal one
 * full compute on all n bars. A script that keeps state outside `ta` fails it.
 * Shared by the web sandbox and the alerts service's script host.
 */
import { IndicatorRuntime } from './runtime';
import type { IndicatorRegistry } from './registry';
import type { RuntimeContext } from './runtime';
import type { BarArrays, BarInput, IndicatorResult, InputValueMap } from './types';

/** Live bars a check feeds as ticks when the request names no valid count. */
export const DEFAULT_CHECK_LIVE_BARS = 50;

const CHECK_ID = 'check';

/** First output value where the live computation differs from the full one. */
export interface CheckMismatch {
  outputId: string;
  index: number;
  full: number;
  live: number;
}

export type CheckOutcome =
  | { ok: true }
  | { ok: false; mismatch: CheckMismatch }
  /** A computation errored (`what`: which of the two runs). */
  | { ok: false; error: string };

export interface CheckOptions {
  /** Registry holding the script's definition (`type`). */
  registry: IndicatorRegistry;
  /** Definition id of the script (`user:<id>`). */
  type: string;
  bars: BarArrays;
  context: RuntimeContext;
  inputs: InputValueMap;
  liveBars?: number;
}

/** |a−b| <= 1e-9·max(1,|b|); NaN equals NaN. */
export function sameValue(a: number, b: number): boolean {
  if (a === b) return true;
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.isNaN(a) && Number.isNaN(b);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false; // unequal infinities
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));
}

/** Earliest bar index at which any output (value or palette index) of `live` differs from `full`. */
export function firstMismatch(
  full: IndicatorResult,
  live: IndicatorResult,
  n: number,
): CheckMismatch | null {
  const columns: [string, ArrayLike<number>, ArrayLike<number> | undefined][] = [
    ...Object.entries(full.values).map(
      ([id, arr]) =>
        [id, arr, live.values[id]] as [string, ArrayLike<number>, ArrayLike<number> | undefined],
    ),
    ...Object.entries(full.colors).map(
      ([id, arr]) =>
        [id, arr, live.colors[id]] as [string, ArrayLike<number>, ArrayLike<number> | undefined],
    ),
  ];
  const at = (arr: ArrayLike<number> | undefined, i: number) =>
    arr && i < arr.length ? arr[i]! : NaN;
  for (let i = 0; i < n; i++) {
    for (const [outputId, f, l] of columns) {
      const x = at(f, i);
      const y = at(l, i);
      if (!sameValue(y, x)) return { outputId, index: i, full: x, live: y };
    }
  }
  return null;
}

export function barAt(cols: BarArrays, i: number): BarInput {
  return {
    time: cols.time[i]!,
    open: cols.open[i]!,
    high: cols.high[i]!,
    low: cols.low[i]!,
    close: cols.close[i]!,
    volume: cols.volume[i]!,
  };
}

/** The opening tick of a live bar: every price at the open, a tenth of the volume. */
function firstTick(bar: BarInput): BarInput {
  const o = bar.open;
  return { ...bar, high: o, low: o, close: o, volume: bar.volume * 0.1 };
}

function head(a: ArrayLike<number>, to: number): ArrayLike<number> {
  const arr = a as { subarray?: (b: number, e: number) => ArrayLike<number> };
  return typeof arr.subarray === 'function' ? arr.subarray(0, to) : Array.from(a).slice(0, to);
}

function sliceColumns(cols: BarArrays, to: number): BarArrays {
  return {
    time: head(cols.time, to),
    open: head(cols.open, to),
    high: head(cols.high, to),
    low: head(cols.low, to),
    close: head(cols.close, to),
    volume: head(cols.volume, to),
  };
}

/**
 * Full compute on all bars vs compute on n−K bars, then the last K bars via
 * `updateBar` (each appended as a perturbed tick, then set to its final
 * value). The first differing output value (by bar index) is the mismatch.
 * Never throws for script errors (they come back as `{ok:false, error}`).
 */
export function checkScript(opts: CheckOptions): CheckOutcome {
  const { bars, context, inputs, type } = opts;
  const n = bars.time.length;
  const live_ = opts.liveBars;
  const k = Math.min(
    n,
    live_ !== undefined && Number.isInteger(live_) && live_ > 0 ? live_ : DEFAULT_CHECK_LIVE_BARS,
  );
  const runtime = () => {
    const rt = new IndicatorRuntime({ registry: opts.registry, context });
    rt.add({ id: CHECK_ID, type, inputs });
    return rt;
  };

  const full = runtime();
  full.setBars(bars);
  const live = runtime();
  live.setBars(sliceColumns(bars, n - k));
  for (let i = n - k; i < n; i++) {
    const bar = barAt(bars, i);
    live.updateBar(i, firstTick(bar));
    live.updateBar(i, bar);
  }

  const a = full.result(CHECK_ID);
  const b = live.result(CHECK_ID);
  if (!a || !b) throw new Error('check instance missing');
  for (const [r, what] of [
    [a, 'full'],
    [b, 'live'],
  ] as const) {
    if (r.status.state === 'error')
      return { ok: false, error: `Check (${what}): ${r.status.message}` };
  }
  const mismatch = firstMismatch(a, b, n);
  return mismatch ? { ok: false, mismatch } : { ok: true };
}
