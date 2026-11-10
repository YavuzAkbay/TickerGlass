/** Pure helpers of the symbol detail sections (dates, links, events, returns). */
import type { MessageKey, MessageParams } from '../i18n';
import type { DividendEvent, EarningsEvent, EventsResponse, SplitEvent } from '../events/api';

export type Translate = (key: MessageKey, params?: MessageParams) => string;

const DAY_S = 86_400;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** `v` when it is a finite number, else null (upstream JSON is not trusted to be typed). */
export const finiteOrNull = (v: unknown): number | null => (isNum(v) ? v : null);

/** `v` when it is a non-blank string, else an em dash. */
export const textOrDash = (v: unknown): string => (typeof v === 'string' && v.trim() ? v : '—');

/**
 * `url` when it is an absolute http(s) link, else null. News links come from an upstream feed:
 * `javascript:`, `data:` and the like must never reach an `href`.
 */
export function safeHttpUrl(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (!trimmed || trimmed.length > 2048) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (!parsed.hostname) return null;
  return parsed.href;
}

/** Upstream text for display: control characters dropped, whitespace collapsed, clipped. */
export function plainText(value: unknown, max = 300): string {
  if (typeof value !== 'string') return '';
  const flat = value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** "5m ago", "3h ago", "2d ago", else a short date; empty without a time. */
export function relativeTime(
  unixSec: number | null | undefined,
  nowMs: number,
  t: Translate,
): string {
  if (!isNum(unixSec)) return '';
  const s = Math.max(0, Math.floor(nowMs / 1000 - unixSec));
  if (s < 60) return t('si.agoNow');
  if (s < 3600) return t('si.agoMin', { n: Math.floor(s / 60) });
  if (s < DAY_S) return t('si.agoHour', { n: Math.floor(s / 3600) });
  if (s < 7 * DAY_S) return t('si.agoDay', { n: Math.floor(s / DAY_S) });
  return new Date(unixSec * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * Event times are unix seconds, usually midnight UTC of the calendar date: read those in UTC
 * (a US browser would show the day before), anything with a time of day in local time.
 */
const atUtcMidnight = (unixSec: number): boolean => unixSec % DAY_S === 0;

/** Calendar day of an event time as days since the epoch. */
function dayNumber(unixSec: number): number {
  if (atUtcMidnight(unixSec)) return unixSec / DAY_S;
  const d = new Date(unixSec * 1000);
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000;
}

function todayNumber(nowMs: number): number {
  const d = new Date(nowMs);
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000;
}

/** Whole calendar days from today to the event day (negative: in the past). */
export function daysUntil(unixSec: number, nowMs: number): number {
  return Math.round(dayNumber(unixSec) - todayNumber(nowMs));
}

export function fmtEventDate(unixSec: number): string {
  return new Date(unixSec * 1000).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    ...(atUtcMidnight(unixSec) ? { timeZone: 'UTC' } : {}),
  });
}

/** "today", "tomorrow", "in 6 days", "yesterday", "12 days ago". */
export function daysLabel(days: number, t: Translate): string {
  if (days === 0) return t('si.today');
  if (days === 1) return t('si.tomorrow');
  if (days === -1) return t('si.yesterday');
  return days > 0 ? t('si.inDays', { n: days }) : t('si.daysAgo', { n: -days });
}

/** The earliest earnings event that is today or later. */
export function nextEarnings(
  events: EventsResponse | undefined,
  nowMs: number,
): EarningsEvent | null {
  let best: EarningsEvent | null = null;
  for (const e of events?.earnings ?? []) {
    if (!isNum(e.t) || daysUntil(e.t, nowMs) < 0) continue;
    if (!best || e.t < best.t) best = e;
  }
  return best;
}

/** Dividend events: the next one still ahead, else the latest one behind. */
export function dividendEvent(
  events: EventsResponse | undefined,
  nowMs: number,
): { event: DividendEvent; upcoming: boolean } | null {
  const list = (events?.dividends ?? []).filter((d) => isNum(d.t));
  let next: DividendEvent | null = null;
  let last: DividendEvent | null = null;
  for (const d of list) {
    if (daysUntil(d.t, nowMs) >= 0) {
      if (!next || d.t < next.t) next = d;
    } else if (!last || d.t > last.t) last = d;
  }
  if (next) return { event: next, upcoming: true };
  return last ? { event: last, upcoming: false } : null;
}

/** The most recent split. */
export function lastSplit(events: EventsResponse | undefined): SplitEvent | null {
  let best: SplitEvent | null = null;
  for (const s of events?.splits ?? []) if (isNum(s.t) && (!best || s.t > best.t)) best = s;
  return best;
}

/** 4 -> "4:1", 0.5 -> "1:2", 1.5 -> "3:2"; "—" without a usable ratio. */
export function fmtSplitRatio(ratio: number | null | undefined): string {
  if (!isNum(ratio) || ratio <= 0) return '—';
  if (ratio >= 1) {
    const whole = Number.isInteger(ratio) ? ratio : Number(ratio.toFixed(2));
    for (const d of [1, 2, 3, 4, 5]) {
      const n = whole * d;
      if (Math.abs(n - Math.round(n)) < 1e-6) return `${Math.round(n)}:${d}`;
    }
    return `${whole}:1`;
  }
  const inv = 1 / ratio;
  return Math.abs(inv - Math.round(inv)) < 1e-6
    ? `1:${Math.round(inv)}`
    : `1:${Number(inv.toFixed(2))}`;
}

/** Period return, recomputed from the live price when the base close is usable. */
export function periodReturn(
  live: number | null | undefined,
  baseClose: number | null | undefined,
  serverPercent: number | null | undefined,
): number | null {
  if (isNum(live) && isNum(baseClose) && baseClose > 0) return (live / baseClose - 1) * 100;
  return isNum(serverPercent) ? serverPercent : null;
}

/** Position of `value` within [low, high] as 0..100, null when it cannot be placed. */
export function rangePercent(
  value: number | null | undefined,
  low: number | null | undefined,
  high: number | null | undefined,
): number | null {
  if (!isNum(value) || !isNum(low) || !isNum(high) || high <= low) return null;
  return Math.max(0, Math.min(100, ((value - low) / (high - low)) * 100));
}
