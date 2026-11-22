/** The isolates in a child process: a script that makes V8 abort ends the child, not the service. */
import { afterEach, describe, expect, it } from 'vitest';
import { parseFromChild } from './childProtocol';
import { closeHandle } from './isolates';
import { childEntry } from './childBundle';
import {
  FAULT_RETRY_MIN_MS,
  SOFT_HOLD_MS,
  ScriptFault,
  ScriptHost,
  type ScriptHostOptions,
} from './host';
import { ScriptCrashed } from './errors';
import { CTX, bars, golden } from './test-helpers';
import type { SeriesResult } from './protocol';
import { FakeClock } from '../test-utils';
import { createLogger } from '../log';

let host: ScriptHost | null = null;
const lines: string[] = [];
afterEach(() => {
  host?.dispose();
  host = null;
  lines.length = 0;
});

type ProcessOver = Partial<
  Extract<Parameters<typeof ScriptHost.createIsolated>[0], { process: unknown }>['process']
>;

async function make(
  over: Partial<Pick<ScriptHostOptions, 'memoryMb' | 'loadMs' | 'tickMs'>> = {},
  proc: ProcessOver = {},
) {
  const clock = new FakeClock(1_800_000_000_000);
  const h = await ScriptHost.createIsolated({
    memoryMb: 128,
    loadMs: 10_000,
    tickMs: 500,
    clock,
    log: createLogger('debug', (l) => lines.push(l)),
    ...over,
    process: { entry: childEntry, processMb: 768, restartMinMs: 50, restartMaxMs: 200, ...proc },
  } as Parameters<typeof ScriptHost.createIsolated>[0]);
  host = h;
  return { h, clock };
}

function script(opts: { setup?: string; step?: string } = {}): string {
  return `defineIndicator({
    id: 'x', name: 'X', shortName: 'X', category: 'other', overlay: false, inputs: {},
    outputs: [{ type: 'plot', id: 'v', title: 'V', kind: 'line', color: '#fff' }],
    setup() { ${opts.setup ?? ''}; return (c) => { ${opts.step ?? "c.set('v', c.close[c.i]);"} }; },
  });`;
}

const open = (h: ScriptHost, id: string, key = 'k', n = 20) =>
  h.callAsync<SeriesResult>(id, 'open', [key, { ...CTX }, bars(n), [{ hash: 'h', inputs: {} }]], {
    hashes: new Set(['h']),
    barCount: n,
  });

