/**
 * Sub-unit quote currencies. Yahoo quotes LSE symbols in pence (GBp / GBX), JSE in cents (ZAc /
 * ZAC) and TASE in agorot (ILA): prices and bars are 100x the ISO major unit. A ledger kept in
 * the major unit (GBP, ZAR, ILS) needs the quote divided by 100. Pure.
 */

const SUBUNITS: Readonly<Record<string, { major: string; divisor: number }>> = {
  GBp: { major: 'GBP', divisor: 100 },
  GBX: { major: 'GBP', divisor: 100 },
  ZAc: { major: 'ZAR', divisor: 100 },
  ZAC: { major: 'ZAR', divisor: 100 },
  ILA: { major: 'ILS', divisor: 100 },
};

/** The ISO major unit and divisor of a sub-unit quote currency; null for anything else. */
export function subunitOf(
  quoteCurrency: string | null | undefined,
): { major: string; divisor: number } | null {
  const c = quoteCurrency?.trim();
  return c ? (SUBUNITS[c] ?? null) : null;
}

/**
 * Multiplier turning a price quoted in `quoteCurrency` into `ledgerCurrency` units: 1/100 when
 * the quote is a sub-unit of the ledger's major currency, otherwise 1 (same currency, unknown
 * quote currency, or a pair this cannot convert).
 */
export function unitFactor(
  quoteCurrency: string | null | undefined,
  ledgerCurrency: string | null | undefined,
): number {
  const sub = subunitOf(quoteCurrency);
  if (!sub || !ledgerCurrency) return 1;
  return ledgerCurrency.trim() === sub.major ? 1 / sub.divisor : 1;
}

/** `price` in `ledgerCurrency` units; null/undefined/non-finite pass through unchanged. */
export function toLedgerUnit<T extends number | null | undefined>(
  price: T,
  quoteCurrency: string | null | undefined,
  ledgerCurrency: string | null | undefined,
): T {
  if (typeof price !== 'number' || !Number.isFinite(price)) return price;
  const f = unitFactor(quoteCurrency, ledgerCurrency);
  return (f === 1 ? price : price * f) as T;
}
