import type { LiveQuote } from './types';

/** Breadth summary of a list, computed from whatever quotes have arrived. */
export interface ListSummary {
  /** Symbols with a usable change %. */
  count: number;
  /** Symbols asked for. */
  total: number;
  up: number;
  down: number;
  flat: number;
  /** No quote (yet). */
  missing: number;
  /** Equal-weighted average change % of the counted symbols. */
  avgChange: number | null;
  top: { symbol: string; changePercent: number } | null;
  bottom: { symbol: string; changePercent: number } | null;
}

const pct = (q: LiveQuote | undefined): number | null =>
  typeof q?.changePercent === 'number' && Number.isFinite(q.changePercent) ? q.changePercent : null;

/** Pure breadth stats over `symbols`; unit-tested, no React. */
export function summarize(
  symbols: string[],
  quotes: Record<string, LiveQuote | undefined>,
): ListSummary {
  let up = 0;
  let down = 0;
  let flat = 0;
  let missing = 0;
  let sum = 0;
  let top: ListSummary['top'] = null;
  let bottom: ListSummary['bottom'] = null;
  for (const symbol of symbols) {
    const v = pct(quotes[symbol]);
    if (v === null) {
      missing++;
      continue;
    }
    if (v > 0) up++;
    else if (v < 0) down++;
    else flat++;
    sum += v;
    if (!top || v > top.changePercent) top = { symbol, changePercent: v };
    if (!bottom || v < bottom.changePercent) bottom = { symbol, changePercent: v };
  }
  const count = up + down + flat;
  return {
    count,
    total: symbols.length,
    up,
    down,
    flat,
    missing,
    avgChange: count ? sum / count : null,
    top,
    bottom,
  };
}
