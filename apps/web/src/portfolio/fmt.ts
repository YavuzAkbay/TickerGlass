/** Number and date formatting for the portfolio panel (builds on the sidebar formatters). */
import { fmtPrice, fmtSigned, formatLocale, isNum } from '../sidebar/format';

/** Gain / loss colour class (jade / coral); '' for zero or missing. */
export const tone = (v: number | null | undefined): string =>
  !isNum(v) || v === 0 ? '' : v > 0 ? 'pf-up' : 'pf-down';

const DASH = '—';
const moneyCache = new Map<string, Intl.NumberFormat>();

function moneyFormat(currency: string): Intl.NumberFormat | null {
  const key = `${formatLocale()}|${currency}`;
  let nf = moneyCache.get(key);
  if (!nf) {
    try {
      nf = new Intl.NumberFormat(formatLocale(), { style: 'currency', currency });
    } catch {
      return null;
    }
    moneyCache.set(key, nf);
  }
  return nf;
}

/** `$1,234.50`; an unknown currency code falls back to `1,234.50 XYZ`. */
export function fmtMoney(v: number | null | undefined, currency: string): string {
  if (!isNum(v)) return DASH;
  const nf = moneyFormat(currency);
  return nf ? nf.format(v) : `${fmtPrice(v, 2)} ${currency}`;
}

/** `+$12.30` / `−$12.30` (U+2212), zero unsigned. */
export function fmtMoneySigned(v: number | null | undefined, currency: string): string {
  if (!isNum(v)) return DASH;
  const s = fmtMoney(Math.abs(v), currency);
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}${s}`;
}

/** Percent value (12.5 = 12.5 %) with a sign. */
export const fmtPct = (v: number | null | undefined): string =>
  isNum(v) ? fmtSigned(v, 2, '%') : DASH;

/** Share count: whole numbers plain, fractions up to 6 places. */
export function fmtQty(v: number | null | undefined): string {
  if (!isNum(v)) return DASH;
  return new Intl.NumberFormat(formatLocale(), { maximumFractionDigits: 6 }).format(v);
}

/** Weight 0..1 as `12.3%`. */
export const fmtWeight = (v: number | null | undefined): string =>
  isNum(v) ? `${fmtPrice(v * 100, 1)}%` : DASH;

export function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return DASH;
  return d.toLocaleDateString(formatLocale(), { year: 'numeric', month: 'short', day: 'numeric' });
}

export function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return DASH;
  return d.toLocaleString(formatLocale(), {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Unix seconds (a day's start, UTC) as a date. */
export const fmtDay = (t: number): string =>
  new Date(t * 1000).toLocaleDateString(formatLocale(), {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });

/** R multiple: `1.8R`, `−0.5R`. */
export const fmtR = (r: number | null | undefined): string =>
  isNum(r) ? `${r < 0 ? '−' : ''}${fmtPrice(Math.abs(r), 2)}R` : DASH;
