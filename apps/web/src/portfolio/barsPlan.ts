/** What daily history the Performance tab needs, and how to load it. Pure (the feed is injected). */
import type { DailyClose } from '@tickerglass/portfolio';
import type { Transaction } from '../api/portfolio';
import { foreignCurrencies, fxSymbol, tradedSymbols } from './model';
import { unitFactor } from './subunit';

const DAY_S = 86_400;

/** Daily bars cost an API call each; ~16 years of calendar days is plenty. */
export const MAX_DAILY_BARS = 6000;
/** Days before the first transaction, so the first day has a prior close to carry forward. */
const LEAD_DAYS = 10;

export interface BarsPlan {
  /** Traded symbols (upper-case). */
  symbols: string[];
  /** Currency -> quote symbol of its pair into the base. */
  fx: { ccy: string; symbol: string }[];
  benchmark: string | null;
  /** Bars per request (calendar days from the first transaction, with margin). */
  limit: number;
}

/** null when there is nothing to chart (no transactions). */
export function planBars(
  txs: readonly Transaction[],
  base: string,
  benchmark: string | null,
  nowMs: number,
): BarsPlan | null {
  let first = Infinity;
  for (const t of txs) {
    const ms = Date.parse(t.time);
    if (!Number.isNaN(ms) && ms < first) first = ms;
  }
  if (!Number.isFinite(first)) return null;
  const days = Math.ceil((nowMs - first) / (DAY_S * 1000)) + LEAD_DAYS;
  return {
    symbols: tradedSymbols(txs),
    fx: foreignCurrencies(txs, base).map((ccy) => ({ ccy, symbol: fxSymbol(ccy, base) })),
    benchmark: benchmark ? benchmark.trim().toUpperCase() || null : null,
    limit: Math.max(30, Math.min(MAX_DAILY_BARS, days)),
  };
}

/** Columnar bars (`time` unix seconds) to the package's daily closes; non-finite rows dropped. */
export function toDailyCloses(cols: {
  time: ArrayLike<number>;
  close: ArrayLike<number>;
}): DailyClose[] {
  const out: DailyClose[] = [];
  for (let i = 0; i < cols.time.length; i++) {
    const t = cols.time[i]!;
    const c = cols.close[i]!;
    if (Number.isFinite(t) && Number.isFinite(c)) out.push({ t, c });
  }
  return out;
}

/** Ledger currency of each traded symbol (upper-case key): that of its first buy/sell, else any row. */
export function symbolCurrencies(
  txs: readonly Pick<Transaction, 'kind' | 'symbol' | 'currency'>[],
): Record<string, string> {
  const out: Record<string, string> = {};
  const trades = new Set<string>();
  for (const t of txs) {
    if (!t.symbol || !t.currency) continue;
    const key = t.symbol.toUpperCase();
    const isTrade = t.kind === 'buy' || t.kind === 'sell';
    if (!(key in out) || (isTrade && !trades.has(key))) out[key] = t.currency;
    if (isTrade) trades.add(key);
  }
  return out;
}

/**
 * Bars come in the symbol's quote unit (pence for LSE ...), the ledger may be in the major unit.
 * Rescales each symbol's closes into its ledger currency. `quoteCurrency` is the symbol's live
 * quote currency (the bars response carries none); unknown means unchanged. Returns `data`
 * itself when nothing needs scaling.
 */
export function adjustSubunits(
  data: PerformanceData,
  ledgerCurrency: Readonly<Record<string, string>>,
  quoteCurrency: (symbol: string) => string | null | undefined,
): PerformanceData {
  let closes: Record<string, DailyClose[]> | null = null;
  for (const [sym, series] of Object.entries(data.closes)) {
    const f = unitFactor(quoteCurrency(sym), ledgerCurrency[sym]);
    if (f === 1) continue;
    closes ??= { ...data.closes };
    closes[sym] = series.map((p) => ({ ...p, c: p.c * f }));
  }
  return closes ? { ...data, closes } : data;
}

export type FetchCloses = (symbol: string, limit: number) => Promise<DailyClose[]>;

export interface PerformanceData {
  closes: Record<string, DailyClose[]>;
  /** Keyed by currency. */
  fx: Record<string, DailyClose[]>;
  benchmark?: DailyClose[];
  /** Symbols whose history could not be loaded (the chart notes them). */
  failed: string[];
}

const POOL = 4;

/**
 * Load every series of `plan`. A failing series is listed in `failed` and left out instead of
 * failing the lot (the package then reports it as missing). Aborts reject.
 */
export async function loadPerformanceData(
  plan: BarsPlan,
  fetchCloses: FetchCloses,
  signal?: AbortSignal,
): Promise<PerformanceData> {
  const jobs: { key: string; kind: 'close' | 'fx' | 'bench'; symbol: string }[] = [
    ...plan.symbols.map((s) => ({ key: s, kind: 'close' as const, symbol: s })),
    ...plan.fx.map((f) => ({ key: f.ccy, kind: 'fx' as const, symbol: f.symbol })),
    ...(plan.benchmark
      ? [{ key: plan.benchmark, kind: 'bench' as const, symbol: plan.benchmark }]
      : []),
  ];
  const data: PerformanceData = { closes: {}, fx: {}, failed: [] };
  let next = 0;
  const worker = async () => {
    for (;;) {
      signal?.throwIfAborted();
      const job = jobs[next++];
      if (!job) return;
      try {
        const series = await fetchCloses(job.symbol, plan.limit);
        signal?.throwIfAborted();
        if (job.kind === 'close') data.closes[job.key] = series;
        else if (job.kind === 'fx') data.fx[job.key] = series;
        else data.benchmark = series;
      } catch (e) {
        if (signal?.aborted) throw e;
        data.failed.push(job.symbol);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(POOL, jobs.length) }, worker));
  return data;
}
