import {
  evaluateCondition,
  isPriceAlert,
  priceValue,
  type Alert,
  type CrossCondition,
  type SampleValues,
} from '@tickerglass/alerts';
import { canonicalSymbol, type ChartMarker } from '@tickerglass/engine';
import { ALERT_COLOR } from '../alerts/attach';

export const REPLAY_ALERT_GROUP = 'replay-alerts';

interface Bar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface ReplayAlertsDeps {
  /** Alerts as the alert store holds them. */
  alerts: () => Readonly<Record<string, Alert>>;
  /** Chart symbol. */
  symbol: () => string;
  /** The forming (last revealed) bar of the chart, or null. */
  lastBar: () => Bar | null;
  setMarkers: (group: string, markers: readonly ChartMarker[]) => void;
  /** User-facing notice (toast). */
  notify: (message: string) => void;
}

function canon(symbol: string): string {
  try {
    return canonicalSymbol(symbol);
  } catch {
    return symbol;
  }
}

/**
 * Replay-local evaluation of price alerts on the chart symbol (docs/replay.md).
 * Each step takes one sample (x = price field of the forming bar, y = the alert's
 * constant) and compares it with the previous one. A fire adds a marker and a
 * toast; nothing is delivered or logged. At most one fire per alert and bar,
 * and a 'once' alert fires once per session.
 */
export class ReplayAlerts {
  private prev = new Map<string, SampleValues>();
  private firedBar = new Map<string, number>();
  private done = new Set<string>();
  private markers: ChartMarker[] = [];

  constructor(private readonly deps: ReplayAlertsDeps) {}

  /** New session (start or seek): forget samples and fires, clear the markers. */
  reset(): void {
    this.prev.clear();
    this.firedBar.clear();
    this.done.clear();
    this.setMarkers([]);
  }

  /** Record the current samples without firing (the state a session starts from). */
  prime(): void {
    this.sample(false);
  }

  /** A step revealed more data: evaluate. */
  step(): void {
    this.sample(true);
  }

  private setMarkers(list: ChartMarker[]): void {
    this.markers = list;
    this.deps.setMarkers(REPLAY_ALERT_GROUP, list);
  }

  private sample(fire: boolean): void {
    const bar = this.deps.lastBar();
    if (!bar) return;
    const symbol = canon(this.deps.symbol());
    const added: ChartMarker[] = [];
    for (const a of Object.values(this.deps.alerts())) {
      if (a.status !== 'active' || canon(a.symbol) !== symbol || !isPriceAlert(a.spec)) continue;
      const cond = a.spec.condition as CrossCondition;
      const right = cond.right;
      if (right.kind !== 'value' || a.spec.left.kind !== 'price') continue;
      const cur: SampleValues = {
        x: priceValue(a.spec.left.field, bar),
        y: right.value,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
      };
      const prev = this.prev.get(a.id) ?? null;
      this.prev.set(a.id, cur);
      if (!fire || this.done.has(a.id) || this.firedBar.get(a.id) === bar.time) continue;
      if (!evaluateCondition(cond, prev, cur)) continue;
      this.firedBar.set(a.id, bar.time);
      if (a.spec.trigger === 'once') this.done.add(a.id);
      added.push({
        id: `${a.id}@${bar.time}`,
        time: bar.time,
        position: 'price',
        price: cur.x,
        color: ALERT_COLOR,
        shape: 'bell',
        tooltip: `Replay: ${a.name}`,
      });
      this.deps.notify(`Replay: ${a.name}`);
    }
    if (added.length) this.setMarkers([...this.markers, ...added]);
  }
}
