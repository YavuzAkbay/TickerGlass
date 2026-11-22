import { cashEffect } from './ledger';
import type { CostMethod, DailyClose, Tx } from './types';

export interface PerformanceInput {
  /** Split-adjusted daily closes per symbol. */
  closes: Record<string, DailyClose[]>;
  /** Daily closes giving base-currency units per 1 unit of the currency. The base itself is 1. */
  fx: Record<string, DailyClose[]>;
  benchmark?: DailyClose[];
  base: string;
  /** Accepted for API symmetry; time-weighted returns do not depend on the lot method. */
  costMethod?: CostMethod;
}

export interface PerformancePoint {
  /** Unix seconds, start of the UTC day. */
  t: number;
  /** End-of-day portfolio value in the base currency. */
  value: number;
  /** External flow on that day in the base currency (positive = money in). */
  netFlow: number;
  /**
   * Cumulative time-weighted return in percent. The first point already includes the move from
   * the fill price to that day's close (the opening value is 0 and the buys are the inflow).
   */
  twr: number;
  /** Cumulative benchmark return since the first point, in percent. */
  benchmark?: number;
}

export interface PerformanceStats {
  /** Percent. */
  twr: number;
  /** Percent. */
  benchmarkReturn?: number;
  /** Largest peak-to-trough fall of the TWR index, percent (positive number). */
  maxDrawdownPct: number;
}

export interface PerformanceResult {
  points: PerformancePoint[];
  stats: PerformanceStats;
  /** True when the portfolio has cashIn/cashOut (value includes cash). */
  cashMode: boolean;
  /**
   * True when the history has cashIn/cashOut but the running cash went materially negative
   * (deposits missing from the import), so the run was redone in non-cash mode (`cashMode` is
   * then false).
   */
  cashFallback: boolean;
  /** Currencies / symbols with no series at all (their value was skipped / priced at the last trade). */
  missing: { fx: string[]; closes: string[] };
}

const DAY_MS = 86_400_000;
const DAY_S = 86_400;

/** Ascending, one entry per UTC day, with a forward-moving cursor for carry-forward lookups. */
class Series {
  readonly days: number[] = [];
  private readonly vals: number[] = [];
  private cur = -1;

  constructor(bars: DailyClose[] | undefined) {
    const sorted = (bars ?? [])
      .filter((b) => Number.isFinite(b.t) && Number.isFinite(b.c))
      .map((b) => ({ day: Math.floor(b.t / DAY_S), c: b.c }))
      .sort((a, b) => a.day - b.day);
    for (const b of sorted) {
      if (this.days.length && this.days[this.days.length - 1] === b.day) {
        this.vals[this.vals.length - 1] = b.c;
      } else {
        this.days.push(b.day);
        this.vals.push(b.c);
      }
    }
  }

  get empty(): boolean {
    return this.days.length === 0;
  }

  /** Last close on or before `day`; null before the first bar. Days must be queried ascending. */
  at(day: number): number | null {
    while (this.cur + 1 < this.days.length && (this.days[this.cur + 1] as number) <= day)
      this.cur++;
    return this.cur >= 0 ? (this.vals[this.cur] as number) : null;
  }

  first(): number | null {
    return this.vals.length ? (this.vals[0] as number) : null;
  }
}

interface Held {
  currency: string;
  qty: number;
  /** Last trade price in split-adjusted terms (fallback before the first bar). */
  adjPrice: number | null;
}

const finite = (n: number | null | undefined): n is number =>
  typeof n === 'number' && Number.isFinite(n);

/**
 * Time-weighted return per UTC day: `r = (V_t + Out_t) / (V_{t-1} + In_t) - 1` with `V_{-1} = 0`.
 * Non-cash mode: In = buy cost (fee included), Out = sell proceeds net of fee (held shares only).
 * Cash mode: In = deposits, Out = withdrawals. A day is skipped when the denominator is <= 0.
 * Transactions must be passed in API order: they are sorted stably by (time, input index).
 */
export function performance(txs: Tx[], input: PerformanceInput): PerformanceResult {
  const cash = compute(txs, input, true);
  if (!cash.negativeCash) return cash.result;
  return { ...compute(txs, input, false).result, cashFallback: true };
}

