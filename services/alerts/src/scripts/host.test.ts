import { afterEach, describe, expect, it } from 'vitest';
import { IndicatorRuntime, calendarPeriod } from '@tickerglass/indicators';
import {
  FAULT_RETRY_MAX_MS,
  FAULT_RETRY_MIN_MS,
  HEALTHY_RESET_MS,
  MANIFEST_STALE,
  ScriptCallError,
  ScriptFault,
  ScriptHost,
  ScriptStrike,
  ScriptSuperseded,
  ScriptUnavailable,
  manifestMatches,
  type ScriptHold,
} from './host';
import type { Ivm } from './isolates';
import { UserSeries } from './userSeries';
import { CTX, bars, barAt, golden, makeHost, manifestOf, slice } from './test-helpers';
import type { Columns, SeriesResult } from './protocol';
import { FakeClock } from '../test-utils';
import { silentLogger } from '../log';

let host: ScriptHost | null = null;
afterEach(() => {
  host?.dispose();
  host = null;
});

async function setup(
  over: Parameters<typeof makeHost>[0] = {},
): Promise<{ host: ScriptHost; clock: FakeClock }> {
  const r = await makeHost(over);
  host = r.host;
  return r;
}

/** A UserSeries over `cols`, which the test grows like a live series does. */
function userSeries(h: ScriptHost, cols: { current: Columns }, key = 'TEST|1m|0'): UserSeries {
  return new UserSeries(key, h, {
    columns: () => cols.current,
    context: () => ({ ...CTX }),
    time: (i) => cols.current.time[i] ?? NaN,
    length: () => cols.current.time.length,
  });
}

const useScript = (h: ScriptHost, id: string, source: string, revision = 1) =>
  h.setScripts([{ id, source, revision }]);

describe('golden scripts in the isolate match the built-ins', () => {
  const CASES = [
    { script: 'sma', builtin: 'sma', inputs: { length: 9, source: 'close' }, out: ['ma'] },
    { script: 'rsi', builtin: 'rsi', inputs: {}, out: ['rsi'] },
    { script: 'macd', builtin: 'macd', inputs: {}, out: ['macd', 'signal'] },
  ] as const;

  it.each(CASES)('$script: full compute', async ({ script, builtin, inputs, out }) => {
    const { host: h } = await setup();
    useScript(h, script, golden(script));
    const cols = { current: bars(400) };
    const us = userSeries(h, cols);
    await us.add([{ hash: 'h1', type: `user:${script}`, inputs }]);
    expect(us.error('h1')).toBeNull();
    const rt = new IndicatorRuntime({ context: CTX });
    rt.add({ id: 'b', type: builtin, inputs });
    rt.setBars(cols.current);
    const res = rt.result('b')!;
    for (const o of out)
      for (let i = 0; i < 400; i++) {
        const want = res.values[o]![i]!;
        const got = us.value('h1', o, i);
        if (Number.isNaN(want)) expect(got, `${o}[${i}]`).toBeNaN();
        else expect(got, `${o}[${i}]`).toBeCloseTo(want, 9);
      }
  });

  it.each(CASES)('$script: incremental updates', async ({ script, builtin, inputs, out }) => {
    const { host: h } = await setup();
    useScript(h, script, golden(script));
    const all = bars(400);
    const K = 60;
    const cols = { current: slice(all, 0, 400 - K) };
    const us = userSeries(h, cols);
    await us.add([{ hash: 'h1', type: `user:${script}`, inputs }]);
    expect(us.error('h1')).toBeNull();
    for (let i = 400 - K; i < 400; i++) {
      const b = barAt(all, i);
      cols.current = slice(all, 0, i + 1);
      // The opening tick, then the final value, as live bars arrive.
      us.updateBar(i, { ...b, high: b.open, low: b.open, close: b.open, volume: b.volume * 0.1 });
      await us.settled();
      us.updateBar(i, b);
      await us.settled();
    }
    const rt = new IndicatorRuntime({ context: CTX });
    rt.add({ id: 'b', type: builtin, inputs });
    rt.setBars(all);
    const res = rt.result('b')!;
    for (const o of out)
      for (let i = 0; i < 400; i++) {
        const want = res.values[o]![i]!;
        const got = us.value('h1', o, i);
        if (Number.isNaN(want)) expect(got, `${o}[${i}]`).toBeNaN();
        else expect(got, `${o}[${i}]`).toBeCloseTo(want, 9);
      }
  });

  it('setBars after a restatement recomputes everything', async () => {
    const { host: h } = await setup();
    useScript(h, 'sma', golden('sma'));
    const cols = { current: bars(200) };
    const us = userSeries(h, cols);
    await us.add([{ hash: 'h1', type: 'user:sma', inputs: { length: 5, source: 'close' } }]);
    const before = us.value('h1', 'ma', 199);
    cols.current = bars(200, 7);
    await us.setBars(cols.current);
    expect(us.value('h1', 'ma', 199)).not.toBe(before);
    const rt = new IndicatorRuntime({ context: CTX });
    rt.add({ id: 'b', type: 'sma', inputs: { length: 5, source: 'close' } });
    rt.setBars(cols.current);
    expect(us.value('h1', 'ma', 199)).toBeCloseTo(rt.result('b')!.values['ma']![199]!, 9);
  });

  it('two instances of one script share an isolate and a series', async () => {
    const { host: h } = await setup();
    useScript(h, 'sma', golden('sma'));
    const cols = { current: bars(100) };
    const us = userSeries(h, cols);
    await us.add([
      { hash: 'a', type: 'user:sma', inputs: { length: 3, source: 'close' } },
      { hash: 'b', type: 'user:sma', inputs: { length: 10, source: 'close' } },
    ]);
    expect(us.value('a', 'ma', 99)).not.toBe(us.value('b', 'ma', 99));
    us.remove('a');
    expect(us.has('a')).toBe(false);
    expect(us.has('b')).toBe(true);
    expect(us.value('b', 'ma', 99)).not.toBeNaN();
    us.remove('b');
    expect(us.size).toBe(0);
  });
});

describe('isolation', () => {
  it('has no process, require, fetch, timers or host constructors', async () => {
    const { host: h } = await setup();
    // The script throws at load when anything leaks, so a compile error names the leak.
    const probe = `
      const leaks = [];
      for (const name of ['process', 'require', 'module', 'Buffer', 'fetch', 'setTimeout',
        'setInterval', 'setImmediate', 'queueMicrotask', 'WebSocket', 'XMLHttpRequest',
        'global', 'importScripts', '__tg', 'ivm', 'Worker', 'navigator', 'window', 'self'])
        if (typeof globalThis[name] !== 'undefined') leaks.push(name);
      for (const code of ['return process', 'return require', 'return globalThis.process',
        'return this.process']) {
        try {
          const v = globalThis.constructor.constructor(code)();
          if (v !== undefined) leaks.push('escape:' + code);
        } catch (e) { /* ReferenceError: good */ }
      }
      try {
        const F = (function () {}).constructor;
        if (typeof F('return typeof process')() !== 'string' || F('return typeof process')() !== 'undefined')
          leaks.push('Function sees process');
      } catch (e) { leaks.push('Function threw'); }
      if (typeof Object.getPrototypeOf(async function () {}).constructor('return typeof process')
        !== 'function') leaks.push('AsyncFunction missing');
      if (leaks.length) throw new Error('LEAK: ' + leaks.join(','));
      defineIndicator({
        id: 'x', name: 'Probe', shortName: 'P', category: 'other', overlay: false,
        inputs: {},
        outputs: [{ type: 'plot', id: 'v', title: 'V', kind: 'line', color: '#fff' }],
        setup() { return (c) => c.set('v', 1); },
      });`;
    useScript(h, 'probe', probe);
    const r = await h.ensure('probe');
    expect(r).toEqual(expect.objectContaining({ ok: true }));
  });

  it('a script cannot reach the host API object', async () => {
    const { host: h } = await setup();
    const src = `
      if (typeof globalThis.__tg !== 'undefined') throw new Error('LEAK: __tg');
      defineIndicator({
        id: 'x', name: 'Probe', shortName: 'P', category: 'other', overlay: false,
        inputs: {},
        outputs: [{ type: 'plot', id: 'v', title: 'V', kind: 'line', color: '#fff' }],
        setup() { return (c) => c.set('v', 1); },
      });`;
    useScript(h, 'probe', src);
    expect(await h.ensure('probe')).toMatchObject({ ok: true });
  });

  it('script state never leaks between isolates', async () => {
    const { host: h } = await setup();
    const src = (n: number) => `
      globalThis.shared = (globalThis.shared || 0) + ${n};
      defineIndicator({
        id: 'x', name: 'Probe', shortName: 'P', category: 'other', overlay: false,
        inputs: {},
        outputs: [{ type: 'plot', id: 'v', title: 'V', kind: 'line', color: '#fff' }],
        setup() { return (c) => c.set('v', globalThis.shared); },
      });`;
    h.setScripts([
      { id: 'a', source: src(1), revision: 1 },
      { id: 'b', source: src(10), revision: 1 },
    ]);
    const cols = { current: bars(10) };
    const us = userSeries(h, cols);
    await us.add([
      { hash: 'ha', type: 'user:a', inputs: {} },
      { hash: 'hb', type: 'user:b', inputs: {} },
    ]);
    expect(us.value('ha', 'v', 5)).toBe(1);
    expect(us.value('hb', 'v', 5)).toBe(10);
  });
});

