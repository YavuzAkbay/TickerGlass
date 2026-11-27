/** Alerts on user scripts, end to end through the service (docs/design/script-alerts.md). */
import { afterEach, describe, expect, it } from 'vitest';
import type { AlertSpec } from '@tickerglass/alerts';
import { golden, manifestOf } from './scripts/test-helpers';
import type { StoredScript } from './scripts/catalog';
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

function stored(id: string, source: string, revision = 1, over: Partial<StoredScript> = {}) {
  return {
    id,
    name: `Script ${id}`,
    source,
    manifest: manifestOf(id, source),
    apiVersion: 1,
    revision,
    ...over,
  } satisfies StoredScript;
}

const SMA = golden('sma');
/** The golden SMA, plus a constant offset (an "edit" that moves every value). */
const SMA_PLUS_10 = SMA.replace(
  'avg.update(c.src.source[c.i])',
  'avg.update(c.src.source[c.i]) + 10',
);

type Op = 'crossingUp' | 'greater' | 'crossingDown';
function scriptSpec(
  scriptId: string,
  op: Op,
  value: number,
  inputs: Record<string, unknown> = { length: 3, source: 'close' },
  outputId = 'ma',
  trigger: AlertSpec['trigger'] = 'everyTime',
): AlertSpec {
  return {
    schemaVersion: 1,
    left: {
      kind: 'indicator',
      ref: {
        instances: [{ id: 'i1', type: `user:${scriptId}`, inputs: inputs as never }],
        instanceId: 'i1',
        outputId,
        title: 'My SMA',
      },
    },
    condition: { op, right: { kind: 'value', value } },
    trigger,
  };
}

async function setup(
  scripts: StoredScript[],
  alert = makeAlert({ spec: scriptSpec('sma', 'crossingUp', 100) }),
  closes = [98, 99, 99],
  env: Record<string, string> = {},
): Promise<Harness> {
  h = await harness({ env });
  h.api.userScripts = scripts;
  h.api.alerts = [alert];
  h.feed.setBars('TEST', '1m', minuteBars(BAR_T, closes));
  await h.start();
  return h;
}

const tick = async (price: number, t = BAR_T, volume = 100) => {
  h!.feed.emit('TEST', 1, bar(t, price, price, price, price, volume));
  await h!.service.whenIdle();
};

const lastStatus = () => h!.api.statuses.at(-1)?.body;

