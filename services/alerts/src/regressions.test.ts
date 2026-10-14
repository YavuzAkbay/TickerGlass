import { afterEach, describe, expect, it } from 'vitest';
import type { AlertSpec } from '@investopen/alerts';
import { BAR_T, bar, harness, makeAlert, minuteBars, until, type Harness } from './test-utils';

let h: Harness | null = null;
afterEach(async () => {
  if (h) {
    await h.stop();
    await h.api.close();
    h = null;
  }
});

const price = (value: number, trigger: AlertSpec['trigger'] = 'everyTime'): AlertSpec => ({
  schemaVersion: 1,
  left: { kind: 'price', field: 'close' },
  condition: { op: 'greater', right: { kind: 'value', value } },
  trigger,
});

const drawingSpec: AlertSpec = {
  schemaVersion: 1,
  left: { kind: 'price', field: 'close' },
  condition: {
    op: 'greater',
    right: { kind: 'drawing', drawingId: 'd1', part: 'line', scale: 'linear' },
  },
  trigger: 'everyTime',
};
const hline = (price: number, time = BAR_T - 600) => ({
  id: 'd1',
  symbol: 'TEST',
  data: { id: 'd1', type: 'horizontal-line', points: [{ time, price }], style: {} },
});

async function setup(
  alerts = [makeAlert()],
  closes = [98, 99, 99],
  env: Record<string, string> = {},
): Promise<Harness> {
  h = await harness({ env });
  h.api.alerts = alerts;
  h.feed.setBars('TEST', '1m', minuteBars(BAR_T, closes));
  await h.start();
  return h;
}

const tick = async (p: number, t = BAR_T) => {
  h!.feed.emit('TEST', 1, bar(t, p));
  await h!.service.whenIdle();
};

// Private hooks of Series used to reproduce timing-dependent paths deterministically.
interface SeriesPrivate {
  closeBar(barTime: number, at: number): Promise<void>;
  runnerFailure(r: unknown, err: unknown): void;
}

