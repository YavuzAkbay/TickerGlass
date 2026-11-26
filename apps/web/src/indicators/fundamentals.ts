/** `/fundamentals/{symbol}` for indicator definitions that read financial statements. */
import type { FundamentalsData } from '@tickerglass/indicators';
import { cachedJson, isUnsupported } from '../api/client';
import { useProviderStore } from '../api/provider';
import type { Fundamentals, FundamentalsStatement } from '../api/types';
import { fetchEvents, type EventsResponse } from '../events/api';

export const FUNDAMENTALS_TTL_MS = 10 * 60 * 1000;

export const fundamentalsPath = (symbol: string): string =>
  `/fundamentals/${encodeURIComponent(symbol)}`;

/** Reason shown on an indicator reading financial statements when the provider has none
 * (the controller prefixes it: "Could not load financial statements: ..."). */
export const statementsUnavailable = (provider: string): string => `not available from ${provider}`;

/**
 * Cached for 10 minutes; concurrent callers share one request, failures are not cached.
 * Rejects with a plain message when the provider has no financial statements.
 */
export async function fetchFundamentals(symbol: string): Promise<Fundamentals> {
  const { capabilities, name } = useProviderStore.getState();
  if (!capabilities.fundamentalsStatements) throw new Error(statementsUnavailable(name));
  try {
    return await cachedJson<Fundamentals>(fundamentalsPath(symbol), FUNDAMENTALS_TTL_MS);
  } catch (err) {
    if (isUnsupported(err)) throw new Error(statementsUnavailable(name), { cause: err });
    throw err;
  }
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

/** Splits with a usable ratio, ascending, for split-adjusting per-share rows. */
function splitsOf(events: EventsResponse | null | undefined) {
  return (events?.splits ?? [])
    .filter(
      (s): s is { t: number; ratio: number } =>
        Number.isFinite(s.t) && typeof s.ratio === 'number' && s.ratio > 0,
    )
    .map(({ t, ratio }) => ({ t, ratio }))
    .sort((a, b) => a.t - b.t);
}

/**
 * The symbol's statements plus its splits (bars are split-adjusted, statements
 * are not). Splits are best effort: without them per-share rows stay as filed.
 */
export async function loadFundamentals(symbol: string): Promise<FundamentalsData | null> {
  const [res, events] = await Promise.all([
    fetchFundamentals(symbol),
    useProviderStore.getState().capabilities.events.includes('splits')
      ? fetchEvents(symbol).catch(() => null)
      : null,
  ]);
  return fundamentalsOf(res, events);
}

/** The response's statements as the indicator runtime's `env.fundamentals`. */
export function fundamentalsOf(
  res: Fundamentals,
  events?: EventsResponse | null,
): FundamentalsData | null {
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
  const splits = splitsOf(events);
  return {
    ...(has(quarterly) ? { quarterly } : {}),
    ...(has(annual) ? { annual } : {}),
    ...(splits.length ? { splits } : {}),
  } as FundamentalsData;
}
