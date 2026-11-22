import { performance, type PerformanceResult } from '@tickerglass/portfolio';
import { useEffect, useMemo, useState, type PointerEvent } from 'react';
import type { Portfolio, Transaction } from '../api/portfolio';
import { errorMessage } from '../api/client';
import { feed } from '../chart/feed';
import { fmtMoney, fmtDay, fmtPct, tone } from './fmt';
import { useLiveQuotes } from '../quotes/hooks';
import { toTxs, tradedSymbols } from './model';
import {
  adjustSubunits,
  loadPerformanceData,
  planBars,
  type BarsPlan,
  symbolCurrencies,
  toDailyCloses,
  type PerformanceData,
} from './barsPlan';
import { RANGES, sliceRange, type RangePoint } from './range';
import { usePortfolio } from './store';

const DAY = { unit: 'day', count: 1 } as const;

async function fetchCloses(symbol: string, limit: number) {
  const res = await feed.getBars({ symbol, interval: DAY, limit });
  return toDailyCloses(res.bars);
}

type Load =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'ready'; data: PerformanceData }
  | { state: 'error'; message: string };

/** Daily history of every traded symbol, FX pair and the benchmark. */
function usePerformanceData(portfolio: Portfolio, transactions: readonly Transaction[]): Load {
  const [now] = useState(() => Date.now());
  const base = portfolio.baseCurrency;
  const bench = portfolio.benchmark;
  const plan = useMemo(
    () => planBars(transactions, base, bench, now),
    [transactions, base, bench, now],
  );
  // The outcome is tagged with the plan it answers; any other plan means "still loading".
  const [outcome, setOutcome] = useState<{ plan: BarsPlan; load: Load } | null>(null);
  useEffect(() => {
    if (!plan) return;
    const ac = new AbortController();
    loadPerformanceData(plan, fetchCloses, ac.signal)
      .then((data) => setOutcome({ plan, load: { state: 'ready', data } }))
      .catch((e: unknown) => {
        if (!ac.signal.aborted)
          setOutcome({ plan, load: { state: 'error', message: errorMessage(e) } });
      });
    return () => ac.abort();
  }, [plan]);
  if (!plan) return { state: 'idle' };
  return outcome?.plan === plan ? outcome.load : { state: 'loading' };
}

const W = 300;
const H = 150;

function Chart({
  points,
  hover,
  onHover,
}: {
  points: RangePoint[];
  hover: number | null;
  onHover: (i: number | null) => void;
}) {
  const geo = useMemo(() => {
    let lo = 0;
    let hi = 0;
    for (const p of points) {
      lo = Math.min(lo, p.portfolio, p.benchmark ?? 0);
      hi = Math.max(hi, p.portfolio, p.benchmark ?? 0);
    }
    if (hi - lo < 1e-9) hi = lo + 1;
    const pad = (hi - lo) * 0.08;
    lo -= pad;
    hi += pad;
    const n = points.length;
    const x = (i: number) => (n > 1 ? (i / (n - 1)) * W : 0);
    const y = (v: number) => H - ((v - lo) / (hi - lo)) * H;
    // Thin very long series to ~one point per pixel column.
    const step = Math.max(1, Math.floor(n / W));
    const idx: number[] = [];
    for (let i = 0; i < n; i += step) idx.push(i);
    if (idx[idx.length - 1] !== n - 1) idx.push(n - 1);
    const line = (pick: (p: RangePoint) => number | undefined) =>
      idx
        .map((i) => {
          const v = pick(points[i]!);
          return v === undefined ? null : `${x(i).toFixed(1)},${y(v).toFixed(1)}`;
        })
        .filter((s): s is string => s !== null)
        .join(' ');
    return {
      x,
      y,
      portfolio: line((p) => p.portfolio),
      benchmark: points[0]?.benchmark !== undefined ? line((p) => p.benchmark) : null,
    };
  }, [points]);

  const move = (e: PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    if (r.width <= 0 || points.length === 0) return;
    const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    onHover(Math.round(f * (points.length - 1)));
  };

  return (
    <svg
      className="pf-chart"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      role="img"
      aria-label="Portfolio return over time"
      onPointerMove={move}
      onPointerLeave={() => onHover(null)}
    >
      <line x1="0" x2={W} y1={geo.y(0)} y2={geo.y(0)} className="pf-chart-zero" />
      {geo.benchmark ? <polyline points={geo.benchmark} className="pf-chart-line bench" /> : null}
      <polyline points={geo.portfolio} className="pf-chart-line" />
      {hover !== null ? (
        <line x1={geo.x(hover)} x2={geo.x(hover)} y1="0" y2={H} className="pf-chart-cursor" />
      ) : null}
    </svg>
  );
}

function Stat({ label, value, cls = '' }: { label: string; value: string; cls?: string }) {
  return (
    <div className="bt-stat">
      <span className="bt-stat-label">{label}</span>
      <span className={`bt-stat-value rs-num ${cls}`}>{value}</span>
    </div>
  );
}

interface Props {
  portfolio: Portfolio;
  transactions: readonly Transaction[];
}

