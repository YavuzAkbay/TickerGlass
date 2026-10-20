/** Fired-alert markers and price-alert lines on the chart (docs/alerts.md §5.5). */
import type { Alert, AlertLogEntry } from '@investopen/alerts';
import {
  canonicalSymbol,
  type Chart,
  type ChartMarker,
  type ChartPriceLine,
} from '@investopen/engine';
import { commands } from '../commands/registry';
import { useReplayStore } from '../replay/store';
import { useAppStore } from '../store/app';
import { useAlertPrefs } from './prefs';
import { openAlertLog, useAlerts } from './store';

export const ALERT_GROUP = 'alerts';
export const MAX_MARKERS = 500;
export const ALERT_COLOR = '#f5a623';

/** The chart symbol in the form alerts store it. */
function canon(symbol: string): string {
  try {
    return canonicalSymbol(symbol);
  } catch {
    return symbol;
  }
}

/** Active price alert (`price` crossing/greater/less a fixed value): the only kind that gets a line. */
export function alertLinePrice(a: Alert): number | null {
  const { left, condition } = a.spec;
  if (a.status !== 'active' || left.kind !== 'price') return null;
  if (!['crossing', 'crossingUp', 'crossingDown', 'greater', 'less'].includes(condition.op))
    return null;
  const right = (condition as { right?: { kind: string; value?: number } }).right;
  return right?.kind === 'value' && Number.isFinite(right.value) ? (right.value as number) : null;
}

/**
 * Newest 500 log entries of `symbol`, as markers. With `before` (replay clock),
 * fires of bars at or after it are left out: they have not happened yet.
 */
export function buildMarkers(
  log: readonly AlertLogEntry[],
  alerts: Readonly<Record<string, Alert>>,
  symbol: string,
  before: number = Infinity,
): ChartMarker[] {
  const out: ChartMarker[] = [];
  for (const e of log) {
    if (e.symbol !== symbol || e.barTime >= before) continue;
    if (out.length >= MAX_MARKERS) break;
    const priceLeft = e.alertId ? alerts[e.alertId]?.spec.left.kind === 'price' : false;
    const x = e.values?.x;
    const atPrice = priceLeft && typeof x === 'number' && Number.isFinite(x);
    out.push({
      id: String(e.id),
      time: e.barTime,
      position: atPrice ? 'price' : 'aboveBar',
      ...(atPrice ? { price: x } : {}),
      color: ALERT_COLOR,
      shape: 'bell',
      tooltip: e.message,
    });
  }
  return out;
}

export function buildLines(
  alerts: Readonly<Record<string, Alert>>,
  symbol: string,
): ChartPriceLine[] {
  const out: ChartPriceLine[] = [];
  for (const a of Object.values(alerts)) {
    if (a.symbol !== symbol) continue;
    const price = alertLinePrice(a);
    if (price === null) continue;
    out.push({
      id: a.id,
      paneId: 'main',
      price,
      color: ALERT_COLOR,
      lineStyle: 'dashed',
      label: a.name,
      axisLabel: true,
    });
  }
  return out;
}

/** Keep `chart`'s alert markers and lines in sync with the stores; wire the "+" button and clicks. */
export function attachAlerts(chart: Chart): () => void {
  const apply = () => {
    const prefs = useAlertPrefs.getState();
    const { log, alerts } = useAlerts.getState();
    const symbol = canon(useAppStore.getState().symbol);
    const replay = useReplayStore.getState();
    // During replay, only fires the replay clock has passed.
    const before = replay.status !== 'off' && Number.isFinite(replay.next) ? replay.next : Infinity;
    chart.setMarkers(ALERT_GROUP, prefs.markers ? buildMarkers(log, alerts, symbol, before) : []);
    chart.setPriceLines(ALERT_GROUP, prefs.lines ? buildLines(alerts, symbol) : []);
  };
  apply();
  const offs = [
    useAlerts.subscribe((s, p) => {
      if (s.log !== p.log || s.alerts !== p.alerts) apply();
    }),
    useAlertPrefs.subscribe((s, p) => {
      if (s.lines !== p.lines || s.markers !== p.markers) apply();
    }),
    useAppStore.subscribe((s, p) => {
      if (s.symbol !== p.symbol) apply();
    }),
    useReplayStore.subscribe((s, p) => {
      const on = s.status !== 'off';
      if (on !== (p.status !== 'off')) return apply();
      if (!on || s.next === p.next) return;
      // Only rebuild when the clock moved across a fire of this symbol.
      if (!Number.isFinite(s.next) || !Number.isFinite(p.next)) return apply();
      const lo = Math.min(s.next, p.next);
      const hi = Math.max(s.next, p.next);
      const symbol = canon(useAppStore.getState().symbol);
      if (
        useAlerts
          .getState()
          .log.some((e) => e.symbol === symbol && e.barTime >= lo && e.barTime < hi)
      )
        apply();
    }),
    chart.on('priceAxisPlus', ({ paneId, price }) =>
      commands.execute('alert.create', { price, paneId }),
    ),
    chart.on('markerClick', ({ group, id }) => {
      if (group === ALERT_GROUP && Number.isFinite(Number(id))) openAlertLog(Number(id));
    }),
    chart.on('priceLineClick', ({ group, id }) => {
      if (group === ALERT_GROUP) commands.execute('alert.edit', { id });
    }),
  ];
  return () => {
    offs.forEach((off) => off());
    chart.setMarkers(ALERT_GROUP, []);
    chart.setPriceLines(ALERT_GROUP, []);
  };
}
