// App-side compare overlay model: persisted overlay state and its validation.
// Pure (no DOM, no stores). The shape is persisted in layouts (schema v3):
// change it only with a layout upgrade step (persist/layoutState.ts).
import { canonicalSymbol, type PriceScaleMode } from '@tickerglass/engine';
import { isObj } from '../persist/net';

/** Same % scale as the main series | new (implicit) price scale | new pane. */
export type ComparePlacement = 'same' | 'own' | 'pane';

export interface CompareState {
  /** /^cmp-[a-z0-9]{1,24}$/; also the engine study id. */
  id: string;
  /** Canonical symbol or expression (canonicalSymbol), at most MAX_COMPARE_SYMBOL chars. */
  symbol: string;
  placement: ComparePlacement;
  visible: boolean;
  /** #rrggbb */
  color: string;
  /** Integer 1..4. */
  lineWidth: number;
}

export interface CompareLayout {
  items: CompareState[];
  /**
   * Main pane scale mode from before the first 'same' overlay switched it to
   * percent; restored when the last 'same' overlay goes (if still percent).
   */
  scaleRestore: PriceScaleMode | null;
}

export const MAX_COMPARES = 10;
export const MAX_COMPARE_SYMBOL = 128;
export const DEFAULT_COMPARE_LINE_WIDTH = 2;
export const COMPARE_COLORS = [
  '#E0A93B',
  '#e8618c',
  '#0fb5c9',
  '#8e5cf6',
  '#8bc34a',
  '#6E9BD6',
  '#DE6A4F',
  '#7a8a99',
];

export const PLACEMENTS: readonly ComparePlacement[] = ['same', 'own', 'pane'];
const SCALE_MODES: readonly PriceScaleMode[] = ['linear', 'log', 'percent', 'indexed'];

const ID_RE = /^cmp-[a-z0-9]{1,24}$/;
const COLOR_RE = /^#[0-9a-f]{6}$/i;

let seq = 0;

export function newCompareId(): string {
  return `cmp-${Date.now().toString(36)}${(seq++).toString(36)}`;
}

export const isCompareId = (id: string) => id.startsWith('cmp-');

/** Engine pane of a 'pane' overlay. */
export const comparePaneId = (id: string) => `pane-${id}`;

export const isCompareColor = (v: unknown): v is string =>
  typeof v === 'string' && COLOR_RE.test(v);

export const isCompareLineWidth = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 4;

/**
 * Canonical overlay symbol of user input (plain symbol or expression), or the
 * reason it cannot be one.
 */
export function compareSymbol(
  raw: string,
): { ok: true; symbol: string } | { ok: false; message: string } {
  let symbol: string;
  try {
    symbol = canonicalSymbol(raw.trim());
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
  if (symbol.length > MAX_COMPARE_SYMBOL)
    return { ok: false, message: `Too long (max ${MAX_COMPARE_SYMBOL} characters)` };
  return { ok: true, symbol };
}

/** First palette colour no overlay uses (cycling when all are taken). */
export function nextCompareColor(items: readonly CompareState[]): string {
  const used = new Set(items.map((i) => i.color.toLowerCase()));
  return (
    COMPARE_COLORS.find((c) => !used.has(c.toLowerCase())) ??
    COMPARE_COLORS[items.length % COMPARE_COLORS.length]!
  );
}

function parseItem(v: unknown): CompareState | null {
  if (!isObj(v)) return null;
  const { id, symbol, placement, visible, color, lineWidth } = v;
  if (typeof id !== 'string' || !ID_RE.test(id)) return null;
  if (typeof symbol !== 'string') return null;
  const sym = compareSymbol(symbol);
  if (!sym.ok) return null;
  if (!PLACEMENTS.includes(placement as ComparePlacement)) return null;
  if (!isCompareColor(color) || !isCompareLineWidth(lineWidth)) return null;
  return {
    id,
    symbol: sym.symbol,
    placement: placement as ComparePlacement,
    visible: visible !== false,
    color,
    lineWidth,
  };
}

/**
 * Read a stored compare layout: invalid items (and duplicate ids, and items
 * beyond MAX_COMPARES) are dropped, symbols re-canonicalized.
 */
export function parseCompareLayout(raw: unknown): CompareLayout {
  const src = isObj(raw) ? raw : {};
  const items: CompareState[] = [];
  const ids = new Set<string>();
  for (const v of Array.isArray(src.items) ? src.items : []) {
    const item = parseItem(v);
    if (!item || ids.has(item.id) || items.length >= MAX_COMPARES) continue;
    ids.add(item.id);
    items.push(item);
  }
  const scaleRestore = SCALE_MODES.includes(src.scaleRestore as PriceScaleMode)
    ? (src.scaleRestore as PriceScaleMode)
    : null;
  return { items, scaleRestore };
}