describe('limits', () => {
  const HANG = `
    defineIndicator({
      id: 'x', name: 'Hang', shortName: 'H', category: 'other', overlay: false,
      inputs: { hang: { kind: 'bool', label: 'Hang', default: false } },
      outputs: [{ type: 'plot', id: 'v', title: 'V', kind: 'line', color: '#fff' }],
      setup({ inputs }) {
        return (c) => {
          if (inputs.hang && c.i === 5) { while (true) {} }
          c.set('v', c.close[c.i]);
        };
      },
    });`;

  it('an infinite loop times out, the isolate is replaced and a later retry works', async () => {
    const { host: h, clock } = await setup({ loadMs: 400, tickMs: 100 });
    useScript(h, 'hang', HANG);
    const cols = { current: bars(20) };
    const us = userSeries(h, cols);
    const faults: string[] = [];
    h.onFault((id, reason) => faults.push(`${id}: ${reason}`));
    const first = h.epoch('hang');
    await us.add([{ hash: 'bad', type: 'user:hang', inputs: { hang: true } }]);
    expect(us.held('bad')).toMatch(/time limit/);
    expect(us.error('bad')).toBeNull();
    expect(faults).toHaveLength(1);
    expect(faults[0]).toMatch(/^hang: script exceeded its time limit/);

    // Disabled for 5 minutes: new instances fail at once, without a new isolate.
    const epoch = h.epoch('hang');
    expect(epoch).toBeGreaterThan(first);
    await us.add([{ hash: 'good', type: 'user:hang', inputs: { hang: false } }]);
    expect(us.held('good')).toMatch(/disabled for \d+ more min/);
    expect(h.epoch('hang')).toBe(epoch);
    expect(h.unavailable('hang')).toMatch(/disabled/);

    await clock.advance(5 * 60_000 + 1);
    expect(h.unavailable('hang')).toBeNull();
    const us2 = userSeries(h, cols);
    await us2.add([{ hash: 'good', type: 'user:hang', inputs: { hang: false } }]);
    expect(us2.error('good')).toBeNull();
    expect(us2.value('good', 'v', 19)).toBe(cols.current.close[19]);
    expect(h.epoch('hang')).toBeGreaterThan(epoch);
  });

  it('backs off: 5 min, then 10 min after a repeat', async () => {
    const { host: h, clock } = await setup({ loadMs: 300, tickMs: 100 });
    useScript(h, 'hang', HANG);
    const cols = { current: bars(10) };
    const bad = [{ hash: 'bad', type: 'user:hang', inputs: { hang: true } }];
    await userSeries(h, cols).add(bad);
    await clock.advance(5 * 60_000 + 1);
    await userSeries(h, cols).add(bad); // faults again
    await clock.advance(5 * 60_000 + 1);
    expect(h.unavailable('hang')).toMatch(/disabled/);
    await clock.advance(5 * 60_000);
    expect(h.unavailable('hang')).toBeNull();
  });

  it('a new revision of the script ends the disabled period at once', async () => {
    const { host: h } = await setup({ loadMs: 300, tickMs: 100 });
    useScript(h, 'hang', HANG);
    const cols = { current: bars(10) };
    await userSeries(h, cols).add([{ hash: 'bad', type: 'user:hang', inputs: { hang: true } }]);
    expect(h.unavailable('hang')).toMatch(/disabled/);
    useScript(h, 'hang', HANG.replace('while (true) {}', ''), 2);
    expect(h.unavailable('hang')).toBeNull();
    const us = userSeries(h, cols);
    await us.add([{ hash: 'ok', type: 'user:hang', inputs: { hang: true } }]);
    expect(us.error('ok')).toBeNull();
  });

  it('an infinite loop while a bar updates is cut off at the tick limit', async () => {
    const { host: h } = await setup({ loadMs: 5000, tickMs: 100 });
    useScript(h, 'hang', HANG.replace('c.i === 5', 'c.i === 12 && c.close[c.i] === 12345'));
    const all = bars(20);
    const cols = { current: slice(all, 0, 12) };
    const us = userSeries(h, cols);
    await us.add([{ hash: 'h', type: 'user:hang', inputs: { hang: true } }]);
    expect(us.error('h')).toBeNull();
    cols.current = slice(all, 0, 13);
    const t0 = Date.now();
    us.updateBar(12, { ...barAt(all, 12), close: 12345 });
    await us.settled();
    expect(Date.now() - t0).toBeLessThan(2000);
    // One timed-out update is a strike: no error, no hold, the series rebuilds on its next bar.
    expect(us.error('h')).toBeNull();
    expect(us.held('h')).toBeNull();
    expect(h.unavailable('hang')).toBeNull();
    cols.current = slice(all, 0, 13);
    us.updateBar(12, { ...barAt(all, 12), close: 100 });
    await us.settled();
    expect(us.error('h')).toBeNull();
    expect(us.value('h', 'v', 12)).toBe(cols.current.close[12]); // rebuilt (the isolate was kept)
  });

  it('a load-time infinite loop is a fault, not a hang', async () => {
    const { host: h } = await setup({ loadMs: 300 });
    useScript(h, 'loop', 'while (true) {}');
    const r = await h.ensure('loop');
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ reason: expect.stringMatching(/time limit/) });
  });

  it('a memory bomb hits the heap limit and is handled', async () => {
    const { host: h } = await setup({ memoryMb: 24, loadMs: 8000, tickMs: 500 });
    const src = `
      defineIndicator({
        id: 'x', name: 'Bomb', shortName: 'B', category: 'other', overlay: false,
        inputs: { bomb: { kind: 'bool', label: 'Bomb', default: false } },
        outputs: [{ type: 'plot', id: 'v', title: 'V', kind: 'line', color: '#fff' }],
        setup({ inputs }) {
          const keep = [];
          return (c) => {
            if (inputs.bomb && c.i === 3) for (;;) keep.push(new Array(100000).fill(c.i));
            c.set('v', 1);
          };
        },
      });`;
    useScript(h, 'bomb', src);
    const cols = { current: bars(10) };
    const faults: string[] = [];
    h.onFault((_id, reason) => faults.push(reason));
    const us = userSeries(h, cols);
    await us.add([{ hash: 'b', type: 'user:bomb', inputs: { bomb: true } }]);
    expect(us.held('b')).toMatch(/memory limit/);
    expect(faults[0]).toMatch(/memory limit \(24 MB\)/);
    // The host survived: another script still runs.
    useScript(h, 'bomb', src, 1);
    h.setScripts([
      { id: 'bomb', source: src, revision: 1 },
      { id: 'sma', source: golden('sma'), revision: 1 },
    ]);
    const us2 = userSeries(h, cols);
    await us2.add([{ hash: 's', type: 'user:sma', inputs: { length: 3, source: 'close' } }]);
    expect(us2.error('s')).toBeNull();
  });

  it('a throwing script puts its instance in error without a fault', async () => {
    const { host: h } = await setup();
    const faults: string[] = [];
    h.onFault((_id, reason) => faults.push(reason));
    useScript(
      h,
      'boom',
      `defineIndicator({
        id: 'x', name: 'Boom', shortName: 'B', category: 'other', overlay: false,
        inputs: {},
        outputs: [{ type: 'plot', id: 'v', title: 'V', kind: 'line', color: '#fff' }],
        setup() { return (c) => { if (c.i === 4) throw new Error('nope'); c.set('v', 1); }; },
      });`,
    );
    const us = userSeries(h, { current: bars(10) });
    await us.add([{ hash: 'b', type: 'user:boom', inputs: {} }]);
    expect(us.error('b')).toMatch(/nope/);
    expect(faults).toEqual([]);
  });
});

describe('load', () => {
  it('reports a compile error with its line', async () => {
    const { host: h } = await setup();
    useScript(h, 'bad', 'const a = 1;\nconst b = ;\n');
    const r = await h.ensure('bad');
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ reason: expect.stringMatching(/does not compile: SyntaxError/) });
    expect(h.unavailable('bad')).toMatch(/does not compile/);
  });

  it('a missing script is unavailable ("deleted")', async () => {
    const { host: h } = await setup();
    expect(h.unavailable('nope')).toBe('script was deleted');
    await expect(h.callAsync('nope', 'close', ['k'])).rejects.toBeInstanceOf(ScriptUnavailable);
  });

  it('a disabled host refuses every script', async () => {
    const d = ScriptHost.disabled('no runtime', new FakeClock(0), silentLogger);
    d.setScripts([{ id: 'a', source: golden('sma'), revision: 1 }]);
    expect(d.unavailable('a')).toBe('no runtime');
    expect(await d.ensure('a')).toEqual({ ok: false, reason: 'no runtime' });
    d.dispose();
  });
});