export function PerformanceTab({ portfolio, transactions }: Props) {
  const range = usePortfolio((s) => s.range);
  const [hover, setHover] = useState<number | null>(null);
  const load = usePerformanceData(portfolio, transactions);
  const base = portfolio.baseCurrency;

  // Bars carry no currency: LSE/JSE/TASE closes are in pence/cents/agorot, so take the quote
  // currency from the live quote and rescale into the ledger currency.
  const traded = useMemo(() => tradedSymbols(transactions), [transactions]);
  const quotes = useLiveQuotes(traded);
  // Only the currencies matter: keep the memo below stable across price ticks.
  const ccyKey = traded.map((s) => quotes[s]?.currency ?? '').join('|');
  const quoteCcy = useMemo(() => {
    const out: Record<string, string> = {};
    ccyKey.split('|').forEach((c, i) => {
      const s = traded[i];
      if (s && c) out[s] = c;
    });
    return out;
  }, [ccyKey, traded]);
  const ledgerCcy = useMemo(() => symbolCurrencies(transactions), [transactions]);

  const result = useMemo<PerformanceResult | null>(() => {
    if (load.state !== 'ready') return null;
    const d = adjustSubunits(load.data, ledgerCcy, (s) => quoteCcy[s]);
    return performance(toTxs(transactions), {
      closes: d.closes,
      fx: d.fx,
      ...(d.benchmark ? { benchmark: d.benchmark } : {}),
      base,
      costMethod: portfolio.costMethod,
    });
  }, [load, transactions, base, portfolio.costMethod, ledgerCcy, quoteCcy]);

  const sliced = useMemo(() => (result ? sliceRange(result.points, range) : null), [result, range]);

  if (transactions.length === 0)
    return <p className="pf-muted pf-pad">Add transactions to see performance.</p>;
  if (load.state === 'error')
    return (
      <p className="rs-error pf-err" role="alert">
        Could not load price history: {load.message}
      </p>
    );

  const cur = sliced && hover !== null ? sliced.points[hover] : sliced?.points.at(-1);
  const failed = load.state === 'ready' ? load.data.failed : [];
  const cashFallback = !!result?.cashFallback;
  const lastValue = result?.points.at(-1)?.value;

  return (
    <div>
      <div className="pf-bar">
        <div className="wl-seg" role="tablist" aria-label="Range">
          {RANGES.map((r) => (
            <button
              key={r}
              type="button"
              role="tab"
              aria-selected={range === r}
              aria-pressed={range === r}
              onClick={() => usePortfolio.getState().set({ range: r })}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      {load.state === 'loading' || load.state === 'idle' ? (
        <p className="pf-muted pf-pad">Loading price history…</p>
      ) : null}

      {sliced && sliced.points.length > 1 ? (
        <>
          <div className="pf-readout" aria-live="polite">
            <span>{cur ? fmtDay(cur.t) : ''}</span>
            <span>
              <i className="pf-key" />
              Portfolio <b className={`rs-num ${tone(cur?.portfolio)}`}>{fmtPct(cur?.portfolio)}</b>
            </span>
            {sliced.benchmarkReturn !== undefined ? (
              <span>
                <i className="pf-key bench" />
                {portfolio.benchmark}{' '}
                <b className={`rs-num ${tone(cur?.benchmark)}`}>{fmtPct(cur?.benchmark)}</b>
              </span>
            ) : null}
          </div>
          <div className="pf-chart-wrap">
            <Chart points={sliced.points} hover={hover} onHover={setHover} />
          </div>
          <div className="bt-stats">
            <Stat
              label="Return (time-weighted)"
              value={fmtPct(sliced.twr)}
              cls={tone(sliced.twr)}
            />
            {sliced.benchmarkReturn !== undefined ? (
              <>
                <Stat
                  label={`Benchmark ${portfolio.benchmark}`}
                  value={fmtPct(sliced.benchmarkReturn)}
                  cls={tone(sliced.benchmarkReturn)}
                />
                <Stat
                  label="Versus benchmark"
                  value={fmtPct(sliced.twr - sliced.benchmarkReturn)}
                  cls={tone(sliced.twr - sliced.benchmarkReturn)}
                />
              </>
            ) : null}
            <Stat label="Max drawdown" value={`${sliced.maxDrawdownPct.toFixed(2)}%`} />
            <Stat label="Value at end" value={fmtMoney(lastValue, base)} />
          </div>
        </>
      ) : load.state === 'ready' ? (
        <p className="pf-muted pf-pad">Not enough history yet: at least two days are needed.</p>
      ) : null}

      {result ? (
        <>
          <p className="pf-muted pf-note">
            {result.cashMode
              ? 'Value includes cash; deposits and withdrawals count as outside money, not return.'
              : 'No deposits or withdrawals are recorded, so value counts holdings only and buys and sells count as money moved in or out.'}
          </p>
          {cashFallback ? (
            <div className="pf-warn" role="status">
              Recorded cash did not cover the purchases, so this falls back to holdings only. Add
              the missing deposits for a cash-aware result.
            </div>
          ) : null}
          {result.missing.closes.length || failed.length ? (
            <div className="pf-warn" role="status">
              No price history for {[...new Set([...result.missing.closes, ...failed])].join(', ')};{' '}
              those positions are valued at their last trade price.
            </div>
          ) : null}
          {result.missing.fx.length ? (
            <div className="pf-warn" role="status">
              No exchange-rate history to {base} for {result.missing.fx.join(', ')}; that value is
              skipped.
            </div>
          ) : null}
          {portfolio.benchmark && load.state === 'ready' && !load.data.benchmark ? (
            <div className="pf-warn" role="status">
              Benchmark {portfolio.benchmark} could not be loaded.
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
