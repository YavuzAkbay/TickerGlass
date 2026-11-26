/** Number and time formatting for the brief: compact, unambiguous, locale-free. */

const DAY = 86_400;

/** Reads `arr[i]` as a number (NaN when out of range). */
export function at(arr: ArrayLike<number>, i: number): number {
  const v = arr[i];
  return v === undefined ? NaN : v;
}

/** Decimals that show the prices without losing their meaningful digits. */
export function inferPrecision(closes: ArrayLike<number>): number {
  let max = 0;
  for (let i = 0; i < closes.length; i++) {
    const v = Math.abs(at(closes, i));
    if (Number.isFinite(v) && v > max) max = v;
  }
  if (max >= 1) return 2;
  if (max >= 0.01) return 4;
  if (max >= 0.0001) return 6;
  return 8;
}

export function fmtPrice(v: number, decimals: number): string {
  return Number.isFinite(v) ? v.toFixed(decimals) : '';
}

/** Five significant digits, trailing zeros dropped (indicator values, ratios). */
export function fmtValue(v: number): string {
  if (!Number.isFinite(v)) return '';
  if (v === 0) return '0';
  const abs = Math.abs(v);
  if (abs >= 1e6) return fmtCompact(v);
  const s = abs >= 1e5 ? v.toFixed(0) : v.toPrecision(5);
  return s.includes('e') ? String(Number(s)) : s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

/** `52.1M`, `3.4K`, `812`. */
export function fmtCompact(v: number): string {
  if (!Number.isFinite(v)) return '';
  const abs = Math.abs(v);
  const units: [number, string][] = [
    [1e12, 'T'],
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ];
  for (const [size, unit] of units) {
    if (abs >= size) return `${trim((v / size).toFixed(abs / size >= 100 ? 0 : 1))}${unit}`;
  }
  return trim(v.toFixed(abs >= 100 ? 0 : 1));
}

export function fmtPct(v: number | null, signed = true): string {
  if (v === null || !Number.isFinite(v)) return 'n/a';
  const s = v.toFixed(Math.abs(v) >= 100 ? 0 : 2);
  return `${signed && v > 0 ? '+' : ''}${s}%`;
}

function trim(s: string): string {
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

/** True when the bars are closer than a day apart (show clock times). */
export function isIntraday(times: ArrayLike<number>): boolean {
  const gaps: number[] = [];
  for (let i = 1; i < times.length && gaps.length < 50; i++) {
    gaps.push(at(times, i) - at(times, i - 1));
  }
  if (gaps.length === 0) return false;
  gaps.sort((a, b) => a - b);
  return (gaps[Math.floor(gaps.length / 2)] ?? DAY) < DAY * 0.9;
}

export type TimeFormat = (t: number) => string;

/** `2026-03-12` or `2026-03-12 09:30` in `timezone` (UTC when the zone is unknown). */
export function timeFormatter(timezone: string, intraday: boolean): TimeFormat {
  let dtf: Intl.DateTimeFormat;
  const opts: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    ...(intraday ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' } : {}),
  };
  try {
    dtf = new Intl.DateTimeFormat('en-US', { ...opts, timeZone: timezone });
  } catch {
    dtf = new Intl.DateTimeFormat('en-US', { ...opts, timeZone: 'UTC' });
  }
  return (t) => {
    if (!Number.isFinite(t)) return '';
    const parts: Record<string, string> = {};
    for (const p of dtf.formatToParts(new Date(t * 1000))) parts[p.type] = p.value;
    const date = `${parts.year}-${parts.month}-${parts.day}`;
    return intraday ? `${date} ${parts.hour}:${parts.minute}` : date;
  };
}
