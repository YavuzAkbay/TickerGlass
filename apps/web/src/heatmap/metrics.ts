/**
 * Size and colour metrics of the heatmap (pure): what a tile's area and colour mean, where the value
 * comes from (live quote first, nightly snapshot second), and how it is printed. Text always carries
 * the value so the map never relies on colour alone.
 */
import type { MessageKey } from '../i18n';
import type { LiveQuote } from '../quotes/types';
import { relVolume } from '../screener/model';
import { fmtSigned } from '../sidebar/format';

/** Snapshot-like numbers of one symbol (`GET /screener/snapshot` row or a scan row's `values`). */
export type HeatSnap = Readonly<Record<string, number | string | boolean | null | undefined>>;

/** One symbol on the map. */
export interface HeatSymbol {
  symbol: string;
  /** Company name when known ('' otherwise). */
  name: string;
  /** Group label ('' = none). */
  group: string;
  /** Static market cap / AUM in USD (fallback size), when known. */
  cap: number | null;
  snap: HeatSnap | undefined;
}

export type SizeMetricId = 'marketCap' | 'equal' | 'volume' | 'dollarVolume';
export const SIZE_METRIC_IDS: readonly SizeMetricId[] = [
  'marketCap',
  'equal',
  'volume',
  'dollarVolume',
];
export const SIZE_LABEL: Record<SizeMetricId, MessageKey> = {
  marketCap: 'hm.size.marketCap',
  equal: 'hm.size.equal',
  volume: 'hm.size.volume',
  dollarVolume: 'hm.size.dollarVolume',
};

export type ColorMetricId = 'change1d' | 'perf1w' | 'perf1m' | 'perfYtd' | 'relVol' | 'rsi';
export const COLOR_METRIC_IDS: readonly ColorMetricId[] = [
  'change1d',
  'perf1w',
  'perf1m',
  'perfYtd',
  'relVol',
  'rsi',
];

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const snapNum = (s: HeatSymbol, key: string): number | null => num(s.snap?.[key]);

export interface ColorMetric {
  id: ColorMetricId;
  label: MessageKey;
  /** The value that gets the neutral colour. */
  center: number;
  /** Distance from the centre at which the colour is fully saturated. */
  range: number;
  read: (s: HeatSymbol, q: LiveQuote | undefined) => number | null;
  /** Value as printed on a tile / tooltip. */
  format: (v: number) => string;
  /** Legend tick labels: low end, centre, high end. */
  ticks: readonly [string, string, string];
}