describe('Check', () => {
  const STATEFUL = `
    let count = 0; // state outside ta: replays of a live bar count again
    defineIndicator({
      id: 'x', name: 'Stateful', shortName: 'S', category: 'other', overlay: false,
      inputs: {},
      outputs: [{ type: 'plot', id: 'v', title: 'V', kind: 'line', color: '#fff' }],
      setup() { return (c) => { count++; c.set('v', count); }; },
    });`;

  it('detects state kept outside ta with the first mismatch', async () => {
    const { host: h } = await setup();
    useScript(h, 'st', STATEFUL);
    const us = userSeries(h, { current: bars(200) });
    await us.add([{ hash: 's', type: 'user:st', inputs: {} }]);
    const err = us.error('s');
    expect(err).toMatch(/output 'v' differs between a full recompute and live updates/);
    expect(err).toMatch(/keep state in ta/);
  });

  it('passes the golden scripts', async () => {
    const { host: h } = await setup();
    h.setScripts(
      ['sma', 'rsi', 'macd', 'bollinger'].map((id) => ({ id, source: golden(id), revision: 1 })),
    );
    const us = userSeries(h, { current: bars(300) });
    await us.add(
      ['sma', 'rsi', 'macd', 'bollinger'].map((id) => ({
        hash: id,
        type: `user:${id}`,
        inputs: {},
      })),
    );
    for (const id of ['sma', 'rsi', 'macd', 'bollinger']) expect(us.error(id), id).toBeNull();
  });
});

describe('boundary', () => {
  it('results are plain copies (no host object crosses either way)', async () => {
    const { host: h } = await setup();
    useScript(h, 'sma', golden('sma'));
    const all = bars(30);
    const res = await h.callAsync<SeriesResult>(
      'sma',
      'open',
      ['k', { ...CTX }, all, [{ hash: 'h', inputs: { length: 3, source: 'close' } }]],
      { hashes: new Set(['h']), barCount: 30 },
    );
    expect(res.value.updates[0]!.values['ma']).toBeInstanceOf(Float64Array);
    expect(res.value.errors).toEqual({});
    // Functions cannot be passed in.
    await expect(
      h.callAsync(
        'sma',
        'updateBar',
        ['k', 29, () => 1],
        { hashes: new Set(['h']), barCount: 30 },
        undefined,
        true,
      ),
    ).rejects.toBeInstanceOf(ScriptCallError);
    expect(h.unavailable('sma')).toBeNull();
  });

  it('ScriptFault is what a killed call throws', async () => {
    const { host: h } = await setup({ loadMs: 300 });
    useScript(h, 'loop', 'while (true) {}');
    await expect(h.callAsync('loop', 'close', ['k'])).rejects.toBeInstanceOf(ScriptFault);
  });
});

// --------------------------------------------------------------- helpers

/** A script with `top` before `defineIndicator`, `setupBody` in `setup` and `step` per bar. */
function script(opts: { top?: string; setup?: string; step?: string } = {}): string {
  return `${opts.top ?? ''}
    defineIndicator({
      id: 'x', name: 'X', shortName: 'X', category: 'other', overlay: false,
      inputs: { hang: { kind: 'bool', label: 'Hang', default: false } },
      outputs: [{ type: 'plot', id: 'v', title: 'V', kind: 'line', color: '#fff' }],
      setup({ inputs }) { ${opts.setup ?? ''}; return (c) => { ${opts.step ?? "c.set('v', c.close[c.i]);"} }; },
    });`;
}

const rssMb = () => process.memoryUsage().rss / 1e6;

/** Open a series of `n` bars holding one instance `h` of the script. */
function openSeries(h: ScriptHost, id: string, inputs: Record<string, unknown> = {}, n = 20) {
  return h.callAsync<SeriesResult>(
    id,
    'open',
    ['k', { ...CTX }, bars(n), [{ hash: 'h', inputs }]],
    { hashes: new Set(['h']), barCount: n },
  );
}

const tickBar = (close: number, i = 19) => ({
  ...barAt(bars(20), i),
  close,
});

// ------------------------------------------- results of an isolate are untrusted

/** A stand-in for `isolated-vm` whose isolates answer from `answer` (hostile results). */
function fakeIvm(answer: (name: string, args: unknown[]) => unknown): Ivm {
  class FakeIsolate {
    isDisposed = false;
    cpuTime = 0n;
    async createContext() {
      const fn = (name: string) => ({
        apply: async (_r: unknown, args: unknown[]) => answer(name, args),
        applySync: (_r: unknown, args: unknown[]) => answer(name, args),
      });
      return {
        global: {
          get: async () => ({ get: async (name: string) => fn(name) }),
          delete: async () => {},
        },
      };
    }
    async compileScript() {
      return { run: async () => {} };
    }
    dispose() {
      this.isDisposed = true;
    }
  }
  return { Isolate: FakeIsolate } as unknown as Ivm;
}

const ok = (value: unknown) => ({ ok: true, value });
const update = (hash: string, from: number, values: Record<string, unknown>) => ({
  hash,
  from,
  values,
});
const series = (updates: unknown[], errors: Record<string, string> = {}) => ok({ updates, errors });

describe('every isolate result is validated before the host uses it', () => {
  const MANIFEST = manifestOf('s', golden('sma'));
  const SRC = { id: 's', source: 'not run', revision: 1 };
  const EXPECT = { hashes: new Set(['h']), barCount: 10 };
  let faked: ScriptHost | null = null;
  afterEach(() => {
    faked?.dispose();
    faked = null;
  });

  async function withIsolate(open: unknown, load: unknown = ok({ ok: true, manifest: MANIFEST })) {
    const clock = new FakeClock(1_800_000_000_000);
    const h = new ScriptHost({
      bundle: '',
      ivm: fakeIvm((name) => (name === 'load' ? load : open)),
      memoryMb: 16,
      loadMs: 1000,
      tickMs: 100,
      clock,
      log: silentLogger,
    });
    faked = h;
    h.setScripts([SRC]);
    return h;
  }
  const open = (h: ScriptHost) => h.callAsync<SeriesResult>('s', 'open', ['k'], EXPECT);

  it('accepts an honest result', async () => {
    const h = await withIsolate(series([update('h', 2, { ma: new Float64Array(8) })]));
    const res = await open(h);
    expect(res.value.updates[0]!.values['ma']).toHaveLength(8);
  });

  it.each([
    [
      'a fake length instead of a Float64Array (host OOM through slice/Math.min overrides)',
      { ma: { length: 3e7 } },
      /not a Float64Array/,
    ],
    ['a plain array', { ma: [1, 2, 3] }, /not a Float64Array/],
    ['a typed array of another kind', { ma: new Float32Array(3) }, /not a Float64Array/],
    ['a range longer than the series', { ma: new Float64Array(11) }, /run past/],
    [
      'an output that is not a plot of the script',
      { evil: new Float64Array(1) },
      /not a plot output/,
    ],
  ])('rejects %s', async (_what, values, why) => {
    const h = await withIsolate(series([update('h', 0, values)]));
    await expect(open(h)).rejects.toThrow(ScriptCallError);
    await expect(open(h)).rejects.toThrow(why);
    // A bad result is a script error, not a fault: the script is not held off.
    expect(h.unavailable('s')).toBeNull();
    expect(h.hold('s')).toBeNull();
  });

  it.each([-1, 11, 1.5, NaN, Infinity, '0', undefined])(
    'rejects a range start of %s',
    async (from) => {
      const h = await withIsolate(
        series([update('h', from as number, { ma: new Float64Array(0) })]),
      );
      await expect(open(h)).rejects.toThrow(/range starts outside/);
    },
  );

  it('rejects a start that leaves less room than the values take', async () => {
    const h = await withIsolate(series([update('h', 8, { ma: new Float64Array(3) })]));
    await expect(open(h)).rejects.toThrow(/run past/);
  });

  it("rejects another script's instance hash (hash spoofing)", async () => {
    const h = await withIsolate(series([update('VICTIM', 0, { ma: new Float64Array(1) })]));
    await expect(open(h)).rejects.toThrow(/unknown instance/);
  });

  it('rejects errors for unknown instances, extra and repeated updates', async () => {
    const some = new Float64Array(1);
    for (const res of [
      series([], { VICTIM: 'boom' }),
      series([update('h', 0, { ma: some }), update('h', 0, { ma: some })]),
      series([update('h', 0, {}), update('h', 0, {})]),
    ])
      await expect(open(await withIsolate(res))).rejects.toThrow(ScriptCallError);
  });

  it.each([
    ['a string', 'hello'],
    ['null', null],
    ['an array', []],
    ['an envelope without a flag', {}],
    ['no updates', ok({ errors: {} })],
    ['updates that are not an array', ok({ updates: {}, errors: {} })],
    ['errors that are not an object', ok({ updates: [], errors: 3 })],
    ['an error that is not text', ok({ updates: [], errors: { h: { x: 1 } } })],
  ])('rejects %s as the result of a call', async (_what, res) => {
    await expect(open(await withIsolate(res))).rejects.toThrow(ScriptCallError);
  });

  it('turns an error envelope into a call error with its message', async () => {
    const h = await withIsolate({ ok: false, error: 'it broke' });
    await expect(open(h)).rejects.toThrow('it broke');
    expect(h.hold('s')).toBeNull();
  });

  it('a script error counts for its own instances, not as a crash', async () => {
    const h = await withIsolate(series([update('h', 0, { ma: { length: 3e7 } })]));
    const cols = { current: bars(10) };
    const us = new UserSeries('k', h, {
      columns: () => cols.current,
      context: () => ({ ...CTX }),
      time: (i) => cols.current.time[i] ?? NaN,
      length: () => 10,
    });
    await us.add([{ hash: 'h', type: 'user:s', inputs: {} }]);
    expect(us.error('h')).toMatch(/malformed result from the script isolate/);
    expect(us.held('h')).toBeNull();
  });

  it('rejects a load result whose manifest is malformed or for another script', async () => {
    for (const load of [
      ok({ ok: true, manifest: { id: 'user:s' } }),
      ok({ ok: true, manifest: manifestOf('other', golden('sma')) }),
      ok({ ok: true }),
      ok({ ok: false, message: 3 }),
      ok({ ok: false, message: 'x', line: 'one' }),
    ]) {
      const h = await withIsolate(series([]), load);
      const r = await h.ensure('s');
      expect(r.ok).toBe(false);
      expect(h.hold('s')).toBeNull();
    }
  });

  it('rejects a malformed Check result', async () => {
    for (const bad of [
      ok({ ok: false, mismatch: { outputId: 'v', index: -1, full: 1, live: 2 } }),
      ok({ ok: false, mismatch: { outputId: 'v', index: 3, full: '1', live: 2 } }),
      ok({ ok: false, mismatch: 5 }),
      ok({ nope: true }),
    ]) {
      const h = await withIsolate(bad);
      await expect(h.callAsync('s', 'check', ['k', 'h', 50])).rejects.toThrow(ScriptCallError);
    }
    const h = await withIsolate(
      ok({ ok: false, mismatch: { outputId: 'v', index: 3, full: 1, live: 2 } }),
    );
    await expect(h.callAsync('s', 'check', ['k', 'h', 50])).resolves.toMatchObject({
      value: { ok: false },
    });
  });

  it('bounds the length of messages it keeps', async () => {
    const h = await withIsolate(series([], { h: 'x'.repeat(100_000) }));
    const res = await open(h);
    expect(res.value.errors['h']!.length).toBeLessThanOrEqual(500);
  });
});