const until = async (cond: () => boolean, what: string, ms = 8000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('isolates in a child process', () => {
  it('compute like in-process: values, Float64Array results in the parent realm', async () => {
    const { h } = await make();
    h.setScripts([{ id: 'sma', source: golden('sma'), revision: 1 }]);
    const r = await h.callAsync<SeriesResult>(
      'sma',
      'open',
      ['k', { ...CTX }, bars(100), [{ hash: 'h', inputs: { length: 3, source: 'close' } }]],
      { hashes: new Set(['h']), barCount: 100 },
    );
    expect(r.value.errors).toEqual({});
    expect(r.value.updates[0]!.values['ma']).toBeInstanceOf(Float64Array);
    const t = await h.callAsync<SeriesResult>(
      'sma',
      'updateBar',
      ['k', 99, { time: 1, open: 1, high: 1, low: 1, close: 5, volume: 1 }],
      { hashes: new Set(['h']), barCount: 100 },
      r.epoch,
      true,
    );
    expect(t.value.updates[0]!.from).toBe(99);
    expect(h.childProcess()?.pid).toBeGreaterThan(0);
  });

  it.each([
    ['a Set that grows without bound', 'const m = new Set(); for (let i = 0; ; i++) m.add(i);'],
    ['an object that gets a key per step', "const m = {}; for (let i = 0; ; i++) m['k' + i] = i;"],
    ['a list of WeakRefs', 'const m = []; for (let i = 0; ; i++) m.push(new WeakRef({ i }));'],
  ])(
    '%s aborts the child, not the service: the script is faulted and held',
    async (_n, body) => {
      const { h, clock } = await make({ memoryMb: 128 });
      h.setScripts([{ id: 'bad', source: script({ setup: body }), revision: 1 }]);
      const before = h.childProcess()?.pid;
      const err = (await open(h, 'bad').catch((e: unknown) => e)) as ScriptFault;
      expect(err).toBeInstanceOf(ScriptFault);
      // V8 aborts the child (a crash) or, depending on its version, stops the isolate at its limit.
      expect(['crash', 'memory']).toContain(err.kind);
      expect(err.reason).toMatch(/script runtime|memory limit/);
      expect(err.retryAt).toBe(clock.now() + FAULT_RETRY_MIN_MS);
      expect(h.hold('bad')).not.toBeNull();
      expect(before).toBeGreaterThan(0);
      // The parent is alive and the runtime comes back for another script.
      h.setScripts([
        { id: 'bad', source: script({ setup: body }), revision: 1 },
        { id: 'sma', source: golden('sma'), revision: 1 },
      ]);
      const ok = await h.callAsync<SeriesResult>(
        'sma',
        'open',
        ['k', { ...CTX }, bars(30), [{ hash: 'h', inputs: { length: 3, source: 'close' } }]],
        { hashes: new Set(['h']), barCount: 30 },
      );
      expect(ok.value.errors).toEqual({});
      if (err.kind === 'crash') {
        expect(h.childProcess()?.pid).not.toBe(before);
        expect(lines.some((l) => l.includes('script runtime process ended'))).toBe(true);
      }
    },
    60_000,
  );

  it('the same script crashes it again after the hold, with a longer hold: no tight crash loop', async () => {
    const { h, clock } = await make();
    const src = script({ setup: 'const m = new Set(); for (let i = 0; ; i++) m.add(i);' });
    h.setScripts([{ id: 'bad', source: src, revision: 1 }]);
    const waits: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t = clock.now();
      const err = (await open(h, 'bad').catch((e: unknown) => e)) as ScriptFault;
      waits.push((err.retryAt - t) / 60_000);
      // Calls during the hold fail at once, without touching the child.
      const pid = h.childProcess()?.pid;
      await expect(open(h, 'bad')).rejects.toThrow(/disabled/);
      expect(h.childProcess()?.pid).toBe(pid);
      await clock.advance(err.retryAt - t);
    }
    expect(waits).toEqual([5, 10, 20]);
  }, 90_000);

  it('a crash with no call in flight is not attributed; three in 10 minutes hold every script', async () => {
    const { h } = await make();
    h.setScripts([
      { id: 'a', source: script(), revision: 1 },
      { id: 'b', source: script(), revision: 1 },
    ]);
    const crash = async () => {
      expect(await h.ensure('a')).toMatchObject({ ok: true });
      const child = h.childProcess()!;
      child.kill('SIGKILL');
      await until(() => h.childProcess() === null, 'the child to be reaped');
    };
    await crash();
    await crash();
    expect(h.hold('a')).toBeNull();
    expect(h.hold('b')).toBeNull();
    await crash();
    expect(h.hold('a')).not.toBeNull();
    expect(h.hold('b')).not.toBeNull();
    expect(h.hold('a')!.reason).toMatch(/kept crashing/);
  }, 60_000);

  it('a child that stops answering pings is killed', async () => {
    const { h } = await make({}, { pingMs: 40, pongTimeoutMs: 160 });
    h.setScripts([{ id: 'a', source: script(), revision: 1 }]);
    await h.ensure('a');
    const child = h.childProcess()!;
    child.kill('SIGSTOP'); // frozen: cannot answer
    await until(() => h.childProcess() === null, 'the frozen child to be killed');
    expect(lines.some((l) => /did not answer/.test(l))).toBe(true);
  }, 30_000);

  it('a child over its memory cap is killed', async () => {
    const { h } = await make(
      { memoryMb: 512 },
      { pingMs: 40, pongTimeoutMs: 2000, processMb: 150 },
    );
    h.setScripts([
      {
        id: 'big',
        source: script({ setup: 'globalThis.a = new Float64Array(3e7).fill(1);' }),
        revision: 1,
      },
    ]);
    await open(h, 'big').catch(() => undefined);
    await until(() => h.childProcess() === null, 'the child to be killed for its memory');
    expect(lines.some((l) => /over its 150 MB limit/.test(l))).toBe(true);
  }, 30_000);

  it('malformed messages from the child are rejected and the child is not trusted any more', async () => {
    const { h } = await make();
    h.setScripts([{ id: 'a', source: script(), revision: 1 }]);
    await h.ensure('a');
    const child = h.childProcess()!;
    // Unknown request ids are ignored (the host stopped waiting): the child lives.
    child.emit('message', { t: 'result', rid: 123456, raw: {}, cpuMs: 1 });
    expect(h.childProcess()).toBe(child);
    for (const bad of [
      'x',
      null,
      [],
      { t: 'nope' },
      { t: 'result', rid: 'x', raw: 1, cpuMs: 1 },
      { t: 'result', rid: 1, raw: 1, cpuMs: NaN },
      { t: 'pong', rss: -1, isolates: [] },
      { t: 'pong', rss: 1 },
      { t: 'err', rid: 1, message: 7, dead: true },
    ]) {
      const { h: h2 } = await make();
      h2.setScripts([{ id: 'a', source: script(), revision: 1 }]);
      await h2.ensure('a');
      const c = h2.childProcess()!;
      expect(() => c.emit('message', bad)).not.toThrow();
      await until(() => h2.childProcess() === null, 'the child to be dropped');
      h2.dispose();
    }
  }, 60_000);

  it('a call in flight when the child dies is rejected as a crash of that script', async () => {
    const { h } = await make({ loadMs: 20_000 });
    h.setScripts([
      {
        id: 'slow',
        source: script({ setup: 'const t = Date.now(); while (Date.now() - t < 5000) {}' }),
        revision: 1,
      },
    ]);
    const call = open(h, 'slow').catch((e: unknown) => e);
    await until(() => h.childProcess() !== null && h.epoch('slow') >= 2, 'the call to run');
    await new Promise((r) => setTimeout(r, 150));
    h.childProcess()!.kill('SIGKILL');
    const err = (await call) as ScriptFault;
    expect(err).toBeInstanceOf(ScriptFault);
    expect(err.kind).toBe('crash');
    expect(ScriptCrashed.name).toBe('ScriptCrashed');
  }, 30_000);
});

