import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AlertSpec, FireIn, ServiceMetricsSnapshot } from '@tickerglass/alerts';
import { AlertRunner } from './alert-runner';
import { ApiError } from './api';
import type { FireJob } from './alert-runner';
import { FireQueue } from './fires';
import { silentLogger } from './log';
import { LAG_BUCKETS, ServiceMetrics } from './metrics';
import {
  BAR_T,
  FakeClock,
  harness,
  makeAlert,
  minuteBars,
  settle,
  until,
  type Harness,
} from './test-utils';

let h: Harness | null = null;
afterEach(async () => {
  vi.restoreAllMocks();
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

const tick = async (close: number) => {
  h!.feed.emit('TEST', 1, minuteBars(BAR_T, [close])[0]!);
  await h!.service.whenIdle();
};

/** The `metrics` of the next heartbeat (30 s of fake time later). */
async function beat(hh: Harness = h!): Promise<ServiceMetricsSnapshot> {
  const n = hh.api.heartbeats.length;
  await hh.clock.advance(30_000);
  await until(() => hh.api.heartbeats.length > n, 'heartbeat');
  const m = (hh.api.heartbeats.at(-1) as { metrics?: ServiceMetricsSnapshot }).metrics;
  expect(m).toBeDefined();
  return m!;
}

const job = (revision: number, id = `f${revision}`): FireJob => ({
  alertId: 'a1',
  revision,
  body: { fireId: id, revision } as unknown as FireIn,
});

describe('ServiceMetrics', () => {
  it('lag buckets are the contract bounds and cumulative (<= bound)', () => {
    const m = new ServiceMetrics();
    expect(LAG_BUCKETS).toEqual([0.25, 0.5, 1, 2, 5, 10, 30, 60, 120, 300]);
    for (const s of [0.25, 0.3, 1, 7, 400]) m.observeLag(s);
    const lag = m.snapshot(0).lag;
    expect(lag.buckets).toEqual([0.25, 0.5, 1, 2, 5, 10, 30, 60, 120, 300]);
    expect(lag.counts).toEqual([1, 2, 3, 3, 3, 4, 4, 4, 4, 4]);
    expect(lag.count).toBe(5);
    expect(lag.sum).toBeCloseTo(408.55);
  });

  it('negative and non-finite lag count as 0', () => {
    const m = new ServiceMetrics();
    m.observeLagMs(5000, 3000);
    m.observeLag(NaN);
    const lag = m.snapshot(0).lag;
    expect(lag.counts.every((c) => c === 2)).toBe(true);
    expect(lag.count).toBe(2);
    expect(lag.sum).toBe(0);
  });

  it('snapshots are copies and instances are independent', () => {
    const a = new ServiceMetrics();
    const b = new ServiceMetrics();
    a.evaluations = 3;
    a.observeLag(1);
    const snap = a.snapshot(4);
    a.observeLag(1);
    expect(snap.lag.count).toBe(1);
    expect(snap.fireQueueDepth).toBe(4);
    expect(b.snapshot(0)).toMatchObject({ evaluations: 0, lag: { count: 0, sum: 0 } });
  });
});

describe('FireQueue metrics', () => {
  it('counts retries, and drops on 404 and 422 but not on 409', async () => {
    const metrics = new ServiceMetrics();
    const clock = new FakeClock(0);
    const answers: (Error | null)[] = [
      new Error('down'),
      new Error('down'),
      null,
      new ApiError('gone', 404),
      new ApiError('bad', 422),
      new ApiError('stale', 409),
    ];
    const q = new FireQueue({
      api: {
        fire: () => {
          const a = answers.shift();
          return a ? Promise.reject(a) : Promise.resolve({} as never);
        },
      },
      clock,
      log: silentLogger,
      onConflict: () => {},
      metrics,
    });
    q.enqueue(job(1));
    await settle();
    await clock.advance(10_000);
    await q.whenIdle();
    expect(metrics.fireRetries).toBe(2);
    expect(metrics.firesDropped).toBe(0);
    q.enqueue(job(2));
    await q.whenIdle();
    q.enqueue(job(3));
    await q.whenIdle();
    q.enqueue(job(4));
    await q.whenIdle();
    expect(metrics.fireRetries).toBe(2);
    expect(metrics.firesDropped).toBe(2);
  });
});

describe('service metrics', () => {
  it('the heartbeat carries metrics: evaluations and fires queued', async () => {
    await setup();
    const before = await beat();
    expect(before.lag.buckets).toEqual([0.25, 0.5, 1, 2, 5, 10, 30, 60, 120, 300]);
    expect(before.lag.counts).toHaveLength(10);
    expect(before.evaluations).toBeGreaterThanOrEqual(1); // the seed
    expect(before.firesQueued).toBe(0);
    expect(before.fireQueueDepth).toBe(0);
    expect(before.evaluationFailures).toBe(0);
    expect(before.lag.count).toBe(0); // seeds are not observed
    await tick(101);
    await until(() => h!.api.fires.length === 1, 'fire');
    const after = await beat();
    expect(after.evaluations).toBeGreaterThan(before.evaluations);
    expect(after.firesQueued).toBe(1);
    expect(after.fireQueueDepth).toBe(0);
  });

  it('counters are per service instance', async () => {
    await setup();
    await tick(101);
    await until(() => h!.api.fires.length === 1, 'fire');
    const first = await beat();
    expect(first.firesQueued).toBe(1);
    await h!.restart();
    const hb = h!.api.heartbeats.at(-1) as { metrics: ServiceMetricsSnapshot };
    // A new service starts from zero, not from the previous run's totals.
    expect(hb.metrics.evaluations).toBeLessThan(first.evaluations);
    expect(hb.metrics.firesQueued).toBe(0);
    expect(hb.metrics.lag.count).toBe(0);
  });

  it('counts evaluation failures', async () => {
    h = await harness();
    h.api.alerts = [makeAlert()];
    h.feed.setBars('TEST', '1m', minuteBars(BAR_T, [98, 99, 99]));
    vi.spyOn(AlertRunner.prototype, 'seed').mockImplementationOnce(() => {
      throw new Error('boom');
    });
    await h.start();
    const m = await beat();
    expect(m.evaluationFailures).toBe(1);
  });

  it('counts retries and the queue depth while the API refuses fires', async () => {
    h = await harness();
    h.api.alerts = [makeAlert()];
    h.api.fireScript = Array.from({ length: 60 }, () => ({ status: 500 }));
    h.feed.setBars('TEST', '1m', minuteBars(BAR_T, [98, 99, 99]));
    await h.start();
    await tick(101);
    const m = await beat();
    expect(m.firesQueued).toBe(1);
    expect(m.fireQueueDepth).toBe(1);
    expect(m.fireRetries).toBeGreaterThanOrEqual(3);
    expect(m.firesDropped).toBe(0);
    // The API recovers: the queue drains (stop waits for it on a fake clock).
    h.api.fireScript = [];
    await h.clock.advance(70_000);
    await h.service.whenIdle();
    expect(h.api.fires).toHaveLength(1);
  });

  it('counts a fire the API drops (404)', async () => {
    h = await harness();
    h.api.alerts = [makeAlert()];
    h.api.fireScript = [{ status: 404 }];
    h.feed.setBars('TEST', '1m', minuteBars(BAR_T, [98, 99, 99]));
    await h.start();
    await tick(101);
    await until(() => h!.api.fireScript.length === 0, 'fire attempt');
    await h.service.whenIdle();
    const m = await beat();
    expect(m.firesDropped).toBe(1);
    expect(m.fireRetries).toBe(0);
  });

  it('counts a failed status post', async () => {
    await setup(makeAlert({ expiresAt: new Date((BAR_T + 40) * 1000).toISOString() }));
    h!.api.statusFails = 1;
    await h!.clock.advance(20_000);
    await until(() => h!.api.statuses.length === 1, 'expired post after the failure');
    const m = await beat();
    expect(m.statusPostFailures).toBe(1);
  });

  it('bar-close lag: bar end (plus close grace) to the end of the close evaluation', async () => {
    // Close at BAR_T + 60 + 60 s grace; the refetch of the bar hangs for 3 s.
    await setup(makeAlert({ spec: price('greater', 100, 'oncePerBarClose') }));
    let release!: () => void;
    h!.feed.barsGate = new Promise<void>((r) => (release = r));
    await h!.clock.advance(90_000 + 3000);
    expect(h!.feed.getBarsCalls.some((c) => c.limit === 3)).toBe(true);
    release();
    h!.feed.barsGate = null;
    await settle(20);
    await h!.service.whenIdle();
    const m = await beat();
    expect(m.lag.count).toBe(1);
    // About 3 s: above the 2 s bound, within the 5 s one.
    expect(m.lag.counts).toEqual([0, 0, 0, 0, 1, 1, 1, 1, 1, 1]);
    expect(m.lag.sum).toBeGreaterThan(2);
    expect(m.lag.sum).toBeLessThanOrEqual(5);
  });

  it('poll lag: the scheduled poll time to the end of the poll', async () => {
    await setup(makeAlert(), [98, 99, 99], { ALERTS_POLL_MS: '5000' });
    h!.feed.setLive('reconnecting');
    await h!.clock.advance(25_000); // live is down for 20 s: polling starts
    await until(() => h!.feed.getBarsCalls.some((c) => c.limit === 3), 'first poll');
    await h!.service.whenIdle();
    const idle = await beat();
    const polls = idle.lag.count;
    expect(polls).toBeGreaterThanOrEqual(1);
    // Polls on time: every observation is in the first bucket (the stale schedule from before
    // live went down does not count as lag).
    expect(idle.lag.counts[0]).toBe(polls);

    // A slow poll: due at the tick it starts, ends 3 s later.
    let release!: () => void;
    h!.feed.barsGate = new Promise<void>((r) => (release = r));
    const calls = h!.feed.getBarsCalls.length;
    await h!.clock.advance(6000);
    await until(() => h!.feed.getBarsCalls.length > calls, 'slow poll');
    await h!.clock.advance(3000);
    release();
    h!.feed.barsGate = null;
    await settle(20);
    await h!.service.whenIdle();
    const slow = await beat();
    expect(slow.lag.count).toBeGreaterThan(polls);
    expect(slow.lag.counts[0]).toBeLessThan(slow.lag.count); // one observation above 0.25 s
    expect(slow.lag.counts[3]).toBeLessThan(slow.lag.count); // ...above 2 s
    expect(slow.lag.counts[4]).toBeGreaterThanOrEqual(slow.lag.counts[3]!);
  });
});
