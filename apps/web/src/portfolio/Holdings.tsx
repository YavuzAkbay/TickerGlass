import type { Ledger, Valuation, ValuationRow } from '@tickerglass/portfolio';
import { useMemo } from 'react';
import { commands } from '../commands/registry';
import type { Portfolio, Transaction } from '../api/portfolio';
import { currencyPrefix, fmtAuto } from '../sidebar/format';
import { fmtMoney, fmtMoneySigned, fmtPct, fmtQty, fmtWeight, tone } from './fmt';
import { usePortfolio } from './store';

/** Iris shades by rank for the allocation bar (neutral: colour carries no gain/loss here). */
const shade = (i: number): string =>
  `color-mix(in oklab, var(--accent) ${Math.max(18, 100 - i * 13)}%, var(--raised))`;

const MAX_SLICES = 8;

export interface Slice {
  label: string;
  weight: number;
}

/** Biggest weights first; the tail beyond MAX_SLICES collapses into "Other". */
export function allocationSlices(rows: readonly ValuationRow[]): Slice[] {
  const sorted = rows
    .filter((r) => r.weight !== null && r.weight > 0)
    .map((r) => ({ label: r.symbol, weight: r.weight as number }))
    .sort((a, b) => b.weight - a.weight);
  if (sorted.length <= MAX_SLICES) return sorted;
  const head = sorted.slice(0, MAX_SLICES - 1);
  const rest = sorted.slice(MAX_SLICES - 1).reduce((s, r) => s + r.weight, 0);
  return [...head, { label: 'Other', weight: rest }];
}

function Total({
  label,
  value,
  sub,
  value$,
  wide,
}: {
  label: string;
  value: string;
  sub?: string;
  value$?: number | null;
  wide?: boolean;
}) {
  return (
    <div className={`pf-total${wide ? ' wide' : ''}`}>
      <span className="pf-total-label">{label}</span>
      <span className={`pf-total-value ${tone(value$)}`}>{value}</span>
      {sub ? <span className={`pf-total-sub ${tone(value$)}`}>{sub}</span> : null}
    </div>
  );
}

interface Props {
  portfolio: Portfolio;
  transactions: readonly Transaction[];
  ledger: Ledger;
  valuation: Valuation;
}

export function Holdings({ portfolio, transactions, ledger, valuation }: Props) {
  const base = portfolio.baseCurrency;
  const tot = valuation.totals;
  const slices = useMemo(() => allocationSlices(valuation.rows), [valuation.rows]);
  const rows = useMemo(
    () => [...valuation.rows].sort((a, b) => (b.marketValueBase ?? -1) - (a.marketValueBase ?? -1)),
    [valuation.rows],
  );

  if (transactions.length === 0)
    return (
      <div className="rs-empty">
        <p className="rs-empty-title">No transactions yet</p>
        <p className="rs-empty-text">
          Add trades by hand or import a broker CSV, and your holdings appear here.
        </p>
        <button
          type="button"
          className="io-btn io-btn-primary rs-empty-btn"
          onClick={() => usePortfolio.getState().set({ tab: 'activity' })}
        >
          Go to Activity
        </button>
      </div>
    );

  return (
    <div>
      {ledger.issues.length ? (
        <div className="pf-warn" role="status">
          {ledger.issues.length} transaction{ledger.issues.length === 1 ? '' : 's'} could not be
          applied cleanly:
          <ul>
            {ledger.issues.slice(0, 3).map((i, k) => (
              <li key={`${i.txId}-${k}`}>{i.message}</li>
            ))}
            {ledger.issues.length > 3 ? <li>and {ledger.issues.length - 3} more</li> : null}
          </ul>
        </div>
      ) : null}
      {valuation.missingPrices.length ? (
        <div className="pf-warn" role="status">
          No live price for {valuation.missingPrices.join(', ')}; left out of the totals.
        </div>
      ) : null}
      {valuation.missingFx.length ? (
        <div className="pf-warn" role="status">
          No exchange rate to {base} for {valuation.missingFx.join(', ')}; those holdings and cash
          are left out of the totals.
        </div>
      ) : null}

      <div className="pf-totals">
        <Total
          wide
          label="Total value"
          value={fmtMoney(tot.totalValue, base)}
          sub={`${fmtMoney(tot.marketValue, base)} invested · ${fmtMoney(tot.cash, base)} cash`}
        />
        <Total
          label="Day change"
          value={fmtMoneySigned(tot.dayChange, base)}
          sub={fmtPct(tot.dayChangePct)}
          value$={tot.dayChange}
        />
        <Total
          label="Unrealized"
          value={fmtMoneySigned(tot.unrealized, base)}
          sub={fmtPct(tot.unrealizedPct)}
          value$={tot.unrealized}
        />
        <Total label="Realized" value={fmtMoneySigned(tot.realized, base)} value$={tot.realized} />
        <Total
          label="Dividends"
          value={fmtMoneySigned(tot.dividends, base)}
          value$={tot.dividends}
        />
        <Total
          wide
          label="Total return"
          value={fmtMoneySigned(tot.totalReturn, base)}
          sub="realized + unrealized + dividends + interest − fees"
          value$={tot.totalReturn}
        />
      </div>

      {slices.length ? (
        <>
          <div className="pf-alloc" role="img" aria-label="Allocation by symbol">
            {slices.map((s, i) => (
              <span
                key={s.label}
                title={`${s.label} ${fmtWeight(s.weight)}`}
                style={{ width: `${s.weight * 100}%`, background: shade(i) }}
              />
            ))}
          </div>
          <div className="pf-legend">
            {slices.slice(0, 5).map((s, i) => (
              <span key={s.label}>
                <i style={{ background: shade(i) }} />
                {s.label} {fmtWeight(s.weight)}
              </span>
            ))}
          </div>
        </>
      ) : null}

      <div className="pf-section">Positions</div>
      {rows.length ? (
        <ul className="pf-rows" aria-label="Positions">
          {rows.map((r) => (
            <li key={`${r.symbol}-${r.currency}`}>
              <button
                type="button"
                className="pf-row"
                title="Open on chart"
                onClick={() => commands.execute('chart.setSymbol', r.symbol)}
              >
                <span className="pf-row-sym">
                  {r.symbol} <span className="pf-muted">{fmtQty(r.quantity)} sh</span>
                </span>
                <span className="pf-row-r">{fmtMoney(r.marketValue, r.currency)}</span>
                <span className="pf-row-sub pf-row-wide">
                  avg {currencyPrefix(r.currency)}
                  {fmtAuto(r.avgCost)} · last {r.last === null ? 'n/a' : fmtAuto(r.last)}
                  {r.currency !== base ? ` ${r.currency}` : ''}
                </span>
                <span className={`pf-row-sub pf-row-r pf-row-wide ${tone(r.unrealized)}`}>
                  {fmtMoneySigned(r.unrealized, r.currency)} {fmtPct(r.unrealizedPct)} ·{' '}
                  {fmtWeight(r.weight)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="pf-muted pf-pad">No open positions.</p>
      )}

      {valuation.cash.length ? (
        <>
          <div className="pf-section">Cash</div>
          <ul className="pf-rows" aria-label="Cash">
            {valuation.cash.map((c) => (
              <li key={c.currency} className="pf-row">
                <span className="pf-row-sym">{c.currency}</span>
                <span className={`pf-row-r ${tone(c.amount)}`}>
                  {fmtMoney(c.amount, c.currency)}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}
