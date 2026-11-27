/**
 * The `get_fundamentals` tool: the chart symbol's financial statements boiled down to what an
 * analyst reads first (trailing twelve months, margins, growth, balance sheet, valuation now and
 * against its own history). Computed here, exactly, so the model never does the arithmetic. Uses
 * the same statement rows, TTM and split handling as the Financials indicators, so the numbers
 * match the P/E, Revenue, ROE... panes the user can add.
 */
import { financialMath as fm, type FundamentalsData } from '@tickerglass/indicators';
import type { Chart } from '@tickerglass/engine';

/** What the report reads of a chart: its symbol and closes (any symbol's bars will do). */
export type PriceHistory = Pick<Chart, 'getSymbol' | 'rawStore' | 'symbolInfo'>;
import { useProviderStore } from '../api/provider';
import type { Fundamentals } from '../api/types';
import { fetchEvents } from '../events/api';
import { fetchFundamentals, fundamentalsOf } from '../indicators/fundamentals';

type Series = fm.Series;
type Basis = fm.PeriodBasis;

const QUARTERS_SHOWN = 8;
const YEARS_SHOWN = 4;

/** 11030000000 -> "11.03B": the model reads these as written and quotes them back. */
export function money(v: number): string | null {
  if (!Number.isFinite(v)) return null;
  const a = Math.abs(v);
  const [d, u] =
    a >= 1e12
      ? [1e12, 'T']
      : a >= 1e9
        ? [1e9, 'B']
        : a >= 1e6
          ? [1e6, 'M']
          : a >= 1e3
            ? [1e3, 'K']
            : [1, ''];
  return `${(v / d).toFixed(2)}${u}`;
}

const fix = (v: number, digits = 2): number | null =>
  Number.isFinite(v) ? Number(v.toFixed(digits)) : null;
const pct = (v: number): number | null => fix(v, 1);
const date = (t: number): string => new Date(t * 1000).toISOString().slice(0, 10);

function last(s: Series | null): { t: number; v: number } | null {
  if (!s) return null;
  for (let k = s.values.length - 1; k >= 0; k--)
    if (Number.isFinite(s.values[k]!)) return { t: s.periods[k]!, v: s.values[k]! };
  return null;
}

/** Value one year before `t` (4 quarters or 1 year back on the series' own periods). */
function yearBefore(s: Series, t: number, basis: Basis): number {
  const k = s.periods.indexOf(t);
  const j = k - (basis === 'Quarterly' ? 4 : 1);
  return j >= 0 ? s.values[j]! : NaN;
}

const growth = (now: number, before: number): number =>
  Number.isFinite(now) && Number.isFinite(before) && before !== 0
    ? ((now - before) / Math.abs(before)) * 100
    : NaN;

const ratio = (a: number, b: number): number =>
  Number.isFinite(a) && Number.isFinite(b) && b !== 0 ? a / b : NaN;

/** Close of the last bar at or before `t` in the chart's bars (NaN before they start). */
function closeAt(chart: PriceHistory, t: number): number {
  const s = chart.rawStore;
  if (!s.length || s.time[0]! > t) return NaN;
  let lo = 0;
  let hi = s.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (s.time[mid]! <= t) lo = mid;
    else hi = mid - 1;
  }
  return s.close[lo]!;
}

interface Lines {
  basis: Basis;
  revenue: Series | null;
  grossProfit: Series | null;
  operatingIncome: Series | null;
  netIncome: Series | null;
  eps: Series | null;
  shares: Series | null;
  ocf: Series | null;
  fcf: Series | null;
  equity: Series | null;
  debt: Series | null;
  cash: Series | null;
  currentAssets: Series | null;
  currentLiabilities: Series | null;
}

/** Every line item of one basis, per-share rows on the bars' split-adjusted basis. */
function linesOf(data: FundamentalsData, basis: Basis): Lines | null {
  const st = fm.statementsOf(data, basis);
  if (!st) return null;
  const { income, balance, cashflow } = st;
  const rawShares = fm.series(income, fm.ROW.dilutedShares);
  const shares = rawShares && fm.splitAdjusted(rawShares, rawShares, data.splits, 'count');
  const netIncome = fm.series(income, fm.ROW.netIncome);
  const reported = fm.series(income, fm.ROW.dilutedEps);
  const eps = reported
    ? fm.splitAdjusted(reported, rawShares, data.splits, 'perShare')
    : netIncome && shares
      ? fm.divideBy(netIncome, shares)
      : null;
  const ocf = fm.series(cashflow, fm.ROW.ocf);
  const capex = fm.series(cashflow, fm.ROW.capex);
  let fcf = fm.series(cashflow, fm.ROW.fcf);
  if (!fcf && ocf && capex)
    // Capital expenditure is reported negative.
    fcf = { periods: ocf.periods, values: ocf.values.map((v, k) => v + capex.values[k]!) };
  return {
    basis,
    revenue: fm.series(income, fm.ROW.revenue),
    grossProfit: fm.series(income, fm.ROW.grossProfit),
    operatingIncome: fm.series(income, fm.ROW.operatingIncome),
    netIncome,
    eps,
    shares,
    ocf,
    fcf,
    equity: fm.series(balance, fm.ROW.equity),
    debt: fm.series(balance, fm.ROW.totalDebt),
    cash: fm.series(balance, fm.ROW.cash),
    currentAssets: fm.series(balance, fm.ROW.currentAssets),
    currentLiabilities: fm.series(balance, fm.ROW.currentLiabilities),
  };
}

