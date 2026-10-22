/**
 * The Timeline panel's rows: alert fires, news and corporate events of a symbol
 * (or the watchlist) merged into one list. Pure; the panel fetches the inputs.
 */
import type { AlertLogEntry } from '@tickerglass/alerts';
import type { NewsItem } from '../api/types';
import type { EventsResponse } from '../events/api';
import { fmtPrice, fmtSigned, isNum } from '../sidebar/format';

export type TimelineKind = 'alert' | 'news' | 'earnings' | 'dividend' | 'split';

export interface TimelineRow {
  key: string;
  kind: TimelineKind;
  /** Unix seconds. */
  t: number;
  title: string;
  detail: string;
  symbol: string | null;
  url?: string;
  /** Alert log entry to open. */
  entryId?: number;
}

/** "4:1" for a ratio of 4, "1:2" for 0.5. */
export function fmtRatio(r: number | null): string {
  if (!isNum(r) || r <= 0) return '—';
  return r >= 1 ? `${+r.toFixed(4)}:1` : `1:${+(1 / r).toFixed(4)}`;
}

/** Earnings, dividends and splits as rows. */
export function eventRows(ev: EventsResponse, symbol: string): TimelineRow[] {
  const rows: TimelineRow[] = [];
  for (const e of ev.earnings ?? []) {
    const parts: string[] = [];
    if (isNum(e.epsActual)) parts.push(`EPS ${fmtPrice(e.epsActual)}`);
    if (isNum(e.epsEstimate)) parts.push(`est. ${fmtPrice(e.epsEstimate)}`);
    if (isNum(e.surprisePercent)) parts.push(fmtSigned(e.surprisePercent, 1, '%'));
    rows.push({
      key: `e${e.t}`,
      kind: 'earnings',
      t: e.t,
      title: 'Earnings',
      detail: parts.join(' · '),
      symbol,
    });
  }
  for (const d of ev.dividends ?? [])
    rows.push({
      key: `d${d.t}`,
      kind: 'dividend',
      t: d.t,
      title: 'Dividend',
      detail: isNum(d.amount) ? fmtPrice(d.amount, 4) : '',
      symbol,
    });
  for (const s of ev.splits ?? [])
    rows.push({
      key: `s${s.t}`,
      kind: 'split',
      t: s.t,
      title: 'Split',
      detail: fmtRatio(s.ratio),
      symbol,
    });
  return rows;
}

export function newsRows(items: readonly NewsItem[]): TimelineRow[] {
  return items.flatMap((n, i) =>
    isNum(n.time)
      ? [
          {
            key: `n${n.id}|${i}`,
            kind: 'news' as const,
            t: n.time,
            title: n.title,
            detail: n.publisher ?? '',
            symbol: n.symbol ?? null,
            url: n.url,
          },
        ]
      : [],
  );
}

export function alertRows(
  log: readonly AlertLogEntry[],
  symbols: ReadonlySet<string>,
): TimelineRow[] {
  return log.flatMap((e) => {
    const t = Date.parse(e.firedAt) / 1000;
    if (!Number.isFinite(t) || !symbols.has(e.symbol.toUpperCase())) return [];
    return [
      {
        key: `a${e.id}`,
        kind: 'alert' as const,
        t,
        title: e.alertName,
        detail: e.message,
        symbol: e.symbol,
        entryId: e.id,
      },
    ];
  });
}

/** Rows older than this are left out (events go back decades). */
export const TIMELINE_DAYS = 365;
export const TIMELINE_MAX = 80;

/** Upcoming events (soonest first), then the past (newest first), within the window. */
export function buildTimeline(
  rows: readonly TimelineRow[],
  nowSec: number,
): { upcoming: TimelineRow[]; past: TimelineRow[] } {
  const from = nowSec - TIMELINE_DAYS * 86_400;
  const upcoming = rows.filter((r) => r.t > nowSec).sort((a, b) => a.t - b.t);
  const past = rows
    .filter((r) => r.t <= nowSec && r.t >= from)
    .sort((a, b) => b.t - a.t)
    .slice(0, TIMELINE_MAX);
  return { upcoming: upcoming.slice(0, 5), past };
}
