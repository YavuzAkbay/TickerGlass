import type { Ledger } from './ledger';

/** Base-currency units per 1 unit of `ccy`, or undefined when unknown. Not called for the base itself. */
export type FxLookup = (ccy: string) => number | undefined;

export interface ValuationRow {
  symbol: string;
  currency: string;
  quantity: number;
  avgCost: number;
  /** Cost basis in the row's own currency. */
  costBasis: number;
  last: number | null;
  /** Own currency. Null when there is no price. */
  marketValue: number | null;
  unrealized: number | null;
  unrealizedPct: number | null;
  dayChange: number | null;
  dayChangePct: number | null;
  /** Realized P&L and net dividends for this symbol, own currency (other currencies converted). */
  realized: number;
  dividends: number;
  fxRate: number | null;
  /** Base-currency values; null when the price or the FX rate is missing. */
  marketValueBase: number | null;
  costBasisBase: number | null;
  unrealizedBase: number | null;
  dayChangeBase: number | null;
  /** marketValueBase / totals.marketValue (0..1); null when the row is excluded from totals. */
  weight: number | null;
  priceMissing: boolean;
  fxMissing: boolean;
}

export interface CashRow {
  currency: string;
  amount: number;
  fxRate: number | null;
  valueBase: number | null;
  fxMissing: boolean;
}

export interface ValuationTotals {
  /** Holdings only (rows with price and FX). */
  marketValue: number;
  costBasis: number;
  unrealized: number;
  unrealizedPct: number | null;
  dayChange: number;
  dayChangePct: number | null;
  realized: number;
  dividends: number;
  interest: number;
  /** Account `fee` transactions. */
  fees: number;
  withholding: number;
  /** Cash across currencies that could be converted. */
  cash: number;
  /** marketValue + cash. */
  totalValue: number;
  /** realized + unrealized + dividends + interest - fees. */
  totalReturn: number;
}

export interface Valuation {
  base: string;
  rows: ValuationRow[];
  cash: CashRow[];
  totals: ValuationTotals;
  /** Symbols held without a usable price. */
  missingPrices: string[];
  /** Currencies without an FX rate (excluded from totals). */
  missingFx: string[];
}

const ok = (n: number | undefined | null): n is number =>
  typeof n === 'number' && Number.isFinite(n);

export function valuate(
  ledger: Ledger,
  prices: Record<string, number | undefined>,
  fx: FxLookup,
  base: string,
  prevClose?: Record<string, number | undefined>,
): Valuation {
  const missingFx = new Set<string>();
  const missingPrices: string[] = [];
  const rateCache = new Map<string, number | null>();
  const rateOf = (ccy: string): number | null => {
    if (ccy === base) return 1;
    let r = rateCache.get(ccy);
    if (r === undefined) {
      const v = fx(ccy);
      r = ok(v) && v > 0 ? v : null;
      rateCache.set(ccy, r);
    }
    if (r === null) missingFx.add(ccy);
    return r;
  };

  /** Net dividends in the position's currency, foreign-currency payments converted via the base. */
  const dividendsOf = (pos: Ledger['positions'][number], posRate: number | null): number => {
    let sum = pos.dividends;
    for (const [ccy, f] of Object.entries(pos.foreignDividends)) {
      const r = rateOf(ccy);
      if (r !== null && posRate !== null) sum += (f.net * r) / posRate;
    }
    return sum;
  };

  const rows: ValuationRow[] = [];
  for (const pos of ledger.positions) {
    if (pos.quantity <= 0) continue;
    const rate = rateOf(pos.currency);
    const price = prices[pos.symbol];
    const last = ok(price) ? price : null;
    const prev = prevClose?.[pos.symbol];
    const marketValue = last === null ? null : last * pos.quantity;
    const unrealized = marketValue === null ? null : marketValue - pos.costBasis;
    const dayChange = last !== null && ok(prev) ? (last - prev) * pos.quantity : null;
    const prevValue = ok(prev) ? prev * pos.quantity : 0;
    if (last === null) missingPrices.push(pos.symbol);
    rows.push({
      symbol: pos.symbol,
      currency: pos.currency,
      quantity: pos.quantity,
      avgCost: pos.avgCost,
      costBasis: pos.costBasis,
      last,
      marketValue,
      unrealized,
      unrealizedPct:
        unrealized !== null && pos.costBasis > 0 ? (unrealized / pos.costBasis) * 100 : null,
      dayChange,
      dayChangePct: dayChange !== null && prevValue > 0 ? (dayChange / prevValue) * 100 : null,
      realized: pos.realized,
      dividends: dividendsOf(pos, rate),
      fxRate: rate,
      marketValueBase: marketValue !== null && rate !== null ? marketValue * rate : null,
      costBasisBase: rate !== null && marketValue !== null ? pos.costBasis * rate : null,
      unrealizedBase: unrealized !== null && rate !== null ? unrealized * rate : null,
      dayChangeBase: dayChange !== null && rate !== null ? dayChange * rate : null,
      weight: null,
      priceMissing: last === null,
      fxMissing: rate === null,
    });
  }

  let marketValue = 0;
  let costBasis = 0;
  let unrealized = 0;
  let dayChange = 0;
  let dayPrev = 0;
  for (const r of rows) {
    if (r.marketValueBase === null || r.costBasisBase === null || r.unrealizedBase === null)
      continue;
    marketValue += r.marketValueBase;
    costBasis += r.costBasisBase;
    unrealized += r.unrealizedBase;
    if (r.dayChangeBase !== null && r.last !== null && r.fxRate !== null) {
      dayChange += r.dayChangeBase;
      dayPrev += (r.marketValue ?? 0) * r.fxRate - r.dayChangeBase;
    }
  }
  for (const r of rows) {
    if (r.marketValueBase !== null && marketValue > 0) r.weight = r.marketValueBase / marketValue;
  }

  const cash: CashRow[] = [];
  let cashBase = 0;
  for (const ccy of Object.keys(ledger.cash).sort()) {
    const amount = ledger.cash[ccy] ?? 0;
    if (Math.abs(amount) < 1e-9) continue;
    const rate = rateOf(ccy);
    const valueBase = rate === null ? null : amount * rate;
    if (valueBase !== null) cashBase += valueBase;
    cash.push({ currency: ccy, amount, fxRate: rate, valueBase, fxMissing: rate === null });
  }

  let realized = 0;
  let dividends = 0;
  let interest = 0;
  let fees = 0;
  let withholding = 0;
  for (const [ccy, t] of Object.entries(ledger.totals)) {
    const rate = rateOf(ccy);
    if (rate === null) continue;
    realized += t.realized * rate;
    dividends += t.dividends * rate;
    interest += t.interest * rate;
    fees += t.fees * rate;
    withholding += t.withholding * rate;
  }

  return {
    base,
    rows,
    cash,
    totals: {
      marketValue,
      costBasis,
      unrealized,
      unrealizedPct: costBasis > 0 ? (unrealized / costBasis) * 100 : null,
      dayChange,
      dayChangePct: dayPrev > 0 ? (dayChange / dayPrev) * 100 : null,
      realized,
      dividends,
      interest,
      fees,
      withholding,
      cash: cashBase,
      totalValue: marketValue + cashBase,
      totalReturn: realized + unrealized + dividends + interest - fees,
    },
    missingPrices,
    missingFx: [...missingFx].sort(),
  };
}