const ttm = (s: Series | null, basis: Basis): Series | null =>
  s ? fm.trailingTwelveMonths(s, basis) : null;

/** min / median / max of the finite values, with how many there were. */
function spread(values: number[]): Record<string, number | null> | null {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (v.length < 2) return null;
  const mid = v.length >> 1;
  const median = v.length % 2 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2;
  return { min: fix(v[0]!), median: fix(median), max: fix(v[v.length - 1]!), periods: v.length };
}

/**
 * The tool's result for `chart`'s symbol. Throws a plain message when the provider has no
 * statements for it (crypto, FX, indices, or a provider without fundamentals).
 */
export async function fundamentalsReport(chart: PriceHistory): Promise<Record<string, unknown>> {
  const symbol = chart.getSymbol();
  const res: Fundamentals = await fetchFundamentals(symbol);
  const events = useProviderStore.getState().capabilities.events.includes('splits')
    ? await fetchEvents(symbol).catch(() => null)
    : null;
  const data = fundamentalsOf(res, events);
  const info = res.info ?? {};
  const notes: string[] = [];

  const s = chart.rawStore;
  const price = s.length ? s.close[s.length - 1]! : NaN;
  const out: Record<string, unknown> = {
    symbol,
    ...(info.longName ? { name: info.longName } : {}),
    ...(info.sector ? { sector: info.sector } : {}),
    ...(info.industry ? { industry: info.industry } : {}),
    currency: info.currency ?? chart.symbolInfo?.currency ?? null,
    price: fix(price, 4),
    priceDate: s.length ? date(s.time[s.length - 1]!) : null,
  };

  const q = data ? linesOf(data, 'Quarterly') : null;
  const a = data ? linesOf(data, 'Annual') : null;
  // TTM from quarters when four are known, else the latest fiscal year.
  const base = q && last(ttm(q.revenue ?? q.netIncome, 'Quarterly')) ? q : a;

  // Market cap: the provider's, else the latest diluted share count at today's price.
  const sharesNow = last(base?.shares ?? null)?.v ?? NaN;
  const marketCap =
    typeof info.marketCap === 'number' && info.marketCap > 0 ? info.marketCap : price * sharesNow;
  out.marketCap = money(marketCap);

  if (!base) {
    notes.push('no financial statements for this symbol: only the provider summary below');
  } else {
    const b = base.basis;
    const tRev = ttm(base.revenue, b);
    const tNi = ttm(base.netIncome, b);
    const tEps = ttm(base.eps, b);
    const tFcf = ttm(base.fcf, b);
    const tOcf = ttm(base.ocf, b);
    const tGp = ttm(base.grossProfit, b);
    const tOi = ttm(base.operatingIncome, b);
    const rev = last(tRev);
    const ni = last(tNi);
    const eps = last(tEps);
    const fcf = last(tFcf);
    const equity = last(base.equity);
    const debt = last(base.debt);
    const cash = last(base.cash);
    const yoy = (x: Series | null, l: { t: number; v: number } | null) =>
      x && l ? pct(growth(l.v, yearBefore(x, l.t, b))) : null;

    out.trailing = {
      basis: b === 'Quarterly' ? 'trailing twelve months (last 4 quarters)' : 'latest fiscal year',
      periodEnd: rev ? date(rev.t) : ni ? date(ni.t) : null,
      revenue: money(rev?.v ?? NaN),
      revenueGrowthYoYPct: yoy(tRev, rev),
      netIncome: money(ni?.v ?? NaN),
      netIncomeGrowthYoYPct: yoy(tNi, ni),
      epsDiluted: fix(eps?.v ?? NaN),
      epsGrowthYoYPct: yoy(tEps, eps),
      operatingCashFlow: money(last(tOcf)?.v ?? NaN),
      freeCashFlow: money(fcf?.v ?? NaN),
      grossMarginPct: pct(ratio(last(tGp)?.v ?? NaN, rev?.v ?? NaN) * 100),
      operatingMarginPct: pct(ratio(last(tOi)?.v ?? NaN, rev?.v ?? NaN) * 100),
      netMarginPct: pct(ratio(ni?.v ?? NaN, rev?.v ?? NaN) * 100),
      roePct: pct(ratio(ni?.v ?? NaN, equity?.v ?? NaN) * 100),
    };

    out.balanceSheet = {
      asOf: equity ? date(equity.t) : null,
      cash: money(cash?.v ?? NaN),
      totalDebt: money(debt?.v ?? NaN),
      netDebt: money((debt?.v ?? NaN) - (cash?.v ?? NaN)),
      equity: money(equity?.v ?? NaN),
      debtToEquity: fix(ratio(debt?.v ?? NaN, equity?.v ?? NaN)),
      currentRatio: fix(
        ratio(last(base.currentAssets)?.v ?? NaN, last(base.currentLiabilities)?.v ?? NaN),
      ),
    };

    const pe = eps && eps.v > 0 ? price / eps.v : NaN;
    const epsGrowth = tEps && eps ? growth(eps.v, yearBefore(tEps, eps.t, b)) : NaN;
    out.valuationNow = {
      peTrailing: fix(pe),
      ...(eps && eps.v <= 0 ? { peNote: 'trailing EPS is negative: P/E is not meaningful' } : {}),
      peForwardProvider: fix(info.forwardPE ?? NaN),
      peg: fix(epsGrowth > 0 ? pe / epsGrowth : NaN),
      priceToSales: fix(ratio(marketCap, rev?.v ?? NaN)),
      priceToBook: fix(equity && equity.v > 0 ? marketCap / equity.v : NaN),
      earningsYieldPct: pct(ratio(ni?.v ?? NaN, marketCap) * 100),
      fcfYieldPct: pct(ratio(fcf?.v ?? NaN, marketCap) * 100),
    };

    // The same multiples at each past period end, at that day's close: the stock against itself.
    if (tEps) {
      const hist = tEps.periods
        .map((t, k) => ({ t, e: tEps.values[k]!, c: closeAt(chart, t) }))
        .filter((x) => Number.isFinite(x.c) && x.e > 0);
      const peHist = hist.map((x) => x.c / x.e);
      const psHist = tRev
        ? tRev.periods.map((t, k) => {
            const sh = base.shares ? fm.valueAt(base.shares, t) : NaN;
            return ratio(closeAt(chart, t) * sh, tRev.values[k]!);
          })
        : [];
      out.valuationHistory = {
        source: 'multiple at the close on each past period end, from the chart bars',
        peByPeriod: hist
          .slice(-QUARTERS_SHOWN)
          .map((x) => ({ end: date(x.t), pe: fix(x.c / x.e) })),
        peRange: spread(peHist),
        psRange: spread(psHist),
      };
      if (hist.length < 4)
        notes.push(
          'few past periods have both earnings and chart bars: load more history (longer range or a daily chart) for a better comparison',
        );
    }

    if (q) {
      const rows = (q.revenue ?? q.netIncome)?.periods ?? [];
      out.quarters = rows.slice(-QUARTERS_SHOWN).map((t) => {
        const at = (x: Series | null) => (x ? fm.valueAt(x, t) : NaN);
        const r = at(q.revenue);
        return {
          end: date(t),
          revenue: money(r),
          revenueYoYPct: q.revenue ? pct(growth(r, yearBefore(q.revenue, t, 'Quarterly'))) : null,
          netIncome: money(at(q.netIncome)),
          eps: fix(at(q.eps)),
          grossMarginPct: pct(ratio(at(q.grossProfit), r) * 100),
          operatingMarginPct: pct(ratio(at(q.operatingIncome), r) * 100),
        };
      });
    }
    if (a) {
      const rows = (a.revenue ?? a.netIncome)?.periods ?? [];
      out.fiscalYears = rows.slice(-YEARS_SHOWN).map((t) => {
        const at = (x: Series | null) => (x ? fm.valueAt(x, t) : NaN);
        const r = at(a.revenue);
        return {
          end: date(t),
          revenue: money(r),
          revenueGrowthPct: a.revenue ? pct(growth(r, yearBefore(a.revenue, t, 'Annual'))) : null,
          netIncome: money(at(a.netIncome)),
          eps: fix(at(a.eps)),
          freeCashFlow: money(at(a.fcf)),
          netMarginPct: pct(ratio(at(a.netIncome), r) * 100),
        };
      });
    }
  }

  out.providerSummary = {
    trailingPE: fix(info.trailingPE ?? NaN),
    forwardPE: fix(info.forwardPE ?? NaN),
    dividendYieldPct: fix(info.dividendYield ?? NaN),
    beta: fix(info.beta ?? NaN),
    fiftyTwoWeekHigh: fix(info.fiftyTwoWeekHigh ?? NaN),
    fiftyTwoWeekLow: fix(info.fiftyTwoWeekLow ?? NaN),
  };
  notes.push(
    'no peer, sector or analyst-estimate data: compare the stock with its own history only',
  );
  out.notes = notes;
  return out;
}
