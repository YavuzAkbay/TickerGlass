import { computeLedger, valuate, type Ledger, type Valuation } from '@tickerglass/portfolio';
import { useMemo } from 'react';
import type { Portfolio, Transaction } from '../api/portfolio';
import { useLiveQuotes } from '../quotes/hooks';
import { foreignCurrencies, fxSymbol, toTxs } from './model';
import { toLedgerUnit } from './subunit';

/** Ledger of the portfolio's transactions with its cost method. */
export function useLedger(portfolio: Portfolio | null, rows: readonly Transaction[]): Ledger {
  const method = portfolio?.costMethod ?? 'fifo';
  return useMemo(() => computeLedger(toTxs(rows), { costMethod: method }), [rows, method]);
}

/**
 * Live valuation: last prices of the open positions and FX pairs (`{CCY}{BASE}=X`) from the
 * quote stream, converted into the base currency. Sub-unit quotes (GBp, ZAc, ILA) are rescaled
 * to the position's major currency first.
 */
export function useValuation(portfolio: Portfolio | null, ledger: Ledger): Valuation {
  const base = portfolio?.baseCurrency ?? 'USD';
  const { held, fxSyms } = useMemo(() => {
    const open = ledger.positions.filter((p) => p.quantity > 0);
    const ccys = new Set<string>(open.map((p) => p.currency));
    for (const c of Object.keys(ledger.cash)) ccys.add(c);
    return {
      held: open.map((p) => ({ symbol: p.symbol, currency: p.currency })),
      fxSyms: foreignCurrencies(
        [...ccys].map((currency) => ({ currency })),
        base,
      ).map((c) => fxSymbol(c, base)),
    };
  }, [ledger, base]);
  const symbols = useMemo(() => [...held.map((h) => h.symbol), ...fxSyms], [held, fxSyms]);
  const quotes = useLiveQuotes(symbols);
  return useMemo(() => {
    const prices: Record<string, number | undefined> = {};
    const prev: Record<string, number | undefined> = {};
    for (const { symbol: s, currency } of held) {
      const q = quotes[s];
      // LSE/JSE/TASE quote in pence/cents/agorot; the ledger is usually in the major unit.
      prices[s] = toLedgerUnit(q?.last ?? undefined, q?.currency, currency);
      prev[s] = toLedgerUnit(q?.prevClose ?? undefined, q?.currency, currency);
    }
    return valuate(
      ledger,
      prices,
      (ccy) => quotes[fxSymbol(ccy, base)]?.last ?? undefined,
      base,
      prev,
    );
  }, [ledger, quotes, held, base]);
}