describe('who is blamed when the process dies', () => {
  const SLOW = script({ setup: 'const t = Date.now(); while (Date.now() - t < 4000) {}' });
  const bothInFlight = async (h: ScriptHost) => {
    const calls = ['one', 'two'].map((id) => open(h, id).catch((e: unknown) => e));
    await until(() => h.epoch('one') >= 2 && h.epoch('two') >= 2, 'both isolates to exist');
    await new Promise((r) => setTimeout(r, 200));
    h.childProcess()!.kill('SIGKILL');
    return (await Promise.all(calls)) as ScriptFault[];
  };

  it('a script that only shared the process gets a short hold that does not count; a repeat offender does', async () => {
    const { h, clock } = await make({ loadMs: 20_000 });
    h.setScripts([
      { id: 'one', source: SLOW, revision: 1 },
      { id: 'two', source: SLOW, revision: 1 },
    ]);
    const first = await bothInFlight(h);
    for (const err of first) {
      expect(err).toBeInstanceOf(ScriptFault);
      expect(err.retryAt).toBe(clock.now() + SOFT_HOLD_MS);
      expect(err.final).toBe(false);
      expect(err.reason).toMatch(/another script is the likelier cause/);
    }
    await clock.advance(SOFT_HOLD_MS);
    // Again, both in flight: each was in flight at 2 of the last 3 deaths now.
    const second = await bothInFlight(h);
    for (const err of second) expect(err.retryAt).toBe(clock.now() + FAULT_RETRY_MIN_MS); // 5 min: the first hold did not count
  }, 60_000);

  it('the only script in flight is blamed at once', async () => {
    const { h, clock } = await make({ loadMs: 20_000 });
    h.setScripts([{ id: 'one', source: SLOW, revision: 1 }]);
    const call = open(h, 'one').catch((e: unknown) => e);
    await until(() => h.epoch('one') >= 2, 'the isolate');
    await new Promise((r) => setTimeout(r, 200));
    h.childProcess()!.kill('SIGKILL');
    const err = (await call) as ScriptFault;
    expect(err.retryAt).toBe(clock.now() + FAULT_RETRY_MIN_MS);
  }, 30_000);

  it('killed for memory: the largest isolate is blamed, a script merely in flight is not', async () => {
    const { h, clock } = await make(
      { memoryMb: 512, loadMs: 20_000 },
      { pingMs: 40, pongTimeoutMs: 5000, processMb: 150 },
    );
    h.setScripts([
      { id: 'small', source: script(), revision: 1 },
      {
        id: 'big',
        source: script({ setup: 'globalThis.a = new Float64Array(3e7).fill(1);' }),
        revision: 1,
      },
      { id: 'slow', source: SLOW, revision: 1 },
    ]);
    await open(h, 'small');
    const slow = open(h, 'slow').catch((e: unknown) => e);
    await open(h, 'big').catch(() => undefined);
    await until(() => h.childProcess() === null, 'the child to be killed for its memory');
    expect(lines.some((l) => /over its 150 MB limit/.test(l))).toBe(true);
    expect(h.hold('big')?.retryAt).toBe(clock.now() + FAULT_RETRY_MIN_MS);
    expect(h.hold('small')).toBeNull();
    const err = (await slow) as ScriptFault;
    expect(err.retryAt).toBe(clock.now() + SOFT_HOLD_MS); // in flight, but not the culprit
  }, 30_000);
});

