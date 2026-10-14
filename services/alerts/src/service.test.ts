import { afterEach, describe, expect, it } from 'vitest';
import { FeedError } from '@investopen/engine/node';
import type { AlertSpec } from '@investopen/alerts';
import {
  BAR_T,
  bar,
  harness,
  makeAlert,
  minuteBars,
  settle,
  until,
  type Harness,
} from './test-utils';

let h: Harness | null = null;
afterEach(async () => {
  if (h) {
    await h.stop();
    await h.api.close();
    h = null;
  }
});

const price = (
  op: 'crossingUp' | 'greater',
  value: number,
  trigger: AlertSpec['trigger'] = 'everyTime',
): AlertSpec => ({
  schemaVersion: 1,
  left: { kind: 'price', field: 'close' },
  condition: { op, right: { kind: 'value', value } },
  trigger,
});

/** Harness with 1m bars ending in the forming bar BAR_T. */
async function setup(
  alert = makeAlert(),
  closes = [98, 99, 99],
  env: Record<string, string> = {},
): Promise<Harness> {
  h = await harness({ env });
  h.api.alerts = [alert];
  h.feed.setBars('TEST', '1m', minuteBars(BAR_T, closes));
  await h.start();
  return h;
}

const tick = async (price: number, t = BAR_T) => {
  h!.feed.emit('TEST', 1, bar(t, price));
  await h!.service.whenIdle();
};

