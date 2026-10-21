/** Dividend, split and earnings markers on the chart (group `events`, below the bars). */
import { isExpressionSymbol, PALETTE, type ChartMarker } from '@investopen/engine';
import { useReplayStore } from '../replay/store';
import type { ChartSession } from '../chart/session';
import { fetchEvents, type EventsResponse } from './api';
import { useEventPrefs, type EventPrefs } from './prefs';

export const EVENT_GROUP = 'events';

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Compact number: up to 4 decimals, no trailing zeros. */
const fmt = (v: number): string => String(Number(v.toFixed(4)));

/** "4:1" for a ratio of 4, "1:2" for 0.5 (new shares : old shares). */
export function splitLabel(ratio: number): string {
  if (ratio >= 1) return `${fmt(ratio)}:1`;
  return `1:${fmt(1 / ratio)}`;
}

/**
 * Markers of `data` for the enabled kinds. With `before` (replay clock), events
 * at or after it are left out: they have not happened yet. An earnings date
 * after `now` (unix seconds) reads as upcoming and is drawn past the last bar.
 */
export function buildEventMarkers(
  data: EventsResponse | null | undefined,
  prefs: EventPrefs,
  before: number = Infinity,
  now: number = Date.now() / 1000,
): ChartMarker[] {
  const out: ChartMarker[] = [];
  if (!data) return out;
  if (prefs.dividends)
    for (const d of data.dividends ?? []) {
      if (!num(d.t) || d.t >= before) continue;
      out.push({
        id: `div-${d.t}`,
        time: d.t,
        position: 'belowBar',
        color: PALETTE.cyan,
        shape: 'letter',
        text: 'D',
        tooltip: num(d.amount) ? `Dividend ${fmt(d.amount)}` : 'Dividend',
      });
    }
  if (prefs.splits)
    for (const s of data.splits ?? []) {
      if (!num(s.t) || s.t >= before || !num(s.ratio) || s.ratio <= 0) continue;
      out.push({
        id: `split-${s.t}`,
        time: s.t,
        position: 'belowBar',
        color: PALETTE.violet,
        shape: 'letter',
        text: 'S',
        tooltip: `Split ${splitLabel(s.ratio)}`,
      });
    }
  if (prefs.earnings)
    for (const e of data.earnings ?? []) {
      if (!num(e.t) || e.t >= before) continue;
      const parts = [e.t > now ? 'Earnings (upcoming)' : 'Earnings'];
      if (num(e.epsEstimate)) parts.push(`estimate ${fmt(e.epsEstimate)}`);
      if (num(e.epsActual)) parts.push(`actual ${fmt(e.epsActual)}`);
      if (num(e.surprisePercent))
        parts.push(`surprise ${e.surprisePercent > 0 ? '+' : ''}${fmt(e.surprisePercent)}%`);
      out.push({
        id: `earn-${e.t}`,
        time: e.t,
        position: 'belowBar',
        color: PALETTE.primary,
        shape: 'letter',
        text: 'E',
        tooltip: parts.join(' · '),
      });
    }
  return out;
}

/** Keep `chart`'s event markers in sync with the symbol, the toggles and the replay clock. */
export function attachEvents(session: Pick<ChartSession, 'id' | 'chart' | 'view'>): () => void {
  const { chart } = session;
  let data: EventsResponse | null = null;
  let token = 0;
  let disposed = false;

  const apply = () => {
    if (disposed) return;
    const replay = useReplayStore.getState();
    // On the replay chart, only events the replay clock has passed (other charts show all).
    const replaying =
      replay.status !== 'off' && Number.isFinite(replay.next) && replay.chartId === session.id;
    const before = replaying ? replay.next : Infinity;
    chart.setMarkers(EVENT_GROUP, buildEventMarkers(data, useEventPrefs.getState(), before));
  };

  const load = () => {
    const symbol = session.view.getState().symbol;
    const mine = ++token;
    data = null;
    apply();
    // No events exist for an expression or spread.
    if (isExpressionSymbol(symbol)) return;
    fetchEvents(symbol).then(
      (res) => {
        if (mine !== token) return;
        data = res;
        apply();
      },
      () => {
        // Unknown symbol or provider down: the chart simply has no event markers
        // (the Details panel shows the error for the same request).
        if (mine === token) data = null;
      },
    );
  };

  load();
  const offs = [
    useEventPrefs.subscribe(apply),
    session.view.subscribe((s, p) => {
      if (s.symbol !== p.symbol) load();
    }),
    useReplayStore.subscribe((s, p) => {
      if (s.status !== p.status || s.next !== p.next || s.chartId !== p.chartId) apply();
    }),
  ];
  return () => {
    disposed = true;
    token++;
    offs.forEach((off) => off());
    chart.setMarkers(EVENT_GROUP, []);
  };
}
