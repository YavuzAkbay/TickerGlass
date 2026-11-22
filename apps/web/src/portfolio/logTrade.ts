/** Prefill for "Log trade for current symbol". Pure. */
import { subunitOf, toLedgerUnit } from './subunit';

export interface TradePrefill {
  symbol: string;
  currency: string;
  /** null when the live price cannot be trusted as a price in `currency`. */
  price: number | null;
}

/** Live quotes carry float noise (193.00653853790826); keep 7 significant digits for the field. */
const tidy = (n: number): number => Number(n.toPrecision(7));

/**
 * Symbol, currency and price for a new buy. A sub-unit quote currency (GBp, ZAc, ILA) becomes
 * its major unit (GBP, ZAR, ILS) with the price divided by 100. Only a currency that is not a
 * 3-letter code falls back to the portfolio's base currency and an empty price.
 */
export function tradePrefill(
  symbol: string,
  symbolCurrency: string | null | undefined,
  last: number | null | undefined,
  baseCurrency: string,
): TradePrefill {
  const ccy = symbolCurrency?.trim() ?? '';
  const major = subunitOf(ccy)?.major ?? null;
  const iso = major ?? (/^[A-Za-z]{3}$/.test(ccy) ? ccy.toUpperCase() : null);
  const valid = typeof last === 'number' && Number.isFinite(last) && last >= 0;
  return {
    symbol: symbol.trim().toUpperCase(),
    currency: iso ?? baseCurrency,
    price: iso !== null && valid ? tidy(toLedgerUnit(last, ccy, iso)) : null,
  };
}