describe('service', () => {
  it('loads, attaches and subscribes', async () => {
    await setup();
    const [s] = h!.service.series();
    expect(s?.state).toBe('ready');
    expect(s?.runners.has('a1')).toBe(true);
    expect(h!.feed.subscriptions).toBe(1);
    expect(h!.control.started).toBe(true);
    expect(h!.api.fires).toHaveLength(0);
  });

  it('fires a tick crossing once with the rendered message and post-fire state', async () => {
    await setup(
      makeAlert({
        message: '{{ticker}} at {{close}}',
        spec: price('crossingUp', 100, 'oncePerBar'),
      }),
    );
    await tick(101);
    await until(() => h!.api.fires.length === 1, 'fire');
    const f = h!.api.fires[0]!;
    expect(f.id).toBe('a1');
    expect(f.body.message).toBe('TEST at 101.00');
    expect(f.body.revision).toBe(1);
    expect(f.body.barTime).toBe(BAR_T);
    expect(f.body.values.x).toBe(101);
    expect(f.body.values.y).toBe(100);
    expect(f.body.state?.lastFiredBarTime).toBe(BAR_T);
    await tick(102);
    await tick(99);
    await tick(103);
    await h!.service.whenIdle();
    expect(h!.api.fires).toHaveLength(1); // oncePerBar
  });

  it('a 409 on fire drops the fire and reloads the alert', async () => {
    await setup();
    h!.api.alerts[0]!.status = 'paused';
    h!.api.alerts[0]!.revision = 2;
    h!.api.fireScript = [
      { status: 409, body: { detail: { message: 'changed', current: h!.api.alerts[0] } } },
    ];
    await tick(101);
    await until(() => h!.service.series().length === 0, 'detach after reload');
    expect(h!.api.fires).toHaveLength(0);
    expect(h!.service.fires.pending).toBe(0);
  });

  it('retries a lost fire with the same fireId', async () => {
    await setup();
    h!.api.fireScript = [{ status: 0, drop: true }];
    const seen: string[] = [];
    await tick(101);
    await settle(30);
    expect(h!.api.fires).toHaveLength(0);
    await h!.clock.advance(2000);
    await until(() => h!.api.fires.length === 1, 'retried fire');
    seen.push(h!.api.fires[0]!.body.fireId);
    expect(seen[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(h!.service.fires.pending).toBe(0);
  });

  it('pause via alertsChanged stops evaluation', async () => {
    await setup();
    h!.api.alerts[0]!.status = 'paused';
    h!.api.alerts[0]!.revision = 2;
    h!.control.alertsChanged(['a1']);
    await until(() => h!.service.series().length === 0, 'detach');
    expect(h!.feed.subscriptions).toBe(0);
    await tick(101);
    expect(h!.api.fires).toHaveLength(0);
  });

  it('picks up an added alert and a deleted alert via events', async () => {
    await setup(makeAlert());
    h!.api.alerts.push(makeAlert({ id: 'a2', symbol: 'TEST', interval: '1m' }));
    h!.control.alertsChanged(['a2']);
    await until(() => h!.service.series()[0]?.runners.size === 2, 'second alert');
    h!.api.alerts = [];
    h!.control.alertsChanged([], ['a1', 'a2']);
    await until(() => h!.service.series().length === 0, 'removed');
  });

  describe('drawings', () => {
    const drawingSpec: AlertSpec = {
      schemaVersion: 1,
      left: { kind: 'price', field: 'close' },
      condition: {
        op: 'greater',
        right: { kind: 'drawing', drawingId: 'd1', part: 'line', scale: 'linear' },
      },
      trigger: 'everyTime',
    };
    const hline = (price: number) => ({
      id: 'd1',
      symbol: 'TEST',
      data: {
        id: 'd1',
        type: 'horizontal-line',
        points: [{ time: BAR_T - 600, price }],
        style: {},
      },
    });

    it('a moved drawing changes the level', async () => {
      h = await harness();
      h.api.alerts = [makeAlert({ spec: drawingSpec, drawingId: 'd1' })];
      h.api.drawings = [hline(100)];
      h.feed.setBars('TEST', '1m', minuteBars(BAR_T, [98, 99, 99]));
      await h.start();
      await tick(101);
      await until(() => h!.api.fires.length >= 1, 'first fire');
      expect(h.api.fires.at(-1)!.body.values.y).toBe(100);
      h.api.drawings = [hline(120)];
      h.control.drawingsChanged(['d1']);
      await h.service.whenIdle();
      const before = h.api.fires.length;
      await tick(130);
      await until(() => h!.api.fires.length > before, 'second fire');
      expect(h.api.fires.at(-1)!.body.values.y).toBe(120);
    });

    it('a missing drawing puts the alert into error', async () => {
      h = await harness();
      h.api.alerts = [makeAlert({ spec: drawingSpec, drawingId: 'd1' })];
      h.feed.setBars('TEST', '1m', minuteBars(BAR_T, [98, 99, 99]));
      await h.start();
      await until(() => h!.api.statuses.length === 1, 'status post');
      expect(h.api.statuses[0]!.body).toMatchObject({
        status: 'error',
        reason: 'drawing not found',
        revision: 1,
      });
      expect(h.service.series()).toHaveLength(0);
    });
  });

  it('restores state after a restart (no duplicate oncePerBar fire)', async () => {
    await setup(makeAlert({ spec: price('greater', 100, 'oncePerBar') }), [98, 99, 110]);
    await until(() => h!.api.fires.length === 1, 'initial fire');
    await h!.restart();
    await tick(111);
    await settle(30);
    expect(h!.api.fires).toHaveLength(1);
    // A new bar fires again.
    await tick(112, BAR_T + 60);
    await until(() => h!.api.fires.length === 2, 'next bar fire');
  });

  it('close-mode catch-up after a restart fires once with delayed', async () => {
    h = await harness({ now: (BAR_T + 300) * 1000 });
    const key = 'TEST|1m|rth';
    h.api.alerts = [
      makeAlert({
        spec: price('greater', 100, 'oncePerBarClose'),
        updatedAt: '2026-10-15T14:00:00Z',
      }),
    ];
    h.api.states = [
      {
        alertId: 'a1',
        revision: 1,
        state: {
          v: 1,
          seriesKey: key,
          prev: null,
          lastFiredBarTime: null,
          lastFiredAt: null,
          lastClosedBarTime: BAR_T - 180,
        },
      },
    ];
    h.feed.setBars('TEST', '1m', minuteBars(BAR_T, [90, 95, 110, 120]));
    await h.start();
    await until(() => h!.api.fires.length === 1, 'catch-up fire');
    expect(h.api.fires[0]!.body.delayed).toBe(true);
    expect(h.api.fires[0]!.body.barTime).toBe(BAR_T);
    await settle(30);
    expect(h.api.fires).toHaveLength(1);
  });

  it('falls back to polling after the live connection is down for 20 s', async () => {
    await setup(makeAlert(), [98, 99, 99], { ALERTS_POLL_MS: '5000' });
    const calls = () => h!.feed.getBarsCalls.filter((c) => c.limit === 3).length;
    expect(calls()).toBe(0);
    h!.feed.setLive('reconnecting');
    await h!.clock.advance(15_000);
    expect(calls()).toBe(0);
    h!.feed.setBars('TEST', '1m', minuteBars(BAR_T, [98, 99, 101]));
    await h!.clock.advance(15_000);
    await until(() => calls() > 0, 'poll');
    await until(() => h!.api.fires.length >= 1, 'fire from polled bar');
    expect(h!.service.series()[0]!.polled).toBe(true);
    h!.feed.setLive('open');
    expect(h!.service.series()[0]!.polled).toBe(false);
  });

  it('backs off on a 502 without changing the alert status, then recovers', async () => {
    h = await harness();
    h.api.alerts = [makeAlert()];
    h.feed.setBars('TEST', '1m', minuteBars(BAR_T, [98, 99, 99]));
    h.feed.failBars = new FeedError('bad gateway', 502);
    await h.start();
    const s = h.service.series()[0]!;
    expect(s.state).toBe('retrying');
    expect(h.api.statuses).toHaveLength(0);
    h.feed.failBars = null;
    await h.clock.advance(6000);
    await until(() => s.state === 'ready', 'recovery');
    expect(h.api.statuses).toHaveLength(0);
  });

  it('a 404 symbol puts the alert into error', async () => {
    h = await harness();
    h.api.alerts = [makeAlert()];
    h.feed.failResolve = new FeedError('not found', 404);
    await h.start();
    await until(() => h!.api.statuses.length === 1, 'status');
    expect(h.api.statuses[0]!.body).toMatchObject({ status: 'error', reason: 'symbol not found' });
  });

  it('an expression series evaluates from each leg', async () => {
    h = await harness();
    h.api.alerts = [
      makeAlert({
        symbol: 'AAA/BBB',
        spec: price('greater', 1.5),
      }),
    ];
    h.feed.setBars('AAA', '1m', minuteBars(BAR_T, [10, 10, 20]));
    h.feed.setBars('BBB', '1m', minuteBars(BAR_T, [10, 10, 10]));
    await h.start();
    await until(() => h!.api.fires.length >= 1, 'expression fire');
    expect(h.api.fires[0]!.body.values.close).toBeCloseTo(2, 10);
  });

  it('computes indicator operands and shares identical instances', async () => {
    const sma = (id: string) => ({
      kind: 'indicator' as const,
      ref: {
        instances: [{ id, type: 'sma', inputs: { length: 3, source: 'close' } }],
        instanceId: id,
        outputId: 'ma',
        title: 'SMA 3',
      },
    });
    const spec = (id: string): AlertSpec => ({
      schemaVersion: 1,
      left: sma(id),
      condition: { op: 'greater', right: { kind: 'value', value: 100 } },
      trigger: 'oncePerBar',
    });
    h = await harness();
    h.api.alerts = [
      makeAlert({ id: 'a1', spec: spec('x') }),
      makeAlert({ id: 'a2', spec: spec('y') }),
    ];
    h.feed.setBars('TEST', '1m', minuteBars(BAR_T, [90, 90, 90, 90]));
    await h.start();
    expect(h.api.fires).toHaveLength(0);
    await tick(150);
    await until(() => h!.api.fires.length === 2, 'both fire');
    expect(h.api.fires[0]!.body.values.x).toBeCloseTo((90 + 90 + 150) / 3, 10);
  });

  it('trimming keeps the series bounded and values correct', async () => {
    await setup(makeAlert(), [98, 99, 99], { ALERTS_MAX_BARS: '50' });
    const s = h!.service.series()[0]!;
    for (let i = 1; i <= 700; i++) h!.feed.emit('TEST', 1, bar(BAR_T + i * 60, 90));
    await h!.service.whenIdle();
    expect(s.length).toBeLessThan(560);
    expect(s.lastBar()?.time).toBe(BAR_T + 700 * 60);
    await tick(101, BAR_T + 700 * 60);
    await until(() => h!.api.fires.length >= 1, 'fire after trim');
    expect(h!.api.fires.at(-1)!.body.values.x).toBe(101);
  });

  it('rule 2 closes a bar on the clock and emits one close sample', async () => {
    await setup(
      makeAlert({
        spec: price('greater', 100, 'oncePerBarClose'),
        updatedAt: '2026-01-01T00:00:00Z',
      }),
      [98, 99, 101],
    );
    // bar BAR_T closes at BAR_T + 60 + 60 grace
    await h!.clock.advance(100_000);
    await until(() => h!.api.fires.length === 1, 'close fire');
    expect(h!.api.fires[0]!.body.barTime).toBe(BAR_T);
    await h!.clock.advance(60_000);
    expect(h!.api.fires).toHaveLength(1);
  });

  it('expiry posts status expired once', async () => {
    await setup(makeAlert({ expiresAt: new Date((BAR_T + 40) * 1000).toISOString() }));
    await h!.clock.advance(20_000);
    await until(() => h!.api.statuses.length === 1, 'expired post');
    expect(h!.api.statuses[0]!.body.status).toBe('expired');
  });

  it('waits for the API and sends heartbeats and state flushes', async () => {
    h = await harness();
    h.api.healthFails = 2;
    h.api.alerts = [makeAlert()];
    h.feed.setBars('TEST', '1m', minuteBars(BAR_T, [98, 99, 99]));
    const started = h.service.start();
    await settle(20);
    await h.clock.advance(1500);
    await h.clock.advance(3000);
    await started;
    await h.service.whenIdle();
    expect(h.api.healthFails).toBe(0);
    await until(() => h!.api.heartbeats.length >= 1, 'heartbeat');
    await tick(98.5);
    await h.clock.advance(1100);
    await until(() => h!.api.putStates.length >= 1, 'state flush');
  });
});