function compute(
  txs: Tx[],
  input: PerformanceInput,
  allowCash: boolean,
): { result: PerformanceResult; negativeCash: boolean } {
  const ordered: { tx: Tx; day: number; i: number }[] = [];
  txs.forEach((tx, i) => {
    const ms = Date.parse(tx.time);
    if (!Number.isNaN(ms)) ordered.push({ tx, day: Math.floor(ms / DAY_MS), i });
  });
  ordered.sort(
    (a, b) => a.day - b.day || Date.parse(a.tx.time) - Date.parse(b.tx.time) || a.i - b.i,
  );

  const empty: PerformanceResult = {
    points: [],
    stats: { twr: 0, maxDrawdownPct: 0 },
    cashMode: false,
    cashFallback: false,
    missing: { fx: [], closes: [] },
  };
  const first = ordered[0];
  if (!first) return { result: empty, negativeCash: false };
  const startDay = first.day;
  const cashMode =
    allowCash && ordered.some(({ tx }) => tx.kind === 'cashIn' || tx.kind === 'cashOut');

  // Splits per symbol (in processing order) so we know the share-count factor still ahead.
  const splitsAhead = new Map<string, number[]>();
  const heldSymbols = new Set<string>();
  for (const { tx } of ordered) {
    if (!tx.symbol) continue;
    if (tx.kind === 'buy' || tx.kind === 'sell' || tx.kind === 'split') heldSymbols.add(tx.symbol);
    if (tx.kind === 'split' && finite(tx.quantity) && tx.quantity > 0) {
      const list = splitsAhead.get(tx.symbol) ?? [];
      list.push(tx.quantity);
      splitsAhead.set(tx.symbol, list);
    }
  }
  const splitCursor = new Map<string, number>();
  const factorAhead = (sym: string): number => {
    const list = splitsAhead.get(sym);
    if (!list) return 1;
    let f = 1;
    for (let i = splitCursor.get(sym) ?? 0; i < list.length; i++) f *= list[i] as number;
    return f;
  };

  const series = new Map<string, Series>();
  for (const sym of heldSymbols) series.set(sym, new Series(input.closes[sym]));
  const fxSeries = new Map<string, Series>();
  const fxOf = (ccy: string): Series => {
    let s = fxSeries.get(ccy);
    if (!s) {
      s = new Series(input.fx[ccy]);
      fxSeries.set(ccy, s);
    }
    return s;
  };
  const bench = input.benchmark ? new Series(input.benchmark) : null;

  // Day grid.
  const gridSet = new Set<number>();
  for (const sym of heldSymbols) {
    for (const d of (series.get(sym) as Series).days) if (d >= startDay) gridSet.add(d);
  }
  if (gridSet.size === 0 && bench) for (const d of bench.days) if (d >= startDay) gridSet.add(d);
  const grid = [...gridSet].sort((a, b) => a - b);
  if (grid.length === 0) return { result: { ...empty, cashMode }, negativeCash: false };

  const missingFx = new Set<string>();
  const missingCloses = new Set<string>();
  for (const sym of heldSymbols) if ((series.get(sym) as Series).empty) missingCloses.add(sym);

  const held = new Map<string, Held>();
  const cash: Record<string, number> = {};
  const income: Record<string, number> = {};
  let cursor = 0;

  const points: PerformancePoint[] = [];
  let index = 1;
  let peak = 1;
  let maxDd = 0;
  let prevValue = 0;
  const benchBase = bench && !bench.empty ? (bench.at(grid[0] as number) ?? bench.first()) : null;

  for (const day of grid) {
    const rateCache = new Map<string, number>();
    const rate = (ccy: string): number => {
      if (ccy === input.base) return 1;
      const cached = rateCache.get(ccy);
      if (cached !== undefined) return cached;
      const s = fxOf(ccy);
      const r = s.at(day) ?? s.first();
      if (r === null || !(r > 0)) {
        missingFx.add(ccy);
        rateCache.set(ccy, 0);
        return 0;
      }
      rateCache.set(ccy, r);
      return r;
    };

    // External money in / out of the portfolio today, in base currency (see the TWR formula above).
    let inflow = 0;
    let outflow = 0;
    while (cursor < ordered.length && (ordered[cursor] as { day: number }).day <= day) {
      const { tx } = ordered[cursor] as { tx: Tx };
      cursor++;
      const ccy = tx.currency;
      const fee = finite(tx.fee) && tx.fee > 0 ? tx.fee : 0;
      const sym = tx.symbol;
      if (tx.kind === 'buy' || tx.kind === 'sell') {
        const q = tx.quantity;
        const p = tx.price;
        if (!sym || !finite(q) || q <= 0 || !finite(p)) continue;
        let h = held.get(sym);
        if (!h) {
          // A sell with nothing ever held must not fix the symbol's currency.
          if (tx.kind === 'sell') {
            if (cashMode) {
              cash[ccy] = (cash[ccy] ?? 0) + cashEffect(tx);
              // Cash that appeared from shares bought before the history window.
              inflow += (q * p - fee) * rate(ccy);
            }
            continue;
          }
          h = { currency: ccy, qty: 0, adjPrice: null };
          held.set(sym, h);
        }
        if (h.currency !== ccy) continue;
        h.adjPrice = p / factorAhead(sym);
        if (tx.kind === 'buy') {
          h.qty += q;
          if (cashMode) cash[ccy] = (cash[ccy] ?? 0) + cashEffect(tx);
          else inflow += (q * p + fee) * rate(ccy);
        } else {
          // Oversell: only the held part is a sale of this portfolio's shares.
          const sold = Math.min(q, h.qty);
          h.qty -= sold;
          if (cashMode) {
            cash[ccy] = (cash[ccy] ?? 0) + cashEffect(tx);
            const unheld = q - sold;
            if (unheld > 0) inflow += (unheld * p - (fee * unheld) / q) * rate(ccy);
          } else if (sold > 0) {
            outflow += (sold * p - (fee * sold) / q) * rate(ccy);
          }
        }
      } else if (tx.kind === 'split') {
        const r = tx.quantity;
        if (!sym || !finite(r) || r <= 0) continue;
        splitCursor.set(sym, (splitCursor.get(sym) ?? 0) + 1);
        const h = held.get(sym);
        if (h) h.qty *= r;
      } else if (tx.kind === 'cashIn' || tx.kind === 'cashOut') {
        if (!cashMode) continue;
        const eff = cashEffect(tx);
        cash[ccy] = (cash[ccy] ?? 0) + eff;
        if (eff >= 0) inflow += eff * rate(ccy);
        else outflow += -eff * rate(ccy);
      } else {
        // dividend / interest / fee: part of the return, never an external flow.
        const eff = cashEffect(tx);
        if (cashMode) cash[ccy] = (cash[ccy] ?? 0) + eff;
        else income[ccy] = (income[ccy] ?? 0) + eff;
      }
    }

    let holdings = 0;
    for (const [sym, h] of held) {
      if (h.qty <= 0) continue;
      const r = rate(h.currency);
      if (r === 0) continue;
      const px = (series.get(sym) as Series).at(day) ?? h.adjPrice;
      if (px === null) continue;
      holdings += h.qty * factorAhead(sym) * px * r;
    }
    let cashValue = 0;
    for (const [ccy, amt] of Object.entries(cashMode ? cash : income)) {
      if (Math.abs(amt) < 1e-12) continue;
      cashValue += amt * rate(ccy);
    }
    const value = holdings + cashValue;
    // Deposits missing from the import show up as a negative running cash balance.
    if (cashMode && (holdings > 0 ? cashValue < -0.01 * holdings : cashValue < -1e-6)) {
      return { result: empty, negativeCash: true };
    }

    const flow = inflow - outflow;
    const denominator = prevValue + inflow;
    if (denominator > 0) index *= (value + outflow) / denominator;
    peak = Math.max(peak, index);
    maxDd = Math.max(maxDd, peak > 0 ? ((peak - index) / peak) * 100 : 0);

    const point: PerformancePoint = {
      t: day * DAY_S,
      value,
      netFlow: flow,
      twr: (index - 1) * 100,
    };
    if (bench && benchBase !== null && benchBase > 0) {
      const b = bench.at(day) ?? benchBase;
      point.benchmark = (b / benchBase - 1) * 100;
    }
    points.push(point);
    prevValue = value;
  }

  const last = points[points.length - 1] as PerformancePoint;
  const stats: PerformanceStats = { twr: last.twr, maxDrawdownPct: maxDd };
  if (last.benchmark !== undefined) stats.benchmarkReturn = last.benchmark;
  return {
    result: {
      points,
      stats,
      cashMode,
      cashFallback: false,
      missing: { fx: [...missingFx].sort(), closes: [...missingCloses].sort() },
    },
    negativeCash: false,
  };
}