describe('review regressions', () => {
  it('#1 a deleted drawing (listed only in `deleted`) puts the alert into error', async () => {
    h = await harness();
    h.api.alerts = [makeAlert({ spec: drawingSpec, drawingId: 'd1' })];
    h.api.drawings = [hline(100)];
    h.feed.setBars('TEST', '1m', minuteBars(BAR_T, [98, 99, 99]));
    await h.start();
    expect(h.api.statuses).toHaveLength(0);
    h.api.drawings = [];
    h.control.drawingsChanged([], ['d1']);
    await until(() => h!.api.statuses.length === 1, 'error status');
    expect(h.api.statuses[0]!.body).toMatchObject({ status: 'error', reason: 'drawing not found' });
  });

  it('#2 shutdown persists unsent fires; the next start re-sends them with the same fireId', async () => {
    await setup();
    h!.api.fireScript = Array.from({ length: 20 }, () => ({ status: 0, drop: true }));
    await tick(101);
    await h!.clock.advance(100);
    expect(h!.api.fires).toHaveLength(0);
    expect(h!.service.fires.pending).toBe(1);
    const stopping = h!.service.stop();
    await h!.clock.advance(4500);
    await stopping;
    const rows = h!.api.putStates.at(-1)!;
    const pending = rows.find((r) => r.alertId === 'a1')?.state.pendingFires;
    expect(pending).toHaveLength(1);
    const fireId = pending![0]!.body.fireId;

    h!.api.fireScript = [];
    await h!.restart();
    await until(() => h!.api.fires.length === 1, 're-sent fire');
    expect(h!.api.fires[0]!.body.fireId).toBe(fireId);
  });

  it('#2 shutdown waits for in-flight fires instead of dropping them', async () => {
    await setup();
    await tick(101);
    await h!.service.stop();
    expect(h!.api.fires).toHaveLength(1);
  });

  it('#2 persisted pendingFires stay bounded (count and size)', async () => {
    await setup();
    h!.api.fireScript = Array.from({ length: 200 }, () => ({ status: 0, drop: true }));
    for (let k = 0; k < 40; k++)
      h!.service.fires.enqueue({
        alertId: 'a1',
        revision: 1,
        body: { fireId: `f${k}`, revision: 1, message: 'x'.repeat(600) } as never,
      });
    await h!.clock.advance(100);
    expect(h!.service.fires.pending).toBeGreaterThan(20);
    const stopping = h!.service.stop();
    await h!.clock.advance(4500);
    await stopping;
    const st = h!.api.putStates.at(-1)!.find((r) => r.alertId === 'a1')!.state;
    expect(st.pendingFires!.length).toBeLessThanOrEqual(20);
    expect(JSON.stringify(st).length).toBeLessThan(12 * 1024);
  });

  it('#4 the periodic resync and a reconnect refetch drawings', async () => {
    h = await harness();
    h.api.alerts = [makeAlert({ spec: drawingSpec, drawingId: 'd1' })];
    h.api.drawings = [hline(100)];
    h.feed.setBars('TEST', '1m', minuteBars(BAR_T, [98, 99, 99]));
    await h.start();
    h.api.drawings = [hline(120)];
    h.control.connection(false);
    h.control.connection(true);
    await h.service.whenIdle();
    await tick(130);
    await until(() => h!.api.fires.length >= 1, 'fire at the moved level');
    expect(h.api.fires.at(-1)!.body.values.y).toBe(120);
    h.api.drawings = [hline(140)];
    await h.clock.advance(60_000);
    await h.service.whenIdle();
    await tick(150);
    await until(() => h!.api.fires.at(-1)!.body.values.y === 140, 'periodic refetch');
  });

  const avwap = (anchor: number): AlertSpec => ({
    schemaVersion: 1,
    left: {
      kind: 'indicator',
      ref: {
        instances: [{ id: 'v', type: 'anchored-vwap', inputs: { anchor, source: 'close' } }],
        instanceId: 'v',
        outputId: 'vwap',
        title: 'AVWAP',
      },
    },
    condition: { op: 'greater', right: { kind: 'value', value: 1e9 } },
    trigger: 'everyTime',
  });

  it('#5 an anchored-VWAP anchor extends the history load', async () => {
    await setup([makeAlert({ spec: avwap(BAR_T - 3000 * 60) })], [98, 99, 99]);
    expect(h!.feed.getBarsCalls[0]!.limit).toBe(5000);
    h!.feed.getBarsCalls.length = 0;
    await h!.stop();
    await h!.api.close();
    h = null;
    await setup([makeAlert({ spec: price(1e9) })]);
    expect(h!.feed.getBarsCalls[0]!.limit).toBeLessThan(5000);
  });

  it('#6 a drawing moved before the loaded history reloads further back', async () => {
    h = await harness();
    h.api.alerts = [makeAlert({ spec: drawingSpec, drawingId: 'd1' })];
    h.api.drawings = [hline(100)];
    h.feed.setBars(
      'TEST',
      '1m',
      minuteBars(
        BAR_T,
        Array.from({ length: 7000 }, () => 99),
      ),
    );
    await h.start();
    const s = h.service.series()[0]!;
    expect(s.length).toBe(5000);
    h.api.drawings = [hline(100, BAR_T - 6000 * 60)];
    h.control.drawingsChanged(['d1']);
    await h.service.whenIdle();
    await until(() => s.length > 6000, 'extended history');
  });

  it('#7 a fired once alert does not fire again after the series reloads', async () => {
    await setup([makeAlert({ spec: price(100, 'once') })], [98, 99, 99]);
    await tick(101);
    await until(() => h!.api.fires.length === 1, 'once fire');
    const s = h!.service.series()[0]!;
    const runner = [...s.runners.values()][0]!;
    expect(runner.done).toBe(true);
    // A history reload re-seeds every runner of the series.
    (s as unknown as { serial(fn: () => Promise<void>): void }).serial(() =>
      (s as unknown as { load(): Promise<void> }).load(),
    );
    await s.whenIdle();
    expect(runner.done).toBe(true);
    await tick(105);
    await h!.service.whenIdle();
    expect(h!.api.fires).toHaveLength(1);
  });

  it('#11 closeBar resolves the bar by time, not by a stale index', async () => {
    await setup(
      [makeAlert({ spec: price(100, 'oncePerBarClose'), updatedAt: '2026-01-01T00:00:00Z' })],
      [98, 99, 101],
    );
    const s = h!.service.series()[0]! as unknown as SeriesPrivate & { whenIdle(): Promise<void> };
    await s.closeBar(BAR_T, (BAR_T + 120) * 1000);
    await until(() => h!.api.fires.length === 1, 'close fire');
    expect(h!.api.fires[0]!.body.barTime).toBe(BAR_T);
  });

  it('#12 unexpected evaluation errors retry and only escalate after 5 in a row', async () => {
    await setup();
    const s = h!.service.series()[0]! as unknown as SeriesPrivate;
    const r = [...h!.service.series()[0]!.runners.values()][0]!;
    for (let i = 0; i < 4; i++) s.runnerFailure(r, new Error('boom'));
    await h!.service.whenIdle();
    expect(h!.api.statuses).toHaveLength(0);
    expect(h!.service.series()[0]!.runners.has('a1')).toBe(true);
    expect(r.blockedUntil).toBeGreaterThan(h!.clock.now());
    s.runnerFailure(r, new Error('boom'));
    await until(() => h!.api.statuses.length === 1, 'escalation');
    expect(h!.api.statuses[0]!.body).toMatchObject({ status: 'error' });
  });

  it('#15 timeframe subscriptions are released when their alert is removed', async () => {
    const pivots: AlertSpec = {
      schemaVersion: 1,
      left: {
        kind: 'indicator',
        ref: {
          instances: [{ id: 'p', type: 'pivot-points', inputs: { timeframe: '1h' } }],
          instanceId: 'p',
          outputId: 'p',
          title: 'Pivots',
        },
      },
      condition: { op: 'greater', right: { kind: 'value', value: 1e9 } },
      trigger: 'everyTime',
    };
    h = await harness();
    h.api.alerts = [makeAlert({ id: 'a1' }), makeAlert({ id: 'a2', spec: pivots })];
    h.feed.setBars('TEST', '1m', minuteBars(BAR_T, [98, 99, 99]));
    h.feed.setBars(
      'TEST',
      '1h',
      minuteBars(BAR_T, [98, 99, 99]).map((b) => ({
        ...b,
        time: b.time - (b.time % 3600) - (3600 * (BAR_T - b.time)) / 60,
      })),
    );
    await h.start();
    expect(h.feed.subscriptions).toBe(2);
    h.api.alerts = [h.api.alerts[0]!];
    h.control.alertsChanged([], ['a2']);
    await until(() => h!.service.series()[0]?.runners.size === 1, 'a2 removed');
    expect(h.feed.subscriptions).toBe(1);
  });

  it('#16 lastError clears once a retried fire succeeds', async () => {
    await setup();
    h!.api.fireScript = [{ status: 500 }, { status: 500 }];
    await tick(101);
    await h!.clock.advance(1500);
    await h!.clock.advance(60_000);
    await until(() => h!.api.fires.length === 1, 'retried fire');
    await h!.clock.advance(60_000);
    const hb = h!.api.heartbeats.at(-1) as { lastError: string | null };
    expect(hb.lastError).toBeNull();
  });
});