// ------------------------------------ scripts that tamper with the entry's builtins

describe('a script that overrides builtins cannot hurt the host or other scripts', () => {
  const COLS = { current: bars(50) };
  const one = (h: ScriptHost) => {
    const us = userSeries(h, COLS);
    return us;
  };

  it('Float64Array.prototype.slice and Math.min overrides (host OOM crash, review repro)', async () => {
    const before = rssMb();
    for (const top of [
      'Float64Array.prototype.slice = function () { return { length: 3e7 }; };',
      'Float64Array.prototype.slice = function () { return new Float64Array(1.2e7); };',
      'Math.min = () => 4294967290;',
      'Math.max = () => 4294967290; Array.prototype.fill = function () { return this; };',
    ]) {
      const { host: h } = await setup({ loadMs: 3000 });
      useScript(h, 's', script({ top }));
      const us = one(h);
      await us.add([{ hash: 'h1', type: 'user:s', inputs: {} }]);
      // The entry copies with captured builtins: the values are right, or the script errors.
      const bad = us.error('h1') ?? us.held('h1');
      if (bad === null) expect(us.value('h1', 'v', 49)).toBe(COLS.current.close[49]);
      expect(h.unavailable('s') === null || /time limit|memory/.test(h.unavailable('s')!)).toBe(
        true,
      );
      h.dispose();
      host = null;
    }
    expect(rssMb() - before).toBeLessThan(300);
  });

  it('a getter that spins in a fake result is cut off by the load limit', async () => {
    const { host: h } = await setup({ loadMs: 500 });
    useScript(
      h,
      's',
      script({
        top: `Float64Array.prototype.slice = function () {
          const o = {}; Object.defineProperty(o, 'x', { enumerable: true, get() { for (;;) {} } }); return o; };`,
      }),
    );
    const us = one(h);
    const t0 = Date.now();
    await us.add([{ hash: 'h1', type: 'user:s', inputs: {} }]);
    expect(Date.now() - t0).toBeLessThan(5000);
    // Whatever happened, the host answered and the isolate is replaceable.
    expect(us.error('h1') ?? us.held('h1') ?? 'fine').toBeTypeOf('string');
  });

  it("Map.prototype overrides cannot make an instance report another script's hash", async () => {
    const { host: h } = await setup();
    const spoof = `
      const keys = Map.prototype.keys; const get = Map.prototype.get;
      Map.prototype.keys = function () { const k = [...keys.call(this)]; if (k.includes('h1')) k.push('VICTIM'); return k[Symbol.iterator](); };
      Map.prototype.get = function (k) { return k === 'VICTIM' ? get.call(this, 'h1') : get.call(this, k); };
      Object.values = () => [{ hash: 'VICTIM' }];`;
    h.setScripts([
      { id: 'evil', source: script({ top: spoof }), revision: 1 },
      { id: 'victim', source: script(), revision: 1 },
    ]);
    const us = one(h);
    await us.add([
      { hash: 'h1', type: 'user:evil', inputs: {} },
      { hash: 'VICTIM', type: 'user:victim', inputs: {} },
    ]);
    expect(us.error('VICTIM')).toBeNull();
    // The victim's values are its own (its script reads the close), whatever evil returned.
    expect(us.value('VICTIM', 'v', 49)).toBe(COLS.current.close[49]);
    expect(us.value('h1', 'v', 49) === COLS.current.close[49] || us.error('h1') !== null).toBe(
      true,
    );
  });

  it("a script cannot claim another script's hash even if the isolate answers for it", async () => {
    // Same shape as above, at the host: the evil isolate names the victim's hash.
    const { host: h } = await setup();
    useScript(h, 'evil', script());
    await expect(
      h.callAsync('evil', 'open', ['k', { ...CTX }, bars(5), [{ hash: 'a', inputs: {} }]], {
        hashes: new Set(['b']),
        barCount: 5,
      }),
    ).rejects.toThrow(/unknown instance/);
  });

  it('Object.values / Map.get that throw, even a spinning thrown object, stay a script problem', async () => {
    const { host: h } = await setup({ loadMs: 800 });
    useScript(
      h,
      's',
      script({
        top: `Map.prototype.get = function () { throw { get message() { for (;;) {} } }; };`,
      }),
    );
    const us = one(h);
    const t0 = Date.now();
    await us.add([{ hash: 'h1', type: 'user:s', inputs: {} }]);
    expect(Date.now() - t0).toBeLessThan(6000);
    expect(us.error('h1') ?? us.held('h1')).not.toBeNull();
  });

  it('an error that says "Script execution timed out." is a plain script error, not a fault', async () => {
    const { host: h } = await setup();
    const faults: string[] = [];
    h.onFault((_id, reason) => faults.push(reason));
    // From the step, from the compile, and from an entry builtin the script replaced.
    for (const src of [
      script({ step: "throw new Error('Script execution timed out.');" }),
      `throw new Error('Script execution timed out.');\n${script()}`,
      script({ top: "Object.values = () => { throw new Error('Script execution timed out.'); };" }),
      script({ top: "Object.keys = () => { throw new Error('Script execution timed out.'); };" }),
      script({
        top: "Map.prototype.set = () => { throw new Error('Isolate was disposed during execution due to memory limit'); };",
      }),
    ]) {
      useScript(h, 'fake', src, Math.random());
      const us = one(h);
      await us.add([{ hash: 'h1', type: 'user:fake', inputs: {} }]);
      expect(faults).toEqual([]);
      expect(h.hold('fake')).toBeNull();
      const e = us.error('h1');
      if (e !== null) expect(e).not.toMatch(/time limit|memory limit \(/);
    }
    expect(faults).toEqual([]);
  });

  it('keeps ticking after a script tampered with Array and Float64Array prototypes', async () => {
    const { host: h } = await setup();
    useScript(
      h,
      's',
      script({
        top: `Array.prototype[Symbol.iterator] = function* () { yield 0; };
          Float64Array.prototype[Symbol.iterator] = function* () { yield 0; };
          Array.from = () => [];`,
      }),
    );
    const cols = { current: bars(50) };
    const us = userSeries(h, cols);
    await us.add([{ hash: 'h1', type: 'user:s', inputs: {} }]);
    const err = us.error('h1');
    if (err === null) {
      cols.current = bars(50);
      us.updateBar(49, tickBar(101, 49));
    }
    // Poisoned iteration may stop the script from compiling; the host and the isolate are fine.
    expect(h.unavailable('s') ?? 'fine').toMatch(/^fine$|does not compile/);
  });
});

// ------------------------------------------------------ memory limit bypasses

describe('allocations the isolate heap limit does not count are closed', () => {
  const BYPASSES: [string, string, RegExp][] = [
    [
      'resizable ArrayBuffer',
      'globalThis.k = []; for (let i = 0; i < 60; i++) { const b = new ArrayBuffer(1, { maxByteLength: 2e9 }); b.resize(1e8); new Uint8Array(b).fill(1); globalThis.k.push(b); }',
      /resizable ArrayBuffer is not available/,
    ],
    [
      'Intl.DateTimeFormat instances (ICU memory outside the heap)',
      "globalThis.k = []; for (let i = 0; i < 200000; i++) globalThis.k.push(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric' }));",
      /Intl/,
    ],
    [
      'Intl.Segmenter and Intl.Collator instances',
      "globalThis.k = []; for (let i = 0; i < 200000; i++) { globalThis.k.push(new Intl.Segmenter('en', { granularity: 'word' })); globalThis.k.push(new Intl.Collator('de')); }",
      /Intl/,
    ],
    [
      'locale-sensitive string and number methods',
      "globalThis.k = []; for (let i = 0; i < 100000; i++) globalThis.k.push((i * 1.5).toLocaleString('de') + 'a'.localeCompare('b') + 'x'.normalize('NFD'));",
      /toLocaleString|localeCompare|normalize/,
    ],
    [
      'ArrayBuffer through the view constructor route',
      'const C = new Uint8Array(1).buffer.constructor; globalThis.k = []; for (let i = 0; i < 20; i++) { const b = new C(1e8, { maxByteLength: 4e9 }); new Uint8Array(b).fill(1); globalThis.k.push(b); }',
      /resizable ArrayBuffer is not available/,
    ],
    [
      'growable SharedArrayBuffer',
      'globalThis.k = []; for (let i = 0; i < 20; i++) { const b = new SharedArrayBuffer(1, { maxByteLength: 2e8 }); b.grow(1e8); new Uint8Array(b).fill(1); globalThis.k.push(b); }',
      /SharedArrayBuffer/,
    ],
    [
      'SharedArrayBuffer',
      'globalThis.k = []; for (let i = 0; i < 200; i++) globalThis.k.push(new SharedArrayBuffer(1e8));',
      /SharedArrayBuffer/,
    ],
    [
      'WebAssembly.Memory',
      'globalThis.k = []; for (let i = 0; i < 60; i++) { const m = new WebAssembly.Memory({ initial: 1, maximum: 65536 }); m.grow(1600); globalThis.k.push(m); }',
      /WebAssembly/,
    ],
    [
      'WebAssembly.Memory with a large initial size',
      'globalThis.k = []; for (let i = 0; i < 30; i++) { const m = new WebAssembly.Memory({ initial: 1600 }); new Uint8Array(m.buffer).fill(1); globalThis.k.push(m); }',
      /WebAssembly/,
    ],
  ];

  it.each(BYPASSES)(
    '%s: the script errors and the host process does not grow',
    async (_n, body, why) => {
      const before = rssMb();
      const { host: h } = await setup({ memoryMb: 64, loadMs: 8000 });
      useScript(h, 's', script({ setup: body }));
      const us = userSeries(h, { current: bars(20) });
      await us.add([{ hash: 'h', type: 'user:s', inputs: {} }]);
      // Either the script errors (the expected case) or the isolate died at its limit.
      const msg = us.error('h') ?? us.held('h');
      expect(msg).not.toBeNull();
      expect(msg).toMatch(new RegExp(`${why.source}|memory limit|time limit`));
      expect(rssMb() - before).toBeLessThan(300);
    },
  );

  it('normal allocation still works and is still capped by the heap limit', async () => {
    const { host: h } = await setup({ memoryMb: 32, loadMs: 8000 });
    useScript(h, 'fine', script({ setup: 'globalThis.a = new Float64Array(100000).fill(1);' }));
    const us = userSeries(h, { current: bars(20) });
    await us.add([{ hash: 'h', type: 'user:fine', inputs: {} }]);
    expect(us.error('h')).toBeNull();
    expect(us.value('h', 'v', 19)).not.toBeNaN();
    // A huge typed array is refused by the isolate's own accounting.
    useScript(h, 'huge', script({ setup: 'globalThis.a = new Float64Array(1e9);' }));
    const bad = userSeries(h, { current: bars(20) });
    const before = rssMb();
    await bad.add([{ hash: 'h', type: 'user:huge', inputs: {} }]);
    expect(bad.error('h') ?? bad.held('h')).not.toBeNull();
    expect(rssMb() - before).toBeLessThan(300);
  });

  it('the lock-down leaves the ArrayBuffer API a script needs, and nothing that resizes', async () => {
    const { host: h } = await setup();
    const probe = `
      const bad = [];
      try { new ArrayBuffer(1, { maxByteLength: 8 }); bad.push('global'); } catch (e) {}
      try { new ArrayBuffer(1, {}); bad.push('options'); } catch (e) {}
      try { new (new Uint8Array(1).buffer.constructor)(1, { maxByteLength: 8 }); bad.push('viaView'); } catch (e) {}
      try { ArrayBuffer(8); bad.push('call'); } catch (e) {}
      if (new Uint8Array(4).buffer.slice(0, 2).resizable) bad.push('slice');
      if (typeof ArrayBuffer.prototype.resize !== 'undefined') bad.push('resize');
      if (new ArrayBuffer(8).transfer(16).resizable) bad.push('transfer');
      if (new ArrayBuffer(8).transferToFixedLength(4).resizable) bad.push('transferToFixed');
      if (typeof WebAssembly !== 'undefined') bad.push('WebAssembly');
      if (typeof SharedArrayBuffer !== 'undefined') bad.push('SharedArrayBuffer');
      try { Object.defineProperty(ArrayBuffer.prototype, 'constructor', { value: Object }); bad.push('redefine'); } catch (e) {}
      try { delete ArrayBuffer.prototype.constructor; if (ArrayBuffer.prototype.constructor !== ArrayBuffer) bad.push('delete'); } catch (e) {}
      try { globalThis.ArrayBuffer = 1; } catch (e) {}
      if (typeof ArrayBuffer !== 'function') bad.push('replace');
      if (new Float64Array(10).length !== 10) bad.push('Float64Array');
      if (new Float64Array(new ArrayBuffer(16)).length !== 2) bad.push('Float64Array(buffer)');
      if (new DataView(new ArrayBuffer(8)).byteLength !== 8) bad.push('DataView');
      if (!(new ArrayBuffer(8) instanceof ArrayBuffer) || !ArrayBuffer.isView(new Uint8Array(1))) bad.push('instanceof');
      if (bad.length) throw new Error('LEAK: ' + bad.join(','));`;
    useScript(h, 'probe', script({ top: probe }));
    const r = await h.ensure('probe');
    expect(r.ok ? 'ok' : r.reason).toBe('ok');
    // ...and the golden scripts (typed arrays inside the runtime) still compute.
    useScript(h, 'sma', golden('sma'));
    const us = userSeries(h, { current: bars(100) });
    await us.add([{ hash: 'a', type: 'user:sma', inputs: { length: 5, source: 'close' } }]);
    expect(us.error('a')).toBeNull();
  });

  it('timers that spin after the call returned (microtasks, Atomics.waitAsync) are cut off or refused', async () => {
    const { host: h } = await setup({ loadMs: 600, tickMs: 150 });
    useScript(
      h,
      'micro',
      script({
        step: "if (c.i === 19) Promise.resolve().then(() => { for (;;) {} }); c.set('v', c.close[c.i]);",
      }),
    );
    const t0 = Date.now();
    await userSeries(h, { current: bars(20) }).add([{ hash: 'h', type: 'user:micro', inputs: {} }]);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(h.hold('micro')?.reason ?? '').toMatch(/time limit/);

    useScript(
      h,
      'wait',
      script({
        step: "if (c.i === 19 && !globalThis.w) { globalThis.w = 1; Atomics.waitAsync(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500).value.then(() => { for (;;) {} }); } c.set('v', c.close[c.i]);",
      }),
    );
    const us = userSeries(h, { current: bars(20) });
    await us.add([{ hash: 'h', type: 'user:wait', inputs: {} }]);
    expect(us.error('h')).toMatch(/SharedArrayBuffer/); // not defined: the script errors at once
    expect(h.hold('wait')).toBeNull();

    // A finalization callback runs outside any call's time limit and would wedge the isolate.
    useScript(
      h,
      'fin',
      script({
        step: "if (c.i === 0) { globalThis.r = new FinalizationRegistry(() => { for (;;) {} }); globalThis.r.register({}, 1); } c.set('v', 1);",
      }),
    );
    const fin = userSeries(h, { current: bars(20) });
    await fin.add([{ hash: 'h', type: 'user:fin', inputs: {} }]);
    expect(fin.error('h')).toMatch(/FinalizationRegistry/);
    expect(h.hold('fin')).toBeNull();
  });
});

// --------------------------------------------------------------- fault semantics

describe('faults, strikes and back-off', () => {
  const TICK_HANG = script({
    step: "if (c.close[c.i] === 12345) { while (true) {} } c.set('v', c.close[c.i]);",
  });
  const LOAD_HANG = script({
    step: "if (inputs.hang && c.i === 5) { while (true) {} } c.set('v', 1);",
  });
  const tick = (h: ScriptHost, close = 12345, epoch?: number) =>
    h.callAsync<SeriesResult>(
      'tick',
      'updateBar',
      ['k', 19, tickBar(close)],
      { hashes: new Set(['h']), barCount: 20 },
      epoch,
      true,
    );

  const strikeOnce = async (h: ScriptHost) => {
    await openSeries(h, 'tick'); // (re)build the series' state, as a series does after a strike
    return await Promise.resolve()
      .then(() => tick(h))
      .catch((e: unknown) => e);
  };

  it('a live-update timeout is a strike: only that series starts over, the isolate stays, nobody is told', async () => {
    const { host: h } = await setup({ loadMs: 3000, tickMs: 100 });
    useScript(h, 'tick', TICK_HANG);
    const events: ScriptHold[] = [];
    h.onFault((_id, _reason, hold) => events.push(hold));
    await openSeries(h, 'tick');
    const epoch = h.epoch('tick');
    const err = await Promise.resolve()
      .then(() => tick(h))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ScriptStrike);
    expect(err).not.toBeInstanceOf(ScriptUnavailable);
    expect((err as ScriptStrike).strikes).toBe(1);
    expect((err as ScriptStrike).message).toMatch(/1 of 3/);
    expect(h.hold('tick')).toBeNull();
    expect(h.unavailable('tick')).toBeNull();
    expect(events).toEqual([]); // other series' alerts are not suspended
    // The same isolate takes the rebuilt series (no new generation).
    const again = await openSeries(h, 'tick');
    expect(again.epoch).toBe(epoch);
    expect(h.epoch('tick')).toBe(epoch);
    await expect(tick(h, 100)).resolves.toBeDefined();
  });

  it('three live-update timeouts within 10 minutes are a fault with a 5 minute hold', async () => {
    const { host: h, clock } = await setup({ loadMs: 3000, tickMs: 100 });
    useScript(h, 'tick', TICK_HANG);
    const events: ScriptHold[] = [];
    h.onFault((_id, _reason, hold) => events.push(hold));
    expect(await strikeOnce(h)).toBeInstanceOf(ScriptStrike);
    await clock.advance(60_000);
    expect(await strikeOnce(h)).toBeInstanceOf(ScriptStrike);
    await clock.advance(60_000);
    expect(h.hold('tick')).toBeNull();
    expect(events).toEqual([]);
    const third = (await strikeOnce(h)) as ScriptFault;
    expect(third).toBeInstanceOf(ScriptFault);
    expect(third.retryAt).toBe(clock.now() + FAULT_RETRY_MIN_MS);
    expect(third.final).toBe(false);
    expect(events).toHaveLength(1); // only the fault suspends alerts
    expect(h.hold('tick')).toMatchObject({ retryAt: clock.now() + FAULT_RETRY_MIN_MS });
    expect(h.unavailable('tick')).toMatch(/disabled for 5 more min/);
    await expect(openSeries(h, 'tick')).rejects.toBeInstanceOf(ScriptUnavailable);
    await clock.advance(FAULT_RETRY_MIN_MS);
    expect(h.hold('tick')).toBeNull();
    await expect(openSeries(h, 'tick')).resolves.toBeDefined();
  });

  it('strikes older than 10 minutes do not count', async () => {
    const { host: h, clock } = await setup({ loadMs: 3000, tickMs: 100 });
    useScript(h, 'tick', TICK_HANG);
    await strikeOnce(h);
    await clock.advance(11 * 60_000);
    await strikeOnce(h);
    await clock.advance(60_000);
    const third = await strikeOnce(h); // 2 inside the window: still only a strike
    expect(third).toBeInstanceOf(ScriptStrike);
    expect(h.hold('tick')).toBeNull();
  });

  it('a load or compute timeout is a fault at once (one strike)', async () => {
    const { host: h, clock } = await setup({ loadMs: 250, tickMs: 100 });
    useScript(h, 'load', LOAD_HANG);
    const err = await openSeries(h, 'load', { hang: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ScriptFault);
    expect((err as ScriptFault).kind).toBe('timeout');
    expect((err as ScriptFault).retryAt).toBe(clock.now() + FAULT_RETRY_MIN_MS);
    expect((err as ScriptFault).transient).toBe(true);
  });

  it('backs off 5, 10, 20, 40, 60 min; the second fault in a row at the cap is final', async () => {
    const { host: h, clock } = await setup({ loadMs: 200, tickMs: 100 });
    useScript(h, 'load', LOAD_HANG);
    const waits: number[] = [];
    const finals: boolean[] = [];
    for (let i = 0; i < 7; i++) {
      const before = clock.now();
      const err = (await openSeries(h, 'load', { hang: true }).catch(
        (e: unknown) => e,
      )) as ScriptFault;
      if (err.retryAt === undefined) throw err;
      waits.push((err.retryAt - before) / 60_000);
      finals.push(err.final);
      await clock.advance(err.retryAt - before);
    }
    expect(waits).toEqual([5, 10, 20, 40, 60, 60, 60]);
    expect(finals).toEqual([false, false, false, false, false, true, true]);
    expect(FAULT_RETRY_MAX_MS).toBe(60 * 60_000);
    // A final fault is not transient: its alerts end in error instead of waiting.
    expect(h.hold('load')).toBeNull(); // the last hold already ran out
    const last = (await openSeries(h, 'load', { hang: true }).catch(
      (e: unknown) => e,
    )) as ScriptFault;
    expect(last.transient).toBe(false);
    expect(h.hold('load')?.final).toBe(true);
    expect(h.unavailable('load')).toMatch(/kept failing/);
  });

  it('faults are forgotten only after an hour without one, not after one good open', async () => {
    const { host: h, clock } = await setup({ loadMs: 200, tickMs: 100 });
    useScript(h, 'load', LOAD_HANG);
    const wait = async (): Promise<number> => {
      const t = clock.now();
      const err = (await openSeries(h, 'load', { hang: true }).catch(
        (e: unknown) => e,
      )) as ScriptFault;
      return (err.retryAt - t) / 60_000;
    };
    expect(await wait()).toBe(5);
    await clock.advance(FAULT_RETRY_MIN_MS);
    await openSeries(h, 'load', { hang: false }); // one good open
    expect(await wait()).toBe(10); // ...does not reset the count
    await clock.advance(10 * 60_000);
    await openSeries(h, 'load', { hang: false });
    // Less than an hour healthy: still counted.
    await clock.advance(HEALTHY_RESET_MS - 60_000);
    await h.callAsync('load', 'check', ['k', 'h', 5]);
    expect(await wait()).toBe(20);
    await clock.advance(20 * 60_000);
    await openSeries(h, 'load', { hang: false });
    await clock.advance(HEALTHY_RESET_MS + 1);
    await h.callAsync('load', 'check', ['k', 'h', 5]); // a good call after an hour
    expect(await wait()).toBe(5); // forgotten
  });

  it('a new revision of the script forgets the faults and the hold', async () => {
    const { host: h } = await setup({ loadMs: 200, tickMs: 100 });
    useScript(h, 'load', LOAD_HANG);
    await openSeries(h, 'load', { hang: true }).catch(() => undefined);
    expect(h.hold('load')).not.toBeNull();
    useScript(h, 'load', LOAD_HANG, 2);
    expect(h.hold('load')).toBeNull();
    expect(h.unavailable('load')).toBeNull();
  });

  it('a memory fault and a dead isolate are one fault each', async () => {
    const { host: h } = await setup({ memoryMb: 16, loadMs: 8000 });
    const events: ScriptHold[] = [];
    h.onFault((_id, _reason, hold) => events.push(hold));
    useScript(
      h,
      'mem',
      script({ setup: 'const keep = []; for (;;) keep.push(new Array(100000).fill(1));' }),
    );
    const err = (await openSeries(h, 'mem').catch((e: unknown) => e)) as ScriptFault;
    expect(err).toBeInstanceOf(ScriptFault);
    expect(err.kind).toBe('memory');
    expect(events).toHaveLength(1);
    expect(err.retryAt - Date.now()).toBeGreaterThan(0);
  });
});

// ------------------------------------------------------------ CPU budget

describe('CPU budget', () => {
  /** Spins for `close - 1000` ms on a live bar with a close above 1000 (history bars stay below). */
  const SPIN = script({
    step: "if (c.close[c.i] > 1000) { const t = Date.now(); while (Date.now() - t < c.close[c.i] - 1000) {} } c.set('v', 1);",
  });
  /** Spins on every full compute (open, setBars), never on a live update of the last bar. */
  const SPIN_FULL = script({
    step: "if (c.i === 0) { const t = Date.now(); while (Date.now() - t < 400) {} } c.set('v', 1);",
  });
  const tickOn = (h: ScriptHost, id: string, ms: number) =>
    h.callAsync<SeriesResult>(
      id,
      'updateBar',
      ['k', 19, tickBar(1000 + ms)],
      { hashes: new Set(['h']), barCount: 20 },
      undefined,
      true,
    );
  const spinTwice = async (h: ScriptHost, clock: FakeClock) => {
    await openSeries(h, 's');
    await tickOn(h, 's', 400); // 400 ms of CPU
    await clock.advance(60_000);
    return Promise.resolve().then(() => tickOn(h, 's', 400)); // 800 ms in 60 s = 1.3 %
  };

  it('an isolate over its share of one CPU in live updates is faulted', async () => {
    const { host: h, clock } = await setup({ cpuPct: 1, loadMs: 5000, tickMs: 3000 });
    useScript(h, 's', SPIN);
    const err = (await spinTwice(h, clock).catch((e: unknown) => e)) as ScriptFault;
    expect(err).toBeInstanceOf(ScriptFault);
    expect(err.kind).toBe('cpu');
    expect(err.reason).toMatch(/more than 1% of a CPU/);
    expect(h.hold('s')).not.toBeNull();
    expect(h.unavailable('s')).toMatch(/disabled for 5 more min/);
  });

  it('the same load under the default 20 % is fine', async () => {
    const { host: h, clock } = await setup({ loadMs: 5000, tickMs: 3000 });
    useScript(h, 's', SPIN);
    await expect(spinTwice(h, clock)).resolves.toBeDefined();
    expect(h.hold('s')).toBeNull();
  });

  it('is not judged before 30 seconds of history', async () => {
    const { host: h, clock } = await setup({ cpuPct: 1, loadMs: 5000, tickMs: 3000 });
    useScript(h, 's', SPIN);
    await openSeries(h, 's');
    await tickOn(h, 's', 400);
    await clock.advance(5000);
    await expect(tickOn(h, 's', 400)).resolves.toBeDefined();
  });

  it('a burst of loads and full computes is not charged (only live updates are)', async () => {
    const { host: h, clock } = await setup({ cpuPct: 1, loadMs: 5000, tickMs: 3000 });
    useScript(h, 's', SPIN_FULL);
    await openSeries(h, 's');
    await clock.advance(60_000);
    for (let i = 0; i < 3; i++)
      await h.callAsync('s', 'setBars', ['k', bars(20)], { hashes: new Set(['h']), barCount: 20 });
    await clock.advance(60_000);
    await expect(tickOn(h, 's', 0)).resolves.toBeDefined();
    expect(h.hold('s')).toBeNull();
  });

  describe('all isolates together', () => {
    const two = async (totalPct: number) => {
      const r = await setup({ cpuPct: 100, cpuTotalPct: totalPct, loadMs: 5000, tickMs: 3000 });
      r.host.setScripts([
        { id: 'a', source: SPIN, revision: 1 },
        { id: 'b', source: SPIN, revision: 1 },
      ]);
      await openSeries(r.host, 'a');
      await openSeries(r.host, 'b');
      return r;
    };

    it('the isolate that called and used the most is faulted', async () => {
      const { host: h, clock } = await two(1);
      await tickOn(h, 'a', 700);
      await tickOn(h, 'b', 300);
      await clock.advance(60_000);
      const err = await Promise.resolve()
        .then(() => tickOn(h, 'a', 700))
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ScriptFault);
      expect((err as ScriptFault).reason).toMatch(/together used more than 1% of a CPU/);
      expect(h.hold('a')).not.toBeNull();
      expect(h.hold('b')).toBeNull();
    });

    it("another isolate's call that crosses the cap faults the one that used the most", async () => {
      const { host: h, clock } = await two(1);
      await tickOn(h, 'a', 700);
      await tickOn(h, 'b', 100);
      await clock.advance(60_000);
      const events: string[] = [];
      h.onFault((id) => events.push(id));
      await expect(tickOn(h, 'b', 400)).resolves.toBeDefined(); // b's own call succeeds
      expect(events).toEqual(['a']);
      expect(h.hold('a')).not.toBeNull();
      expect(h.hold('b')).toBeNull();
    });

    it('stays quiet under the cap', async () => {
      const { host: h, clock } = await two(50);
      await tickOn(h, 'a', 700);
      await tickOn(h, 'b', 300);
      await clock.advance(60_000);
      await expect(tickOn(h, 'a', 700)).resolves.toBeDefined();
      expect(h.hold('a')).toBeNull();
    });
  });
});

