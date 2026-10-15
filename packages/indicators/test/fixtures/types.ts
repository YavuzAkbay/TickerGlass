import type { RuntimeContext } from '../../src/runtime';
import type { BarArrays, InputValueMap } from '../../src/types';

/**
 * Per-indicator overrides for incremental.test.ts. Defaults: 400 random 15m
 * bars (`randomBars(400, 7, 1_700_000_000, 900)`), no runtime context, inputs
 * at their defaults (timeframe inputs forced to ''), live feed from bar 150,
 * and some output must be non-NaN at the last bar.
 */
export interface IncrementalFixture {
  /** Bars to run on instead of the default series (e.g. daily bars for Seasonality). */
  bars?: BarArrays;
  /** Runtime context for these bars (e.g. `{ intervalSeconds: 86_400 }`). */
  context?: RuntimeContext;
  /** Input overrides (merged over the defaults and the forced timeframe ''). */
  inputs?: InputValueMap;
  /** First bar fed live (default 150; the indicator-on-indicator check uses it too with custom bars). */
  liveFrom?: number;
  /**
   * Outputs are legitimately NaN at the last bar (fractals, pivots, period
   * marks): assert some non-NaN value anywhere instead.
   */
  sparse?: boolean;
  /** Chart-aligned bars of external symbols, by symbol (same length as `bars`). */
  external?: Readonly<Record<string, BarArrays>>;
  /** Nothing is expected to be non-NaN at all (e.g. Visible Range profile: engine-side only). */
  noValues?: boolean;
}

export type GroupFixtures = Readonly<Record<string, IncrementalFixture>>;
