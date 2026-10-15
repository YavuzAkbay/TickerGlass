// Messages between the main thread and the indicator worker (docs/indicators.md §5).
import type { Bar, BarColumns } from '@investopen/engine';
import type {
  InputValueMap,
  InstanceSpec,
  InstanceStatus,
  RuntimeContext,
} from '@investopen/indicators';

export type ToWorker =
  /** Raw timeframe input value -> resolved ('' = chart bars). */
  | { type: 'timeframeMap'; map: Record<string, string> }
  /** Exchange timezone/session and bar intervals (symbol/interval change); recomputes as needed. */
  | { type: 'context'; context: RuntimeContext }
  | { type: 'add'; spec: InstanceSpec }
  | { type: 'setInputs'; id: string; inputs: InputValueMap }
  | { type: 'remove'; id: string }
  /**
   * SeriesChange 'reset'/'prepend' and resyncs: all displayed bars (copies,
   * transferred). `context`: the new symbol/interval's context, applied
   * together with the bars so the worker computes once (not on the old bars first).
   */
  | { type: 'bars'; revision: number; bars: BarColumns; context?: RuntimeContext }
  /** SeriesChange 'update' / 'append'. */
  | { type: 'bar'; revision: number; index: number; bar: Bar }
  | { type: 'tfBars'; tf: string; bars: BarColumns }
  | { type: 'tfBar'; tf: string; bar: Bar }
  /**
   * An external symbol's bars aligned to the displayed bars of series
   * `revision` (time = the displayed times; prices NaN where it has no bar).
   */
  | { type: 'extBars'; revision: number; symbol: string; bars: BarColumns }
  /** Aligned rows [from, from + bars length) of an external symbol (live). */
  | { type: 'extUpdate'; revision: number; symbol: string; from: number; bars: BarColumns }
  /** Symbol change: drop all bar data, keep instances. */
  | { type: 'clear' };

export interface ResultChange {
  id: string;
  from: number;
  status: InstanceStatus;
  /** Slices [from, length). */
  values: Record<string, Float64Array>;
  colors: Record<string, Uint8Array>;
}

export type FromWorker =
  | { type: 'results'; revision: number; length: number; changes: ResultChange[] }
  /** Timeframe series the runtime needs (after add/setInputs/timeframeMap). */
  | { type: 'timeframes'; timeframes: string[] }
  /** External symbols the runtime needs (after add/setInputs/remove). */
  | { type: 'symbols'; symbols: string[] }
  /**
   * A `bar` index did not fit the worker's series (RangeError from
   * `updateBar`): the host resends all bars. `bars` = number of `bars`
   * messages the worker had handled, so the host can skip resyncs that a
   * resend already in flight answers.
   */
  | { type: 'resync'; revision: number; bars: number }
  /**
   * With `id`: thrown by add/setInputs for that instance (the instance shows
   * the error). Without `id`: fatal (a handler threw unexpectedly or the
   * worker failed to load); the host reports it once and stops resyncing.
   */
  | { type: 'error'; id?: string; message: string };