// ------------------------------------------- manifest the isolate compiled

describe('manifest trust', () => {
  const base = manifestOf('s', golden('sma'));

  it('compares repaints, plot ids and input ids and kinds', () => {
    expect(manifestMatches(base, structuredClone(base))).toBe(true);
    expect(manifestMatches({ ...base, repaints: true }, base)).toBe(false);
    expect(manifestMatches({ ...base, name: 'Renamed', shortName: 'R' }, base)).toBe(true);
    const outs = base.outputs.map((o) => (o.type === 'plot' ? { ...o, id: 'other' } : o));
    expect(manifestMatches({ ...base, outputs: outs }, base)).toBe(false);
    const [first, def] = Object.entries(base.inputs)[0]!;
    const retyped = {
      ...base.inputs,
      [first]: { ...def, kind: def.kind === 'bool' ? 'int' : 'bool' },
    };
    expect(manifestMatches({ ...base, inputs: retyped as typeof base.inputs }, base)).toBe(false);
    const { [first]: _gone, ...rest } = base.inputs;
    expect(manifestMatches({ ...base, inputs: rest }, base)).toBe(false);
  });

  it('a script whose saved manifest does not match what it compiles to is unavailable for good', async () => {
    const { host: h } = await setup();
    const stale = manifestOf('s', golden('sma').replace(/id: 'ma'/, "id: 'avg'"));
    h.setScripts([{ id: 's', source: golden('sma'), revision: 1, manifest: stale }]);
    const r = await h.ensure('s');
    expect(r).toEqual({ ok: false, reason: MANIFEST_STALE });
    expect(h.unavailable('s')).toBe(MANIFEST_STALE);
    expect(h.hold('s')).toBeNull();
    // Saving again (new revision with a matching manifest) clears it.
    h.setScripts([{ id: 's', source: golden('sma'), revision: 2, manifest: base }]);
    expect(h.unavailable('s')).toBeNull();
    expect(await h.ensure('s')).toMatchObject({ ok: true });
  });
});

