import type { Alert } from '@tickerglass/alerts';
import type { ChartMarker } from '@tickerglass/engine';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReplayAlerts, REPLAY_ALERT_GROUP } from './alerts';

const alert = (
  id: string,
  op: string,
  value: number,
  o: Partial<Alert> & { trigger?: string; field?: string } = {},
) =>
  ({
    id,
    name: `A-${id}`,
    symbol: 'AAPL',
    status: 'active',
    spec: {
      schemaVersion: 1,
      left: { kind: 'price', field: o.field ?? 'close' },
      condition: { op, right: { kind: 'value', value } },
      trigger: o.trigger ?? 'oncePerBar',
    },
    ...(o.status ? { status: o.status } : {}),
    ...(o.symbol ? { symbol: o.symbol } : {}),
  }) as unknown as Alert;

function setup(list: Alert[], sym: { value: string; interval?: string } = { value: 'AAPL' }) {
  let bar = { time: 100, open: 10, high: 10, low: 10, close: 10, volume: 1 };
  const markers: ChartMarker[][] = [];
  const notify = vi.fn();
  const alerts = new ReplayAlerts({
    alerts: () => Object.fromEntries(list.map((a) => [a.id, a])),
    symbol: () => sym.value,
    interval: () => sym.interval ?? '1D',
    lastBar: () => bar,
    setMarkers: (g, m) => {
      expect(g).toBe(REPLAY_ALERT_GROUP);
      markers.push([...m]);
    },
    notify,
  });
  /** Show a bar (same time = the forming bar updating) and step. */
  const at = (close: number, time = bar.time) => {
    bar = { time, open: close, high: close, low: close, close, volume: 1 };
    alerts.step();
  };
  const shown = () => markers.at(-1) ?? [];
  return { alerts, at, notify, shown };
}

let t = 100;
beforeEach(() => {
  t = 100;
});

describe('ReplayAlerts', () => {
  it('crossing up fires on the step that crosses, not before or after', () => {
    const { alerts, at, notify, shown } = setup([alert('a', 'crossingUp', 15)]);
    alerts.prime(); // close 10
    at(12, t++);
    expect(notify).not.toHaveBeenCalled();
    at(16, t++);
    expect(notify).toHaveBeenCalledWith('Replay: A-a');
    expect(shown()).toHaveLength(1);
    expect(shown()[0]).toMatchObject({ position: 'price', price: 16, shape: 'bell', time: 101 });
    at(17, t++);
    at(14, t++); // crossing down does not match crossingUp
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('crossing down and plain crossing', () => {
    const down = setup([alert('d', 'crossingDown', 8)]);
    down.alerts.prime();
    down.at(7, 101);
    expect(down.notify).toHaveBeenCalledTimes(1);
    const both = setup([alert('c', 'crossing', 10.5, { trigger: 'everyTime' })]);
    both.alerts.prime(); // 10
    both.at(11, 101);
    both.at(10, 102);
    expect(both.notify).toHaveBeenCalledTimes(2);
  });

  it('greater and less are states: the first sample after priming can fire', () => {
    const g = setup([alert('g', 'greater', 11)]);
    g.alerts.prime();
    g.at(11, 101);
    expect(g.notify).not.toHaveBeenCalled();
    g.at(12, 102);
    expect(g.notify).toHaveBeenCalledTimes(1);
    const l = setup([alert('l', 'less', 11)]);
    l.alerts.prime(); // priming never fires
    expect(l.notify).not.toHaveBeenCalled();
    l.at(10, 101);
    expect(l.notify).toHaveBeenCalledTimes(1);
  });

  it('fires at most once per bar, again on the next bar', () => {
    const { alerts, at, notify } = setup([alert('a', 'crossing', 15, { trigger: 'everyTime' })]);
    alerts.prime();
    at(16, 101); // up
    at(14, 101); // down within the same bar: suppressed
    at(16, 101); // up again, same bar
    expect(notify).toHaveBeenCalledTimes(1);
    at(14, 102); // next bar crosses down
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("'once' alerts fire once per session", () => {
    const { alerts, at, notify } = setup([alert('a', 'crossing', 15, { trigger: 'once' })]);
    alerts.prime();
    at(16, 101);
    at(14, 102);
    at(16, 103);
    expect(notify).toHaveBeenCalledTimes(1);
    alerts.reset();
    alerts.prime(); // close 16
    at(14, 104);
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('reset clears markers and samples (seek, exit)', () => {
    const { alerts, at, notify, shown } = setup([alert('a', 'crossingUp', 15)]);
    alerts.prime();
    at(16, 101);
    expect(shown()).toHaveLength(1);
    alerts.reset();
    expect(shown()).toHaveLength(0);
    // No previous sample after a reset: an edge cannot fire on the first step.
    at(20, 102);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('only evaluates active price alerts of the chart symbol', () => {
    const { alerts, at, notify } = setup([
      alert('p', 'crossingUp', 15, { status: 'paused' as Alert['status'] }),
      alert('o', 'crossingUp', 15, { symbol: 'MSFT' }),
      {
        ...alert('i', 'crossingUp', 15),
        spec: {
          left: { kind: 'indicator' },
          condition: { op: 'crossingUp', right: { kind: 'value', value: 15 } },
          trigger: 'once',
        },
      } as unknown as Alert,
      {
        ...alert('c', 'crossingUp', 15),
        spec: {
          left: { kind: 'price', field: 'close' },
          condition: { op: 'crossingUp', right: { kind: 'price', field: 'open' } },
          trigger: 'once',
        },
      } as unknown as Alert,
    ]);
    alerts.prime();
    at(16, 101);
    expect(notify).not.toHaveBeenCalled();
  });

  it('uses the alert price field', () => {
    const { alerts, notify } = setup([alert('a', 'greater', 5, { field: 'high' })]);
    alerts.prime();
    alerts.step();
    expect(notify).toHaveBeenCalledTimes(1); // high 10 > 5
  });

  it('forgets samples across a symbol or interval switch (A -> B -> A)', () => {
    const sym = { value: 'AAPL', interval: '1D' };
    const { alerts, at, notify } = setup([alert('a', 'crossingUp', 15)], sym);
    alerts.prime();
    at(12, 101); // sample on AAPL: 12, below 15
    sym.value = 'MSFT';
    at(30, 102); // other symbol, its alerts do not apply
    sym.value = 'AAPL';
    at(16, 103); // first AAPL sample after the switch: no previous sample, no crossing
    expect(notify).not.toHaveBeenCalled();
    at(14, 104);
    at(17, 105); // a real crossing still fires
    expect(notify).toHaveBeenCalledTimes(1);
    sym.interval = '5m';
    at(10, 106);
    sym.interval = '1D';
    at(16, 107); // interval round trip: same rule
    expect(notify).toHaveBeenCalledTimes(1);
  });
});