describe('alerts on user scripts', () => {
  it('a crossing on a script plot fires with the script value', async () => {
    await setup([stored('sma', SMA)]);
    const [s] = h!.service.series();
    expect(s?.state).toBe('ready');
    expect(h!.api.fires).toHaveLength(0);
    await tick(110); // sma3 = (98 + 99 + 110) / 3 = 102.33 crosses up 100 (from 98.67)
    await until(() => h!.api.fires.length === 1, 'fire');
    const f = h!.api.fires[0]!;
    expect(f.body.values.x).toBeCloseTo(307 / 3, 9);
    expect(f.body.values.y).toBe(100);
    expect(h!.api.statuses).toEqual([]);
  });

  it('values equal the built-in indicator (full history, then live bars)', async () => {
    const sma = makeAlert({ id: 'u', spec: scriptSpec('sma', 'greater', -1) });
    const builtin = makeAlert({
      id: 'b',
      spec: {
        schemaVersion: 1,
        left: {
          kind: 'indicator',
          ref: {
            instances: [{ id: 'i1', type: 'sma', inputs: { length: 3, source: 'close' } }],
            instanceId: 'i1',
            outputId: 'ma',
            title: 'SMA',
          },
        },
        condition: { op: 'greater', right: { kind: 'value', value: -1 } },
        trigger: 'everyTime',
      },
    });
    await setup([stored('sma', SMA)], sma, [98, 99, 99]);
    h!.api.alerts = [sma, builtin];
    await h!.service.sync();
    await h!.service.whenIdle();
    await tick(104);
    await tick(107, BAR_T + 60);
    const xs = (id: string) => h!.api.fires.filter((f) => f.id === id).map((f) => f.body.values.x);
    // Both alerts fire on the history value and on each live bar (3 each). Wait for each one's
    // own fires: a total count can be reached while one alert is still a bar behind.
    await until(() => xs('u').length >= 3 && xs('b').length >= 3, 'fires');
    expect(xs('u')).toEqual(xs('b'));
  });

  it('a script edit recomputes without a spurious crossing, then keeps evaluating', async () => {
    await setup([stored('sma', SMA)]);
    expect(h!.service.series()[0]?.state).toBe('ready');
    // v2 shifts every value up by 10: 98.67 -> 108.67. A kept previous sample would cross 100.
    h!.api.userScripts = [stored('sma', SMA_PLUS_10, 2)];
    await h!.service.sync();
    await h!.service.whenIdle();
    await settle();
    await h!.service.whenIdle();
    expect(h!.service.series()[0]?.state).toBe('ready');
    expect(h!.api.fires).toHaveLength(0);
    expect(h!.api.statuses).toEqual([]);
    // It still evaluates against the new values: 108.67 -> drop below 100 -> cross up again.
    await tick(60); // sma3 = (98 + 99 + 60) / 3 + 10 = 95.67
    await tick(120); // (98 + 99 + 120) / 3 + 10 = 115.67
    await until(() => h!.api.fires.length === 1, 'fire after the edit');
    expect(h!.api.fires[0]!.body.values.x).toBeCloseTo((98 + 99 + 120) / 3 + 10, 9);
  });

  it('a deleted script puts the alert in error', async () => {
    await setup([stored('sma', SMA)]);
    h!.api.userScripts = [];
    await h!.service.sync();
    await until(() => h!.api.statuses.length === 1, 'status');
    expect(lastStatus()).toMatchObject({ status: 'error', reason: 'script was deleted' });
  });

  describe('owners', () => {
    it('an alert resolves a script of its own owner (ownerId on both)', async () => {
      await setup(
        [stored('sma', SMA, 1, { ownerId: 'alice' })],
        makeAlert({ spec: scriptSpec('sma', 'crossingUp', 100), ownerId: 'alice' }),
      );
      expect(h!.service.series()[0]?.state).toBe('ready');
      expect(h!.api.statuses).toEqual([]);
    });

    it("an alert never resolves another owner's script id", async () => {
      await setup(
        [stored('sma', SMA, 1, { ownerId: 'bob' })],
        makeAlert({ spec: scriptSpec('sma', 'crossingUp', 100), ownerId: 'alice' }),
      );
      await until(() => h!.api.statuses.length === 1, 'status');
      expect(lastStatus()).toMatchObject({ status: 'error', reason: 'script was deleted' });
      expect(h!.service.series()).toHaveLength(0);
    });

    it('a script without an owner does not match an alert with one, nor the reverse', async () => {
      await setup(
        [stored('sma', SMA)],
        makeAlert({ spec: scriptSpec('sma', 'crossingUp', 100), ownerId: 'alice' }),
      );
      await until(() => h!.api.statuses.length === 1, 'status');
      expect(lastStatus()).toMatchObject({ status: 'error', reason: 'script was deleted' });
      await h!.stop();
      await h!.api.close();
      await setup(
        [stored('sma', SMA, 1, { ownerId: 'alice' })],
        makeAlert({ spec: scriptSpec('sma', 'crossingUp', 100) }),
      );
      await until(() => h!.api.statuses.length === 1, 'status');
      expect(lastStatus()).toMatchObject({ status: 'error', reason: 'script was deleted' });
    });

    it('a script id claimed by two owners is served to neither', async () => {
      await setup(
        [stored('sma', SMA, 1, { ownerId: 'alice' }), stored('sma', SMA, 1, { ownerId: 'bob' })],
        makeAlert({ spec: scriptSpec('sma', 'crossingUp', 100), ownerId: 'alice' }),
      );
      await until(() => h!.api.statuses.length === 1, 'status');
      expect(lastStatus()).toMatchObject({ status: 'error', reason: 'script was deleted' });
    });
  });

  it('a script without a manifest reports its compile error', async () => {
    await setup([stored('sma', SMA)]);
    h!.api.userScripts = [
      {
        id: 'sma',
        name: 'Broken',
        source: 'const x = ;',
        manifest: null,
        apiVersion: 1,
        revision: 2,
      },
    ];
    await h!.service.sync();
    await until(() => h!.api.statuses.length === 1, 'status');
    expect(lastStatus()?.reason).toMatch(/script does not compile: SyntaxError/);
  });

  it('inputs that no longer match the manifest put the alert in error', async () => {
    await setup([stored('sma', SMA)]);
    const noLength = SMA.replace(/ {4}length: [^\n]*\n/, '').replace(
      'ta.sma(inputs.length)',
      'ta.sma(9)',
    );
    expect(noLength).not.toBe(SMA);
    h!.api.userScripts = [stored('sma', noLength, 2)];
    await h!.service.sync();
    await until(() => h!.api.statuses.length === 1, 'status');
    expect(lastStatus()?.reason).toBe('script inputs changed — edit the alert');
  });

  it('an output that no longer exists puts the alert in error', async () => {
    await setup([stored('sma', SMA)]);
    h!.api.userScripts = [stored('sma', SMA.replace(/id: 'ma'/, "id: 'avg'"), 2)];
    await h!.service.sync();
    await until(() => h!.api.statuses.length === 1, 'status');
    expect(lastStatus()?.reason).toBe("script output 'ma' no longer exists — edit the alert");
  });

  it('a repainting script is refused by the validator', async () => {
    const zz = golden('zigzag');
    const spec = scriptSpec('zz', 'greater', 0, {}, 'zz');
    const alert = makeAlert({ spec });
    await setup([stored('zz', zz)], alert);
    expect(h!.service.series()).toHaveLength(0);
    expect(h!.api.statuses).toHaveLength(1);
    expect(lastStatus()?.reason).toMatch(/invalid alert:.*repaints past values/);
  });

  it('a script as the source of a built-in indicator is refused', async () => {
    const spec = scriptSpec('sma', 'greater', 0);
    const left = spec.left as {
      ref: { instances: unknown[]; instanceId: string; outputId: string };
    };
    left.ref.instances.push({
      id: 'e',
      type: 'ema',
      inputs: { source: { instanceId: 'i1', outputId: 'ma' }, length: 5 },
    });
    left.ref.instanceId = 'e';
    left.ref.outputId = 'ema';
    await setup([stored('sma', SMA)], makeAlert({ spec }));
    expect(h!.service.series()).toHaveLength(0);
    expect(lastStatus()?.reason).toMatch(/invalid alert:.*scripts can't feed other indicators/);
  });

  it('a script that keeps state outside ta fails Check and the alert errors', async () => {
    const stateful = `
      let count = 0;
      defineIndicator({
        id: 'x', name: 'Stateful', shortName: 'S', category: 'other', overlay: false,
        inputs: {},
        outputs: [{ type: 'plot', id: 'v', title: 'V', kind: 'line', color: '#fff' }],
        setup() { return (c) => { count++; c.set('v', count); }; },
      });`;
    await setup(
      [stored('st', stateful)],
      makeAlert({ spec: scriptSpec('st', 'greater', 0, {}, 'v') }),
    );
    await until(() => h!.api.statuses.length === 1, 'status');
    expect(lastStatus()?.reason).toMatch(/differs between a full recompute and live updates/);
    expect(lastStatus()?.reason).toMatch(/keep state in ta/);
  });

  it('a script that throws on a live bar puts the alert in error', async () => {
    const src = SMA.replace(
      "c.set('ma', avg.update(c.src.source[c.i]));",
      "if (c.src.source[c.i] > 500) throw new Error('too high');\n      c.set('ma', avg.update(c.src.source[c.i]));",
    );
    expect(src).not.toBe(SMA);
    await setup([stored('sma', src)]);
    await tick(900);
    await until(() => h!.api.statuses.length === 1, 'status');
    expect(lastStatus()?.reason).toMatch(/too high/);
  });

  it('refuses script alerts when the script runtime is unavailable', async () => {
    h = await harness();
    const { ScriptHost } = await import('./scripts/host');
    const { silentLogger } = await import('./log');
    h.scripts.dispose();
    // A service on a disabled host (no isolated-vm): alerts on scripts error, others run.
    const { createService } = await import('./service');
    const { ApiClient } = await import('./api');
    const { ExpressionFeed } = await import('@tickerglass/engine/node');
    const svc = createService({
      api: new ApiClient({ baseUrl: h.api.url, attempts: 1, sleep: async () => {} }),
      control: h.control,
      feed: new ExpressionFeed(h.feed),
      clock: h.clock,
      config: h.cfg,
      log: silentLogger,
      live: h.feed,
      scripts: ScriptHost.disabled(
        'user scripts are unavailable: no runtime',
        h.clock,
        silentLogger,
      ),
    });
    h.api.userScripts = [stored('sma', SMA)];
    h.api.alerts = [makeAlert({ spec: scriptSpec('sma', 'crossingUp', 100) })];
    h.feed.setBars('TEST', '1m', minuteBars(BAR_T, [98, 99, 99]));
    await svc.start();
    await svc.whenIdle();
    await until(() => h!.api.statuses.length === 1, 'status');
    expect(lastStatus()?.reason).toBe('user scripts are unavailable: no runtime');
    await svc.stop();
  });

  it('waits for the script list instead of erroring when the API cannot give it', async () => {
    h = await harness();
    h.api.userScriptsDown = true;
    h.api.userScripts = [stored('sma', SMA)];
    h.api.alerts = [makeAlert({ spec: scriptSpec('sma', 'crossingUp', 100) })];
    h.feed.setBars('TEST', '1m', minuteBars(BAR_T, [98, 99, 99]));
    await h.start();
    expect(h.service.series()).toHaveLength(0);
    expect(h.api.statuses).toEqual([]);
    h.api.userScriptsDown = false;
    await h.service.sync();
    await h.service.whenIdle();
    await settle();
    expect(h.service.series()[0]?.runners.has('a1')).toBe(true);
    expect(h.api.statuses).toEqual([]);
  });

  it('a script created just before its alert is found without waiting for the next resync', async () => {
    await setup([], makeAlert({ id: 'plain' }));
    h!.api.userScripts = [stored('sma', SMA)];
    h!.api.alerts.push(makeAlert({ id: 'a2', spec: scriptSpec('sma', 'crossingUp', 100) }));
    h!.control.alertsChanged(['a2']);
    await until(() => h!.service.series().some((s) => s.runners.has('a2')), 'attach');
    expect(h!.api.statuses).toEqual([]);
  });
});

describe('script faults: alerts wait, they do not end in error', () => {
  const HANG_ON_VOLUME = SMA.replace(
    "c.set('ma', avg.update(c.src.source[c.i]));",
    "if (c.volume[c.i] > 1000) { while (true) {} }\n      c.set('ma', avg.update(c.src.source[c.i]));",
  );
  const ALWAYS_HANG = SMA.replace(
    "c.set('ma', avg.update(c.src.source[c.i]));",
    "while (true) {}\n      c.set('ma', avg.update(c.src.source[c.i]));",
  );
  const FAST = { ALERTS_SCRIPT_TICK_MS: '100', ALERTS_SCRIPT_LOAD_MS: '2000' };
  expect(HANG_ON_VOLUME).not.toBe(SMA);
  expect(ALWAYS_HANG).not.toBe(SMA);

  const alertsOn = () =>
    h!.service
      .series()
      .flatMap((s) => [...s.runners.keys()])
      .sort();
  const status = (id: string) => h!.api.alerts.find((a) => a.id === id)?.status;

  /** Two alerts on two symbols, so one fault touches two series. */
  async function twoSeries(source = HANG_ON_VOLUME): Promise<void> {
    await setup(
      [stored('sma', source)],
      makeAlert({ id: 'a1', spec: scriptSpec('sma', 'crossingUp', 100) }),
      [98, 99, 99],
      FAST,
    );
    h!.feed.setBars('OTHR', '1m', minuteBars(BAR_T, [98, 99, 99]));
    h!.api.alerts.push(
      makeAlert({ id: 'a2', symbol: 'OTHR', spec: scriptSpec('sma', 'crossingUp', 100) }),
    );
    await h!.service.sync();
    await h!.service.whenIdle();
    expect(alertsOn()).toEqual(['a1', 'a2']);
  }

  /** A live bar that makes the script spin: one timed-out update. */
  const strike = async () => {
    await tick(110, BAR_T, 5000);
    await h!.service.whenIdle();
  };
  /** The same bar, corrected: the series rebuilds from bars that no longer make the script spin. */
  const recover = async () => {
    await tick(110, BAR_T, 100);
    await h!.service.whenIdle();
    await settle();
  };
  /** The script is out of strikes: the third timed-out update inside 10 minutes. */
  const holdTheScript = async () => {
    for (let i = 0; i < 3; i++) {
      await strike();
      if (i < 2) await recover();
    }
  };
  /** Waiting alerts start 2 to 10 s after the hold: step past it. */
  const pastTheHold = (ms: number) => h!.clock.advance(ms + 11_000);

  it('one timed-out update affects only its own series: nothing is suspended, the series rebuilds on its next bar', async () => {
    await twoSeries();
    const epoch = h!.scripts.epoch('sma');
    await strike();
    expect(h!.api.statuses).toEqual([]);
    expect(alertsOn()).toEqual(['a1', 'a2']); // nobody waits
    expect(h!.service.waiting()).toEqual([]);
    expect(h!.scripts.hold('sma')).toBeNull();
    expect(h!.scripts.epoch('sma')).toBe(epoch); // same isolate
    await recover();
    expect(alertsOn()).toEqual(['a1', 'a2']);
    expect(h!.service.series().every((s) => s.state === 'ready')).toBe(true);
    expect(h!.scripts.epoch('sma')).toBe(epoch);
    expect(h!.api.statuses).toEqual([]);
  });

  it('a fault counts once in the heartbeat metrics, however many series it touches', async () => {
    await twoSeries();
    const faults = async () => {
      const n = h!.api.heartbeats.length;
      await h!.clock.advance(30_000);
      await until(() => h!.api.heartbeats.length > n, 'heartbeat');
      return (h!.api.heartbeats.at(-1) as { metrics: { scriptFaults: number } }).metrics
        .scriptFaults;
    };
    await strike(); // a timed-out update is no fault yet
    await recover();
    expect(await faults()).toBe(0);
    await strike();
    await recover();
    await strike(); // the third strike disposes the isolate
    expect(h!.scripts.hold('sma')).not.toBeNull();
    expect(await faults()).toBe(1);
  });

  it('three timeouts in 10 minutes hold the script off: alerts, also new ones, wait; they re-attach (spread out) when the hold ends', async () => {
    await twoSeries();
    await holdTheScript();
    expect(h!.api.statuses).toEqual([]);
    const hold = h!.scripts.hold('sma');
    expect(hold).toMatchObject({ final: false });
    expect(hold!.reason).toMatch(/time limit/);
    expect(alertsOn()).toEqual([]);
    // An alert attached during the hold waits too (no error status).
    h!.api.alerts.push(makeAlert({ id: 'a3', spec: scriptSpec('sma', 'crossingUp', 100) }));
    await h!.service.sync(['a3']);
    await h!.service.whenIdle();
    expect(alertsOn()).toEqual([]);
    expect(h!.api.statuses).toEqual([]);
    expect(['a1', 'a2', 'a3'].map(status)).toEqual(['active', 'active', 'active']);
    // Each waits until the hold ends plus 2 to 10 s.
    const waiting = h!.service.waiting();
    expect(waiting.map((w) => w.alertId).sort()).toEqual(['a1', 'a2', 'a3']);
    for (const w of waiting) {
      expect(w.reason).toMatch(/time limit/);
      expect(w.resumeAt - hold!.retryAt).toBeGreaterThanOrEqual(2000);
      expect(w.resumeAt - hold!.retryAt).toBeLessThanOrEqual(10_000);
    }
    // Still waiting a minute in...
    await h!.clock.advance(60_000);
    await h!.service.whenIdle();
    expect(alertsOn()).toEqual([]);
    // ...and the heartbeat tells the API who waits, why and until when.
    await until(() => h!.api.heartbeats.length > 0, 'heartbeat');
    const hb = h!.api.heartbeats.at(-1) as {
      waiting: { alertId: string; reason: string; resumeAt: string }[];
    };
    expect(hb.waiting.map((w) => w.alertId).sort()).toEqual(['a1', 'a2', 'a3']);
    for (const w of hb.waiting) {
      expect(w.reason).toMatch(/time limit/);
      expect(Date.parse(w.resumeAt)).toBeGreaterThanOrEqual(hold!.retryAt + 2000);
    }
    // ...and re-attached by themselves once the 5 minutes (plus the spread) are over.
    const epoch = h!.scripts.epoch('sma');
    await pastTheHold(5 * 60_000);
    await h!.service.whenIdle();
    expect(alertsOn()).toEqual(['a1', 'a2', 'a3']);
    expect(h!.service.waiting()).toEqual([]);
    expect(h!.scripts.epoch('sma')).toBeGreaterThan(epoch);
    expect(h!.api.statuses).toEqual([]);
    // Back in business: a crossing on a new bar fires.
    const t = Math.floor(h!.clock.now() / 60_000) * 60;
    await tick(90, t);
    await tick(120, t);
    await until(() => h!.api.fires.length > 0, 'fire after the hold');
  });

  it('saving the script ends the hold at once', async () => {
    await twoSeries();
    await holdTheScript();
    expect(h!.scripts.hold('sma')).not.toBeNull();
    expect(alertsOn()).toEqual([]);
    h!.api.userScripts = [stored('sma', SMA, 2)];
    await h!.service.sync();
    await h!.service.whenIdle();
    await settle();
    await h!.service.whenIdle();
    expect(h!.scripts.hold('sma')).toBeNull();
    expect(alertsOn()).toEqual(['a1', 'a2']);
    expect(h!.api.statuses).toEqual([]);
  });

  it('a script edited while its alerts wait restarts them once: pending fires go out once, not twice', async () => {
    await twoSeries();
    const enqueued: string[] = [];
    const enqueue = h!.service.fires.enqueue.bind(h!.service.fires);
    h!.service.fires.enqueue = (job) => {
      enqueued.push(job.body.fireId);
      enqueue(job);
    };
    // A fire the API does not take yet: it is pending in the alert's state.
    h!.api.fireScript = Array.from({ length: 50 }, () => ({ status: 0, drop: true }));
    await tick(120, BAR_T, 100); // sma 106 crosses up 100 on TEST
    await until(() => enqueued.length > 0, 'a fire');
    const fireId = enqueued[0]!;
    const before = enqueued.filter((f) => f === fireId).length;
    await holdTheScript();
    expect(alertsOn()).toEqual([]);
    // The edit ends the hold; the alerts attach from the waiting list and must not restart again.
    h!.api.userScripts = [stored('sma', HANG_ON_VOLUME + '\n// v2', 2)];
    await h!.service.sync();
    await h!.service.whenIdle();
    await settle();
    await h!.service.whenIdle();
    expect(alertsOn()).toEqual(['a1', 'a2']);
    // Resent when the alert came back from waiting, and not a second time by the restart.
    expect(enqueued.filter((f) => f === fireId).length - before).toBeLessThanOrEqual(1);
    h!.api.fireScript = []; // let the stop go through
    await h!.clock.advance(120_000);
  });

  it('repeated faults at the 1 hour cap finally put the alert in error', async () => {
    h = await harness({ env: { ALERTS_SCRIPT_TICK_MS: '100', ALERTS_SCRIPT_LOAD_MS: '300' } });
    h.api.userScripts = [stored('sma', ALWAYS_HANG)];
    h.api.alerts = [makeAlert({ spec: scriptSpec('sma', 'crossingUp', 100) })];
    h.feed.setBars('TEST', '1m', minuteBars(BAR_T, [98, 99, 99]));
    // Five faults before the service runs (no clock timers yet, so waiting is instant): the
    // next one is the second in a row at the 1 hour cap.
    h.scripts.setScripts([{ id: 'sma', source: ALWAYS_HANG, revision: 1 }]);
    const { CTX, bars } = await import('./scripts/test-helpers');
    const open = () =>
      h!.scripts
        .callAsync(
          'sma',
          'open',
          ['k', { ...CTX }, bars(20), [{ hash: 'x', inputs: { length: 3, source: 'close' } }]],
          {
            hashes: new Set(['x']),
            barCount: 20,
          },
        )
        .catch(() => undefined);
    for (let i = 0; i < 5; i++) {
      await open();
      expect(h.scripts.hold('sma')?.final).toBe(false);
      await h.clock.advance(60 * 60_000);
    }
    await h.start();
    await until(() => h!.api.statuses.length === 1, 'error status', 6000);
    expect(lastStatus()).toMatchObject({ status: 'error' });
    expect(lastStatus()?.reason).toMatch(/time limit.*kept failing/);
    expect(h.scripts.hold('sma')?.final).toBe(true);
    // A later alert on the script errors at once.
    h.api.alerts.push(makeAlert({ id: 'a2', spec: scriptSpec('sma', 'crossingUp', 100) }));
    await h.service.sync(['a2']);
    await until(() => h!.api.statuses.length === 2, 'second error');
    expect(h.api.statuses[1]!.body.reason).toMatch(/kept failing/);
  });

  it('a stored manifest that differs from what the script compiles to is an error', async () => {
    const withExtraInput = SMA.replace(
      '    source: {',
      "    extra: { kind: 'bool', label: 'Extra', default: false },\n    source: {",
    );
    expect(withExtraInput).not.toBe(SMA);
    // The web saved SMA's manifest; the stored source is another version.
    await setup([stored('sma', withExtraInput, 1, { manifest: manifestOf('sma', SMA) })]);
    await until(() => h!.api.statuses.length === 1, 'status');
    expect(lastStatus()).toMatchObject({
      status: 'error',
      reason: 'saved manifest is out of date — open and re-save the script',
    });
    expect(h!.api.fires).toHaveLength(0);
  });
});

describe('script runtime in a child process', () => {
  /** Spins in `setup` (long enough to be killed mid-call), then behaves like the SMA. */
  const SLOW_START = SMA.replace(
    'const avg = ta.sma(inputs.length);',
    'const t0 = Date.now(); while (Date.now() - t0 < 1500) {}\n    const avg = ta.sma(inputs.length);',
  );
  const emit = async (symbol: string, price: number) => {
    h!.feed.emit(symbol, 1, bar(BAR_T, price, price, price, price, 100));
    await h!.service.whenIdle();
  };

  it('when the runtime dies the offending script waits, other scripts rebuild and built-in alerts never notice', async () => {
    h = await harness({
      scriptProcess: true,
      env: { ALERTS_SCRIPT_LOAD_MS: '20000', ALERTS_SCRIPT_TICK_MS: '2000' },
    });
    const crossing = (id: string, symbol: string, scriptId?: string) =>
      makeAlert({
        id,
        symbol,
        spec: scriptId
          ? scriptSpec(scriptId, 'crossingUp', 100)
          : {
              schemaVersion: 1,
              left: { kind: 'price', field: 'close' },
              condition: { op: 'crossingUp', right: { kind: 'value', value: 100 } },
              trigger: 'everyTime',
            },
      });
    h.api.userScripts = [stored('good', SMA), stored('bad', SLOW_START)];
    h.api.alerts = [crossing('builtin', 'TEST'), crossing('good', 'GOOD', 'good')];
    for (const s of ['TEST', 'GOOD', 'BAD'])
      h.feed.setBars(s, '1m', minuteBars(BAR_T, [98, 99, 99]));
    await h.start();
    expect(h.service.series().map((s) => s.state)).toEqual(['ready', 'ready']);

    // The bad script starts; the runtime is killed while it runs.
    h.api.alerts.push(crossing('bad', 'BAD', 'bad'));
    const syncing = h.service.sync(['bad']);
    await new Promise((r) => setTimeout(r, 400));
    const child = h.scripts.childProcess();
    expect(child).not.toBeNull();
    child!.kill('SIGKILL');
    await syncing;
    await until(() => h!.service.waiting().some((w) => w.alertId === 'bad'), 'bad to wait', 10_000);
    expect(h.api.statuses).toEqual([]); // waiting, not error
    expect(h.scripts.hold('bad')?.reason).toMatch(/script runtime/);
    expect(h.scripts.hold('good')).toBeNull(); // no call in flight: not blamed

    // Built-in alerts did not notice; the good script rebuilds in the restarted runtime.
    await emit('TEST', 90);
    await emit('TEST', 120);
    await until(() => h!.api.fires.some((f) => f.id === 'builtin'), 'the built-in alert to fire');
    for (let i = 0; i < 8 && !h.api.fires.some((f) => f.id === 'good'); i++) {
      await emit('GOOD', 90);
      await emit('GOOD', 120);
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(h.api.fires.some((f) => f.id === 'good')).toBe(true);
    expect(h.api.statuses).toEqual([]);

    // After its hold the bad script is tried again (it behaves this time), no tight loop before.
    await h.clock.advance(5 * 60_000 + 11_000);
    await until(() => h!.service.waiting().length === 0, 'bad to resume', 15_000);
    await h.service.whenIdle();
    expect(h.service.series().some((s) => s.runners.has('bad'))).toBe(true);
    expect(h.api.statuses).toEqual([]);
  }, 90_000);
});

describe('a slow script does not hold up the built-in alerts on its series', () => {
  it('the price alert fires at once; the script alert samples when its values arrive', async () => {
    const SPIN = SMA.replace(
      "c.set('ma', avg.update(c.src.source[c.i]));",
      "if (c.volume[c.i] > 1000) { const t = Date.now(); while (Date.now() - t < 700) {} }\n      c.set('ma', avg.update(c.src.source[c.i]));",
    );
    expect(SPIN).not.toBe(SMA);
    const price = makeAlert({
      id: 'price',
      spec: {
        schemaVersion: 1,
        left: { kind: 'price', field: 'close' },
        condition: { op: 'crossingUp', right: { kind: 'value', value: 100 } },
        trigger: 'everyTime',
      },
    });
    await setup(
      [stored('sma', SPIN)],
      makeAlert({ id: 'script', spec: scriptSpec('sma', 'crossingUp', 100) }),
      [98, 99, 99],
      { ALERTS_SCRIPT_TICK_MS: '3000', ALERTS_SCRIPT_LOAD_MS: '10000' },
    );
    h!.api.alerts.push(price);
    await h!.service.sync();
    await h!.service.whenIdle();
    const t0 = Date.now();
    h!.feed.emit('TEST', 1, bar(BAR_T, 110, 110, 110, 110, 5000)); // not awaited
    await until(() => h!.api.fires.some((f) => f.id === 'price'), 'the price alert', 600);
    expect(Date.now() - t0).toBeLessThan(500); // the script needs 700 ms
    expect(h!.api.fires.some((f) => f.id === 'script')).toBe(false);
    await until(() => h!.api.fires.some((f) => f.id === 'script'), 'the script alert', 5000);
    expect(h!.api.statuses).toEqual([]);
  });
});