// ------------------------------------- the event loop and intentional disposal

describe('asynchronous calls', () => {
  const HEAVY = script({
    step: "if (c.i === 5 && c.close[c.i] > 150) { const t = Date.now(); while (Date.now() - t < 2000) {} } c.set('v', c.close[c.i]);",
  });
  const heavyBars = (): Columns => {
    const c = bars(20);
    c.close[5] = 200;
    return c;
  };

  it('the event loop keeps running during a 2 second compute', async () => {
    const { host: h } = await setup({ loadMs: 10_000 });
    useScript(h, 'heavy', HEAVY);
    await openSeries(h, 'heavy');
    let ticks = 0;
    const timer = setInterval(() => ticks++, 20);
    try {
      const t0 = Date.now();
      await h.callAsync('heavy', 'setBars', ['k', heavyBars()], {
        hashes: new Set(['h']),
        barCount: 20,
      });
      expect(Date.now() - t0).toBeGreaterThan(1500);
    } finally {
      clearInterval(timer);
    }
    // Blocking (applySync) would leave 0 ticks.
    expect(ticks).toBeGreaterThan(40);
  });

  it('a result that arrives after the script was edited is dropped, and is no fault', async () => {
    const { host: h } = await setup({ loadMs: 10_000 });
    const faults: string[] = [];
    h.onFault((_id, reason) => faults.push(reason));
    useScript(h, 'heavy', HEAVY);
    const cols = { current: bars(20) };
    const us = userSeries(h, cols);
    await us.add([{ hash: 'h', type: 'user:heavy', inputs: {} }]);
    const before = us.value('h', 'v', 5);
    expect(before).toBe(cols.current.close[5]);
    const pending = us.setBars(heavyBars());
    await new Promise((r) => setTimeout(r, 300)); // the call is running
    useScript(h, 'heavy', HEAVY.replace("c.set('v', c.close[c.i])", "c.set('v', 7)"), 2);
    await pending; // does not throw
    expect(faults).toEqual([]);
    expect(h.hold('heavy')).toBeNull();
    expect(h.unavailable('heavy')).toBeNull();
    // The old isolate's answer (close 200 at index 5) was not applied.
    expect(us.value('h', 'v', 5)).not.toBe(200);
    expect(us.error('h')).toBeNull();
    expect(us.held('h')).toBeNull(); // the series rebuilds on its next bar
  });

  it('deleting the script while a call runs is no fault either', async () => {
    const { host: h } = await setup({ loadMs: 10_000 });
    const faults: string[] = [];
    h.onFault((_id, reason) => faults.push(reason));
    useScript(h, 'heavy', HEAVY);
    await openSeries(h, 'heavy');
    const call = h
      .callAsync('heavy', 'setBars', ['k', heavyBars()], { hashes: new Set(['h']), barCount: 20 })
      .catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 300));
    h.setScripts([]);
    const err = await call;
    expect(err).toBeInstanceOf(ScriptSuperseded);
    expect(faults).toEqual([]);
  });

  it('two series opening the same script share one isolate', async () => {
    const { host: h } = await setup();
    useScript(h, 'sma', golden('sma'));
    const open = (key: string) =>
      h.callAsync<SeriesResult>(
        'sma',
        'open',
        [key, { ...CTX }, bars(30), [{ hash: 'h', inputs: { length: 3, source: 'close' } }]],
        { hashes: new Set(['h']), barCount: 30 },
      );
    const [a, b] = await Promise.all([open('a'), open('b')]);
    expect(a.value.errors).toEqual({});
    expect(b.value.errors).toEqual({});
    expect([a.epoch, b.epoch]).toEqual([2, 2]); // the generation each call ran in
    expect(h.epoch('sma')).toBe(2); // 1 for the entry, 1 for the single isolate
  });
});

