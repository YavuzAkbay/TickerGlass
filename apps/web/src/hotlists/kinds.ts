/**
 * Hotlists: pure helpers (kinds, metric formatting, universe choices, live overlay).
 * The ranking itself comes from `GET /api/screener/hotlists`; docs/screener.md.
 */
import type { MessageKey } from '../i18n';
import type { LiveQuote } from '../quotes/types';
import type { ListInfo } from '../screener/server/types';
import { fmtCap, fmtInt, fmtMultiple, fmtSigned, isNum } from '../sidebar/format';

export const HOTLIST_KINDS = [
  'gainers',
  'losers',
  'active',
  'unusualVolume',
  'newHighs',
  'newLows',
  'oversold',
  'overbought',
  'gapUp',
  'gapDown',
  'goldenCross',
] as const;
export type HotlistKind = (typeof HOTLIST_KINDS)[number];

export const isHotlistKind = (v: unknown): v is HotlistKind =>
  typeof v === 'string' && (HOTLIST_KINDS as readonly string[]).includes(v);

export const DEFAULT_KIND: HotlistKind = 'gainers';

/** Rows asked for, and the most that get live quote subscriptions. */
export const HOTLIST_LIMIT = 25;
export const LIVE_ROWS = 25;

export interface HotlistRow {
  symbol: string;
  name: string;
  /** The kind's ranking metric (see `formatMetric`); null when the snapshot lacks it. */
  value: number | null;
  last: number | null;
  chg1d: number | null;
}

export interface HotlistResponse {
  kind: HotlistKind;
  /** Session date of the snapshot the ranking comes from; null before the first run. */
  asOf: string | null;
  universe: string;
  rows: HotlistRow[];
}

type MetricFormat = 'pct' | 'multiple' | 'rsi' | 'money' | 'days';

interface KindMeta {
  label: MessageKey;
  /** Header of the metric column. */
  metric: MessageKey;
  format: MetricFormat;
}

export const KIND_META: Record<HotlistKind, KindMeta> = {
  gainers: { label: 'hl.kind.gainers', metric: 'hl.metric.chg', format: 'pct' },
  losers: { label: 'hl.kind.losers', metric: 'hl.metric.chg', format: 'pct' },
  active: { label: 'hl.kind.active', metric: 'hl.metric.dollarVol', format: 'money' },
  unusualVolume: { label: 'hl.kind.unusualVolume', metric: 'hl.metric.relVol', format: 'multiple' },
  newHighs: { label: 'hl.kind.newHighs', metric: 'hl.metric.offHigh', format: 'pct' },
  newLows: { label: 'hl.kind.newLows', metric: 'hl.metric.offLow', format: 'pct' },
  oversold: { label: 'hl.kind.oversold', metric: 'hl.metric.rsi', format: 'rsi' },
  overbought: { label: 'hl.kind.overbought', metric: 'hl.metric.rsi', format: 'rsi' },
  gapUp: { label: 'hl.kind.gapUp', metric: 'hl.metric.gap', format: 'pct' },
  gapDown: { label: 'hl.kind.gapDown', metric: 'hl.metric.gap', format: 'pct' },
  goldenCross: { label: 'hl.kind.goldenCross', metric: 'hl.metric.daysAgo', format: 'days' },
};

const DASH = '—';

/** The metric of a row as text: `+3.00%`, `3.20x`, `27`, `$9.0B`, `2d`. */
export function formatMetric(kind: HotlistKind, value: number | null | undefined): string {
  if (!isNum(value)) return DASH;
  switch (KIND_META[kind].format) {
    case 'pct':
      return fmtSigned(value, 2, '%');
    case 'multiple':
      return fmtMultiple(value);
    case 'rsi':
      return fmtInt(value);
    case 'money':
      return fmtCap(value);
    case 'days':
      return `${fmtInt(value)}d`;
  }
}

// ----------------------------------------------------------------- universes

export interface UniverseOption {
  /** `stocks` | `etfs` | `crypto` | `commodities` | `list:<id>` (the API's `universe`). */
  id: string;
  /** Catalog key for the built-in classes; null for lists (their own name is used). */
  key: MessageKey | null;
  name: string;
}

const CLASS_OPTIONS: [string, MessageKey][] = [
  ['stocks', 'hl.uni.stocks'],
  ['etfs', 'hl.uni.etfs'],
  ['crypto', 'hl.uni.crypto'],
  ['commodities', 'hl.uni.commodities'],
];

/** Index lists first (S&P 500, Nasdaq-100, then other lists), then the asset classes. */
export function universeOptions(lists: readonly ListInfo[]): UniverseOption[] {
  const rank = (l: ListInfo) => (l.id === 'sp500' ? 0 : l.id === 'ndx100' ? 1 : 2);
  const sorted = [...lists].sort((a, b) => rank(a) - rank(b));
  return [
    ...sorted.map((l) => ({ id: `list:${l.id}`, key: null, name: l.name })),
    ...CLASS_OPTIONS.map(([id, key]) => ({ id, key, name: id })),
  ];
}

/** S&P 500 when the server has that list, else the stocks class. */
export function defaultUniverse(options: readonly UniverseOption[]): string {
  return options.some((o) => o.id === 'list:sp500') ? 'list:sp500' : 'stocks';
}

/** The saved choice when it is still offered, else the default. */
export function resolveUniverse(saved: string | null, options: readonly UniverseOption[]): string {
  return saved !== null && options.some((o) => o.id === saved) ? saved : defaultUniverse(options);
}

// ----------------------------------------------------------------- requests

export function hotlistPath(kind: HotlistKind, universe: string, limit = HOTLIST_LIMIT): string {
  const q = new URLSearchParams({ kind, universe, limit: String(limit) });
  return `/screener/hotlists?${q.toString()}`;
}

// -------------------------------------------------------------- live overlay

/** Symbols that get live quotes: the first `LIVE_ROWS` rows. */
export const liveSymbols = (rows: readonly HotlistRow[], max = LIVE_ROWS): string[] =>
  rows.slice(0, max).map((r) => r.symbol);

/** Live last price when the quote has one, else the snapshot's close. */
export function liveLast(row: HotlistRow, q: LiveQuote | undefined): number | null {
  return isNum(q?.last) ? q.last : row.last;
}

/** Live day change in percent when known, else the snapshot's last-close change. */
export function liveChange(row: HotlistRow, q: LiveQuote | undefined): number | null {
  return isNum(q?.changePercent) ? q.changePercent : row.chg1d;
}