const pct = (v: number): string => fmtSigned(v, 2, '%');
const pctTick = (v: number): string => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v)}%`;

export const COLOR_METRICS: Record<ColorMetricId, ColorMetric> = {
  change1d: {
    id: 'change1d',
    label: 'hm.color.change1d',
    center: 0,
    range: 3,
    read: (s, q) => num(q?.changePercent) ?? snapNum(s, 'chg1d'),
    format: pct,
    ticks: [pctTick(-3), '0%', pctTick(3)],
  },
  perf1w: {
    id: 'perf1w',
    label: 'hm.color.perf1w',
    center: 0,
    range: 5,
    read: (s) => snapNum(s, 'perf1w'),
    format: pct,
    ticks: [pctTick(-5), '0%', pctTick(5)],
  },
  perf1m: {
    id: 'perf1m',
    label: 'hm.color.perf1m',
    center: 0,
    range: 10,
    read: (s) => snapNum(s, 'perf1m'),
    format: pct,
    ticks: [pctTick(-10), '0%', pctTick(10)],
  },
  perfYtd: {
    id: 'perfYtd',
    label: 'hm.color.perfYtd',
    center: 0,
    range: 25,
    read: (s) => snapNum(s, 'perfYtd'),
    format: pct,
    ticks: [pctTick(-25), '0%', pctTick(25)],
  },
  relVol: {
    id: 'relVol',
    label: 'hm.color.relVol',
    center: 1,
    range: 1,
    read: (s, q) => relVolume(q) ?? snapNum(s, 'relVol'),
    format: (v) => `${v.toFixed(2)}×`,
    ticks: ['0×', '1×', '2×'],
  },
  rsi: {
    id: 'rsi',
    label: 'hm.color.rsi',
    center: 50,
    range: 20,
    read: (s) => snapNum(s, 'rsi14'),
    format: (v) => `RSI ${v.toFixed(1)}`,
    ticks: ['30', '50', '70'],
  },
};

export const isSizeMetric = (v: unknown): v is SizeMetricId =>
  typeof v === 'string' && (SIZE_METRIC_IDS as readonly string[]).includes(v);
export const isColorMetric = (v: unknown): v is ColorMetricId =>
  typeof v === 'string' && (COLOR_METRIC_IDS as readonly string[]).includes(v);

/**
 * True when the size follows live quotes (volume, and the market cap a quote carries), so the
 * layout must not chase it tick by tick.
 */
export const isLiveSize = (m: SizeMetricId): boolean =>
  m === 'volume' || m === 'dollarVolume' || m === 'marketCap';

/** A layout moves only when some size changed by more than this fraction. */
export const SIZE_HYSTERESIS = 0.05;

/**
 * Whether `next` differs enough from the sizes the layout was built on to be worth a re-layout:
 * another symbol set, or any size off by more than `tol` (relative to the held one).
 */
export function sizesMoved(
  held: ReadonlyMap<string, number>,
  next: ReadonlyMap<string, number>,
  tol: number = SIZE_HYSTERESIS,
): boolean {
  if (held.size !== next.size) return true;
  for (const [id, v] of next) {
    const h = held.get(id);
    if (h === undefined || Math.abs(v - h) > tol * h) return true;
  }
  return false;
}

/** The raw size of a symbol under `metric` (null: unknown). */
export function sizeValue(
  metric: SizeMetricId,
  s: HeatSymbol,
  q: LiveQuote | undefined,
): number | null {
  const positive = (v: number | null): number | null => (v !== null && v > 0 ? v : null);
  switch (metric) {
    case 'equal':
      return 1;
    case 'marketCap':
      return positive(num(q?.marketCap)) ?? positive(snapNum(s, 'mcap')) ?? positive(s.cap);
    case 'volume':
      return positive(num(q?.volume)) ?? positive(snapNum(s, 'volume'));
    case 'dollarVolume': {
      const avg = positive(snapNum(s, 'avgDollarVol30'));
      if (avg !== null) return avg;
      const v = num(q?.volume);
      const p = num(q?.last);
      return v !== null && p !== null ? positive(v * p) : null;
    }
  }
}

export interface SizeResult {
  /** Positive size per symbol, same order as the input. */
  sizes: number[];
  /** Nothing had a usable size: every tile gets the same one. */
  equalFallback: boolean;
}

/**
 * Sizes for all symbols. Symbols without a value get the smallest known one (visible, never
 * dominant); with no known value at all the map falls back to equal tiles.
 */
export function resolveSizes(
  metric: SizeMetricId,
  symbols: readonly HeatSymbol[],
  quotes: Readonly<Record<string, LiveQuote | undefined>>,
): SizeResult {
  const raw = symbols.map((s) => sizeValue(metric, s, quotes[s.symbol]));
  const known = raw.filter((v): v is number => v !== null);
  if (!known.length) return { sizes: symbols.map(() => 1), equalFallback: metric !== 'equal' };
  const floor = Math.min(...known);
  return { sizes: raw.map((v) => v ?? floor), equalFallback: false };
}

/** Round to three significant digits: tiny changes do not move the layout. */
export function quantize(v: number): number {
  if (!(v > 0)) return 0;
  const p = 10 ** (Math.floor(Math.log10(v)) - 2);
  return Math.round(v / p) * p;
}

/** Subscribe to at most `cap` symbols: the ones with the biggest known size (input order breaks ties). */
export function pickLargest(
  symbols: readonly HeatSymbol[],
  sizeOf: (s: HeatSymbol) => number | null,
  cap: number,
): string[] {
  if (symbols.length <= cap) return symbols.map((s) => s.symbol);
  return symbols
    .map((s, i) => ({ symbol: s.symbol, size: sizeOf(s) ?? -1, i }))
    .sort((a, b) => b.size - a.size || a.i - b.i)
    .slice(0, cap)
    .map((e) => e.symbol);
}

/** Live quote subscriptions of a heatmap are capped to this many tiles (the largest). */
export const HEATMAP_LIVE_CAP = 200;