describe('an isolate that stops answering', () => {
  /** A bundle that, once loaded, wedges its isolate's thread in a finalization task (the review's repro). */
  const WEDGE = `
    globalThis.__tg = {
      load: () => {
        globalThis.r = new FinalizationRegistry(() => { for (;;) {} });
        for (let j = 0; j < 1e5; j++) globalThis.r.register({ a: new Array(100) }, j);
        return { ok: true, value: { ok: true, manifest: ${JSON.stringify(manifestOf('s', golden('sma')))} } };
      },
      open: () => {
        let g;
        for (let k = 0; k < 30; k++) { g = []; for (let j = 0; j < 3e4; j++) g.push({ b: j }); }
        return { ok: true, value: { updates: [], errors: {} } };
      },
    };`;

  it('the host stops waiting after the limit plus a grace, disposes it and faults the script', async () => {
    const ivm = (await import('isolated-vm')).default;
    const clock = new FakeClock(1_800_000_000_000);
    const h = new ScriptHost({
      bundle: WEDGE,
      ivm,
      memoryMb: 128,
      loadMs: 400,
      tickMs: 100,
      watchdogGraceMs: 800,
      clock,
      log: silentLogger,
    });
    host = h;
    h.setScripts([{ id: 's', source: 'not run', revision: 1 }]);
    const t0 = Date.now();
    const err = await h
      .callAsync('s', 'open', ['k'], { hashes: new Set(), barCount: 0 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ScriptFault);
    expect((err as ScriptFault).kind).toBe('timeout');
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(h.hold('s')).not.toBeNull();
    // The host and its other isolates are fine.
    h.setScripts([
      { id: 's', source: 'not run', revision: 1 },
      { id: 'other', source: golden('sma'), revision: 1 },
    ]);
    const { host: h2 } = await makeHost();
    h2.setScripts([{ id: 'sma', source: golden('sma'), revision: 1 }]);
    expect(await h2.ensure('sma')).toMatchObject({ ok: true });
    h2.dispose();
  });
});

// ----------------------------------------------------------------- ICU

describe('locale APIs are removed, the calendar keeps working', () => {
  it('has no Intl and none of the ICU-backed methods', async () => {
    const { host: h } = await setup();
    const probe = `
      const bad = [];
      if (typeof Intl !== 'undefined') bad.push('Intl');
      if (typeof Temporal !== 'undefined') bad.push('Temporal');
      // Not reachable at all, also through the prototype chain (no generic toLocaleString fallback).
      const gone = [
        ['Date', new Date(0), ['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString']],
        ['Number', 1, ['toLocaleString']],
        ['BigInt', 1n, ['toLocaleString']],
        ['Array', [1], ['toLocaleString']],
        ['Float64Array', new Float64Array(1), ['toLocaleString']],
        ['Uint8Array', new Uint8Array(1), ['toLocaleString']],
        ['Object', {}, ['toLocaleString']],
        ['String', 'a', ['localeCompare', 'normalize', 'toLocaleUpperCase', 'toLocaleLowerCase']],
      ];
      for (const [owner, value, names] of gone)
        for (const n of names) if (typeof value[n] !== 'undefined') bad.push(owner + '.' + n);
      // What scripts do use still works.
      if ('abc'.toUpperCase() !== 'ABC' || (1.5).toFixed(1) !== '1.5' || new Date(0).toISOString() !== '1970-01-01T00:00:00.000Z' || [3, 1, 2].sort()[0] !== 1) bad.push('basics');
      if (bad.length) throw new Error('LEAK: ' + bad.join(','));`;
    useScript(h, 'probe', script({ top: probe }));
    const r = await h.ensure('probe');
    expect(r.ok ? 'ok' : r.reason).toBe('ok');
  });

  it('calendarPeriod (zone offsets through the captured formatter) matches the host', async () => {
    const { host: h } = await setup();
    useScript(
      h,
      'cal',
      script({
        step: "c.set('v', calendarPeriod(c.time[c.i], 'week', 'America/New_York') * 1000 + calendarPeriod(c.time[c.i], 'session', 'Asia/Tokyo') % 1000);",
      }),
    );
    const cols = { current: bars(300, 3, 1_700_000_000, 3600 * 5) };
    const us = userSeries(h, cols);
    await us.add([{ hash: 'h', type: 'user:cal', inputs: {} }]);
    expect(us.error('h')).toBeNull();
    for (const i of [0, 77, 299]) {
      const t = cols.current.time[i]!;
      const want =
        calendarPeriod(t, 'week', 'America/New_York') * 1000 +
        (calendarPeriod(t, 'session', 'Asia/Tokyo') % 1000);
      expect(us.value('h', 'v', i)).toBe(want);
    }
  });

  it('naming hundreds of zones stays bounded and answers (unknown zones count as UTC)', async () => {
    const before = rssMb();
    const { host: h } = await setup({ loadMs: 8000 });
    useScript(
      h,
      'zones',
      script({
        setup:
          "const names = Intl === undefined ? [] : []; for (let i = 0; i < 3000; i++) calendarPeriod(1.7e9 + i, 'session', 'Zone/Nowhere' + i);",
      }),
    );
    const us = userSeries(h, { current: bars(10) });
    await us.add([{ hash: 'h', type: 'user:zones', inputs: {} }]);
    // `Intl` is gone, so naming it throws; the zone loop is what the second script tests.
    expect(us.error('h')).toMatch(/Intl/);
    useScript(
      h,
      'zones2',
      script({
        setup:
          "for (let i = 0; i < 3000; i++) calendarPeriod(1.7e9 + i, 'session', 'Zone/Nowhere' + i); for (const z of ['America/New_York','Europe/London','Asia/Tokyo','Australia/Sydney','America/Chicago','Asia/Kolkata']) calendarPeriod(1.7e9, 'week', z);",
      }),
    );
    const us2 = userSeries(h, { current: bars(10) });
    await us2.add([{ hash: 'h', type: 'user:zones2', inputs: {} }]);
    expect(us2.error('h')).toBeNull();
    expect(rssMb() - before).toBeLessThan(300);
  });
});

// ------------------------------------------------- a busy isolate, a free event loop

describe('live updates while the isolate runs a long call for another series', () => {
  const SLOW = `defineIndicator({ id: 'x', name: 'X', shortName: 'X', category: 'other', overlay: false,
    inputs: { slow: { kind: 'bool', label: 'S', default: false } },
    outputs: [{ type: 'plot', id: 'v', title: 'V', kind: 'line', color: '#fff' }],
    setup({ inputs }) { if (inputs.slow) { const t = Date.now(); while (Date.now() - t < 400) {} } return (c) => { c.set('v', c.close[c.i]); }; } });`;

  it('the main thread never waits: updates are kept and go out once the isolate is free', async () => {
    const { host: h } = await setup({ loadMs: 10_000, tickMs: 250 });
    useScript(h, 'slow', SLOW);
    const colsB = { current: bars(50) };
    const colsA = { current: bars(50) };
    const B = userSeries(h, colsB, 'B');
    await B.add([{ hash: 'b', type: 'user:slow', inputs: { slow: false } }]);
    const A = userSeries(h, colsA, 'A');
    const running = A.add([{ hash: 'a', type: 'user:slow', inputs: { slow: true } }]);
    await new Promise((r) => setTimeout(r, 100)); // A's open is running in the isolate
    let worst = 0;
    // Updates of the last bar, then a bar appended twice (a gap: the full bars must follow).
    for (let k = 0; k < 3; k++) {
      const t0 = performance.now();
      B.updateBar(49, tickBar(200 + k, 49));
      worst = Math.max(worst, performance.now() - t0);
    }
    const all = bars(52);
    for (const i of [50, 51]) {
      colsB.current = slice(all, 0, i + 1);
      const t0 = performance.now();
      B.updateBar(i, barAt(all, i));
      worst = Math.max(worst, performance.now() - t0);
    }
    expect(worst).toBeLessThan(100); // blocking would be ~250 ms or more
    await B.settled();
    await running;
    expect(B.error('b')).toBeNull();
    expect(B.held('b')).toBeNull();
    for (const i of [49, 50, 51]) expect(B.value('b', 'v', i)).toBe(all.close[i]);
    expect(A.error('a')).toBeNull();
  });

  it('a timed-out update leaves the other series alone; its own series rebuilds on the next bar', async () => {
    const { host: h } = await setup({ loadMs: 5000, tickMs: 100 });
    useScript(
      h,
      'tick',
      script({ step: "if (c.close[c.i] === 12345) { while (true) {} } c.set('v', c.close[c.i]);" }),
    );
    const colsA = { current: bars(30) };
    const colsB = { current: bars(30) };
    const A = userSeries(h, colsA, 'A');
    const B = userSeries(h, colsB, 'B');
    await A.add([{ hash: 'a', type: 'user:tick', inputs: {} }]);
    await B.add([{ hash: 'b', type: 'user:tick', inputs: {} }]);
    const epoch = h.epoch('tick');
    A.updateBar(29, tickBar(12345, 29)); // strike 1
    B.updateBar(29, tickBar(150, 29)); // B's update is unaffected
    await A.settled();
    await B.settled();
    expect(B.value('b', 'v', 29)).toBe(150);
    expect(A.error('a')).toBeNull();
    expect(A.held('a')).toBeNull();
    expect(h.epoch('tick')).toBe(epoch);
    // Next bar of A: its state is rebuilt from the series' bars first.
    colsA.current = bars(30);
    A.updateBar(29, tickBar(101, 29));
    await A.settled();
    expect(A.error('a')).toBeNull();
    expect(A.value('a', 'v', 29)).toBe(colsA.current.close[29]);
  });
});