describe('room for isolates', () => {
  const many = (h: ScriptHost, n: number) =>
    h.setScripts(
      Array.from({ length: n }, (_, i) => ({ id: `s${i}`, source: script(), revision: 1 })),
    );

  it('gives up the least recently used idle isolate instead of growing into the memory kill', async () => {
    const { h } = await make({}, { pingMs: 40, processMb: 128, evictIdleMs: 0 });
    many(h, 8);
    await open(h, 's0');
    const pid = h.childProcess()!.pid;
    for (let i = 1; i < 8; i++) await open(h, `s${i}`);
    await new Promise((r) => setTimeout(r, 200));
    expect(h.childProcess()?.pid).toBe(pid); // never killed, never restarted
    expect(lines.filter((l) => l.includes('given up to make room')).length).toBeGreaterThan(0);
    // The first one lost its isolate: its series would be rebuilt when it is next needed.
    await expect(
      h.callAsync('s0', 'close', ['k'], undefined, h.epoch('s0'), true),
    ).rejects.toBeDefined();
    expect(h.hold('s0')).toBeNull();
    expect((await open(h, 's0')).value.errors).toEqual({});
  }, 60_000);

  it('refuses when nothing can be given up: the alerts wait, nothing restarts', async () => {
    const { h, clock } = await make({}, { pingMs: 40, processMb: 128, evictIdleMs: 3_600_000 });
    many(h, 6);
    const results: unknown[] = [];
    for (let i = 0; i < 6; i++) results.push(await open(h, `s${i}`).catch((e: unknown) => e));
    const refused = results.filter((r) => r instanceof ScriptFault) as ScriptFault[];
    expect(refused.length).toBeGreaterThan(0);
    for (const r of refused) {
      expect(r.kind).toBe('capacity');
      expect(r.reason).toMatch(/too many scripts in use — raise ALERTS_SCRIPT_PROCESS_MB/);
      expect(r.retryAt).toBe(clock.now() + 60_000);
      expect(r.final).toBe(false);
    }
    expect(lines.some((l) => l.includes('script runtime process ended'))).toBe(false);
  }, 60_000);
});

describe('handles sent over the channel', () => {
  it('are closed, never kept: by the parent, and by the helper the child uses', async () => {
    const { h } = await make();
    h.setScripts([{ id: 'a', source: script(), revision: 1 }]);
    await h.ensure('a');
    const child = h.childProcess()!;
    let closed = 0;
    child.emit(
      'message',
      { t: 'result', rid: 999999, raw: 1, cpuMs: 0 },
      { destroy: () => closed++ },
    );
    child.emit(
      'message',
      { t: 'result', rid: 999999, raw: 1, cpuMs: 0 },
      { close: () => closed++ },
    );
    expect(closed).toBe(2);
    expect(h.childProcess()).toBe(child); // a handle alone is not a reason to drop the child
    expect(() => closeHandle(undefined)).not.toThrow();
    expect(() =>
      closeHandle({
        destroy: () => {
          throw new Error('x');
        },
      }),
    ).not.toThrow();
  }, 30_000);
});

describe('parseFromChild', () => {
  it('accepts the messages the child sends and nothing else', () => {
    expect(parseFromChild({ t: 'ready' })).toEqual({ t: 'ready' });
    expect(parseFromChild({ t: 'pong', rss: 5, isolates: [{ iso: 1, bytes: 9 }] })).toEqual({
      t: 'pong',
      rss: 5,
      isolates: [{ iso: 1, bytes: 9 }],
    });
    expect(parseFromChild({ t: 'pong', rss: 5 })).toBeNull();
    expect(parseFromChild({ t: 'pong', rss: 5, isolates: [{ iso: 1, bytes: -1 }] })).toBeNull();
    expect(parseFromChild({ t: 'pong', rss: 5, isolates: [3] })).toBeNull();
    expect(parseFromChild({ t: 'created', rid: 1, iso: 2 })).toEqual({
      t: 'created',
      rid: 1,
      iso: 2,
    });
    expect(parseFromChild({ t: 'result', rid: 1, raw: { a: 1 }, cpuMs: -5 })).toEqual({
      t: 'result',
      rid: 1,
      raw: { a: 1 },
      cpuMs: 0,
    });
    const long = parseFromChild({ t: 'err', rid: 1, message: 'x'.repeat(5000), dead: false });
    expect(long && long.t === 'err' && long.message.length).toBe(1000);
    for (const bad of [
      undefined,
      3,
      'ready',
      { t: 'ready2' },
      { t: 'created', rid: -1, iso: 1 },
      { t: 'created', rid: 1.5, iso: 1 },
      { t: 'fatal' },
    ])
      expect(parseFromChild(bad)).toBeNull();
  });
});
