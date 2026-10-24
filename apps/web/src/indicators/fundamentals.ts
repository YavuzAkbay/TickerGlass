/** `/fundamentals/{symbol}` for indicator definitions that read financial statements. */
import type { FundamentalsData } from '@tickerglass/indicators';
import { cachedJson } from '../api/client';
import type { Fundamentals, FundamentalsStatement } from '../api/types';

export const FUNDAMENTALS_TTL_MS = 10 * 60 * 1000;

export const fundamentalsPath = (symbol: string): string =>
  `/fundamentals/${encodeURIComponent(symbol)}`;

/** Cached for 10 minutes; concurrent callers share one request, failures are not cached. */
export function fetchFundamentals(symbol: string): Promise<Fundamentals> {
  return cachedJson<Fundamentals>(fundamentalsPath(symbol), FUNDAMENTALS_TTL_MS);
}

/** One statement in runtime form: ISO period ends -> unix seconds, nulls -> NaN. */
function statementOf(stmt: FundamentalsStatement | undefined) {
  if (!stmt || !stmt.periods?.length) return undefined;
  return {
    periods: stmt.periods.map((p) => Date.parse(p) / 1000),
    rows: Object.fromEntries(
      Object.entries(stmt.rows).map(([name, values]) => [
        name,
        values.map((v) => (v === null || v === undefined ? NaN : v)),
      ]),
    ),
  };
}

/** The response's statements as the indicator runtime's `env.fundamentals`. */
export function fundamentalsOf(res: Fundamentals): FundamentalsData | null {
  const f = res.financials ?? {};
  const quarterly = {
    income: statementOf(f.quarterly?.income),
    balance: statementOf(f.quarterly?.balance),
    cashflow: statementOf(f.quarterly?.cashflow),
  };
  const annual = {
    income: statementOf(f.income),
    balance: statementOf(f.balance),
    cashflow: statementOf(f.cashflow),
  };
  const has = (s: Record<string, unknown>) => Object.values(s).some(Boolean);
  if (!has(quarterly) && !has(annual)) return null;
  return {
    ...(has(quarterly) ? { quarterly } : {}),
    ...(has(annual) ? { annual } : {}),
  } as FundamentalsData;
}
