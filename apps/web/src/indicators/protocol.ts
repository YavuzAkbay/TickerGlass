// Messages between the main thread and the indicator worker (docs/indicators.md §5).
import type { Bar, BarColumns } from '@investopen/engine';
import type { InputValueMap, InstanceSpec, InstanceStatus } from '@investopen/indicators';

export type ToWorker =
  /** Raw timeframe input value -> resolved ('' = chart bars). */
  | { type: 'timeframeMap'; map: Record<string, string> }
  | { type: 'add'; spec: InstanceSpec }
  | { type: 'setInputs'; id: string; inputs: InputValueMap }
  | { type: 'remove'; id: string }
  /** SeriesChange 'reset'/'prepend' and resyncs: all displayed bars (copies, transferred). */
  | { type: 'bars'; revision: number; bars: BarColumns }
  /** SeriesChange 'update' / 'append'. */
  | { type: 'bar'; revision: number; index: number; bar: Bar }
  | { type: 'tfBars'; tf: string; bars: BarColumns }
  | { type: 'tfBar'; tf: string; bar: Bar }
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
