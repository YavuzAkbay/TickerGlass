/** Number/date formatting shared by the sidebar panels. */

const DASH = '—';
const FALLBACK_LOCALE = 'en-US';

let localeOverride: string | undefined;
const nfCache = new Map<string, Intl.NumberFormat>();

/** Number locale: the browser's (`navigator.language`), else en-US. */
export function formatLocale(): string {
  if (localeOverride) return localeOverride;
  return (typeof navigator !== 'undefined' && navigator.language) || FALLBACK_LOCALE;
}

/** Test hook: pin (or with no argument release) the number locale. */
export function setFormatLocale(locale?: string): void {
  localeOverride = locale;
}

/** Cached `Intl.NumberFormat` (construction is slow; tables format thousands of cells per tick). */
function numberFormat(min: number, max: number): Intl.NumberFormat {
  const locale = formatLocale();
  const key = `${locale}|${min}|${max}`;
  let nf = nfCache.get(key);
  if (!nf) {
    const opts = { minimumFractionDigits: min, maximumFractionDigits: max };
    try {
      nf = new Intl.NumberFormat(locale, opts);
    } catch {
      // Malformed locale tag: fall back rather than throwing in render.
      nf = new Intl.NumberFormat(FALLBACK_LOCALE, opts);
    }
    nfCache.set(key, nf);
  }
  return nf;
}

export const isNum = (v: number | null | undefined): v is number =>
  typeof v === 'number' && Number.isFinite(v);

/** Decimal places implied by a tick size (0.01 -> 2, 0.25 -> 2, 1 -> 0). */
export function decimalsForTick(minTick: number | null | undefined): number {
  if (!isNum(minTick) || minTick <= 0) return 2;
  let d = 0;
  while (d < 10 && Math.abs(Math.round(minTick * 10 ** d) - minTick * 10 ** d) > 1e-7) d++;
  return d;
}

export function fmtPrice(v: number | null | undefined, decimals = 2): string {
  if (!isNum(v)) return DASH;
  return numberFormat(decimals, decimals).format(v);
}

/** Price with sensible decimals when no tick size is known. */
export function fmtAuto(v: number | null | undefined): string {
  if (!isNum(v)) return DASH;
  const a = Math.abs(v);
  return fmtPrice(v, a >= 1000 ? 2 : a >= 1 ? 2 : a >= 0.01 ? 4 : 6);
}

export function fmtSigned(v: number | null | undefined, decimals = 2, suffix = ''): string {
  if (!isNum(v)) return DASH;
  const s = fmtPrice(Math.abs(v), decimals);
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}${s}${suffix}`;
}

/** Compact: 1.23K, 4.5M, 6.78B, 1.2T. */
export function fmtCompact(v: number | null | undefined): string {
  if (!isNum(v)) return DASH;
  const a = Math.abs(v);
  const units: [number, string][] = [
    [1e12, 'T'],
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ];
  for (const [n, u] of units) if (a >= n) return `${(v / n).toFixed(2)}${u}`;
  return numberFormat(0, 2).format(v);
}

/**
 * Market cap in USD, compact: `$1.2T`, `$350B`, `$42.5M`. One decimal below
 * 100 units, none from 100 up; below a million the plain amount.
 */
export function fmtCap(v: number | null | undefined): string {
  if (!isNum(v)) return DASH;
  const a = Math.abs(v);
  const units: [number, string][] = [
    [1e12, 'T'],
    [1e9, 'B'],
    [1e6, 'M'],
  ];
  for (const [n, u] of units) {
    if (a < n) continue;
    const x = v / n;
    const d = Math.abs(x) >= 100 ? 0 : 1;
    return `$${numberFormat(d, d).format(x)}${u}`;
  }
  return `$${numberFormat(0, 0).format(v)}`;
}

/** Ratio as a multiple: `1.80x`. */
export function fmtMultiple(v: number | null | undefined): string {
  if (!isNum(v)) return DASH;
  return `${numberFormat(2, 2).format(v)}x`;
}

/** Pence/cents quotes whose ISO code would print the major unit's symbol. */
const SUBUNIT_MARK: Record<string, string> = { GBp: 'p', GBX: 'p', ZAc: 'c', ILA: 'ag' };
const currencyCache = new Map<string, string>();

function currencyMark(currency: string, currencyDisplay: 'symbol' | 'narrowSymbol'): string {
  const parts = new Intl.NumberFormat(formatLocale(), {
    style: 'currency',
    currency,
    currencyDisplay,
  }).formatToParts(0);
  return parts.find((p) => p.type === 'currency')?.value ?? '';
}

/**
 * Mark to put before a price in `currency`; '' for USD, unknown or missing
 * currencies (a price is assumed to be dollars unless the quote says otherwise).
 */
export function currencyPrefix(currency: string | null | undefined): string {
  if (!currency || currency === 'USD') return '';
  const sub = SUBUNIT_MARK[currency];
  if (sub) return sub;
  const key = `${formatLocale()}|${currency}`;
  const hit = currencyCache.get(key);
  if (hit !== undefined) return hit;
  let mark: string;
  try {
    mark = currencyMark(currency, 'narrowSymbol');
    // The narrow form of many dollar/peso currencies is a bare `$`, which reads as USD:
    // use the distinguishing symbol (CA$, A$, HK$), else the ISO code.
    if (mark === '$') {
      mark = currencyMark(currency, 'symbol');
      if (mark === '$' || mark === '') mark = currency;
    }
  } catch {
    mark = '';
  }
  currencyCache.set(key, mark);
  return mark;
}

export function fmtInt(v: number | null | undefined): string {
  if (!isNum(v)) return DASH;
  return numberFormat(0, 0).format(Math.round(v));
}

export function changeClass(v: number | null | undefined): string {
  if (!isNum(v) || v === 0) return '';
  return v > 0 ? 'up' : 'down';
}

/** "just now", "5m ago", "3h ago", "2d ago", else a short date. */
export function relativeTime(unixSec: number | null | undefined, now: number): string {
  if (!isNum(unixSec)) return '';
  const s = Math.max(0, Math.floor(now / 1000 - unixSec));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d ago`;
  return new Date(unixSec * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** Resolve the app timezone setting to an IANA zone (undefined = browser local). */
export function resolveTimezone(
  setting: string,
  exchangeTz: string | null | undefined,
): string | undefined {
  if (setting === 'local') return undefined;
  if (setting === 'exchange') return exchangeTz ?? 'UTC';
  return setting;
}

export function makeDateFormatter(
  timeZone: string | undefined,
  withTime: boolean,
): Intl.DateTimeFormat {
  const opts: Intl.DateTimeFormatOptions = {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    ...(withTime ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' } : {}),
  };
  try {
    return new Intl.DateTimeFormat('en-US', { ...opts, ...(timeZone ? { timeZone } : {}) });
  } catch {
    // Unknown zone name: fall back to UTC rather than throwing in render.
    return new Intl.DateTimeFormat('en-US', { ...opts, timeZone: 'UTC' });
  }
}
