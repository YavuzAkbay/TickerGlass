import { describe, expect, it } from 'vitest';
import { probeLineOffset } from '@investopen/indicators/core';
import type { BarColumns } from '@investopen/engine';
import type { ResultChange } from '../protocol';
import type { FromSandbox, SandboxMessage } from './protocol';
import { SandboxCore, sameValue } from './sandboxCore';

const LINE_OFFSET = probeLineOffset();

const SMA = `defineIndicator({
  id: 'ignored',
  name: 'My SMA',
  shortName: 'MySMA',
  category: 'movingAverage',
  overlay: true,
  inputs: {
    length: { kind: 'int', label: 'Length', default: 5, min: 1 },
    source: { kind: 'source', label: 'Source', default: 'close' },
  },
  outputs: [{ type: 'plot', id: 'ma', title: 'MA', kind: 'line', color: '#6E9BD6' }],
  setup({ inputs, ta }) {
    const avg = ta.sma(inputs.length);
    return (c) => {
      c.set('ma', avg.update(c.src.source[c.i]));
    };
  },
});`;

/** Counts steps in closure state: a live update runs step twice for one bar. */
const COUNTER = `defineIndicator({
  name: 'Counter',
  shortName: 'Cnt',
  category: 'other',
  overlay: false,
  inputs: {},
  outputs: [{ type: 'plot', id: 'n', title: 'N', kind: 'line', color: 'red' }],
  setup() {
    let n = 0;
    return (c) => {
      c.set('n', n++);
    };
  },
});`;

function bars(n: number): BarColumns {
  const col = (f: (i: number) => number) => Float64Array.from({ length: n }, (_, i) => f(i));
  const close = (i: number) => 100 + 10 * Math.sin(i / 7) + (i % 3);
  return {
    time: col((i) => 1_700_000_000 + i * 60),
    open: col((i) => close(i) - 0.5),
    high: col((i) => close(i) + 1),
    low: col((i) => close(i) - 1.5),
    close: col(close),
    volume: col((i) => 1000 + i),
  };
}

function sandbox(options: { probes?: boolean } = {}) {
  const out: FromSandbox[] = [];
  const core = new SandboxCore((m) => out.push(m), LINE_OFFSET, options);
  let seq = 0;
  const send = (msg: SandboxMessage) => {
    const from = out.length;
    core.handle({ seq: ++seq, msg });
    return out.slice(from);
  };
  return { out, send, core };
}

const results = (msgs: FromSandbox[]) =>
  msgs.flatMap((m) => (m.type === 'results' ? m.changes : []));

describe('SandboxCore', () => {
  it('measures a line offset in this engine', () => {
    expect(LINE_OFFSET).toBeTypeOf('number');
  });

  it('loads a script and posts its manifest with the forced id', () => {
    const { send } = sandbox();
    const msgs = send({ type: 'load', source: SMA, apiVersion: 1, scriptId: 'abc' });
    expect(msgs).toHaveLength(2);
    const loaded = msgs[0]!;
    expect(loaded.type).toBe('loaded');
    if (loaded.type !== 'loaded') return;
    expect(loaded.manifest.id).toBe('user:abc');
    expect(loaded.manifest.outputs.map((o) => o.id)).toEqual(['ma']);
    expect('setup' in loaded.manifest).toBe(false);
    expect(msgs[1]).toEqual({ type: 'ack', seq: 1 });
  });

  it('reports a runtime error during load with its line', () => {
    const { send } = sandbox();
    const source = 'const a = 1;\n\n  null.x;\ndefineIndicator({});';
    const [err, ack] = send({ type: 'load', source, apiVersion: 1, scriptId: 's' });
    expect(err).toMatchObject({ type: 'compileError', line: 3 });
    if (err?.type !== 'compileError') return;
    expect(err.message).toMatch(/^TypeError: /);
    expect(err.message).not.toMatch(/\(line/);
    expect(err.col).toBeTypeOf('number');
    expect(ack).toEqual({ type: 'ack', seq: 1 });
  });

  it('reports validation and syntax errors without failing the sandbox', () => {
    const invalid = sandbox().send({
      type: 'load',
      source: "defineIndicator({ name: 'x' });",
      apiVersion: 1,
      scriptId: 's',
    });
    expect(invalid[0]).toMatchObject({ type: 'compileError' });
    const syntax = sandbox().send({
      type: 'load',
      source: 'let = ;',
      apiVersion: 1,
      scriptId: 's',
    });
    expect(syntax[0]).toMatchObject({ type: 'compileError' });
    expect(syntax[1]).toEqual({ type: 'ack', seq: 1 });
  });

  it('rejects other API versions', () => {
    const msgs = sandbox().send({
      type: 'load',
      source: SMA,
      apiVersion: 2 as 1,
      scriptId: 's',
    });
    expect(msgs[0]).toMatchObject({
      type: 'compileError',
      message: expect.stringMatching(/API version 2/),
    });
  });

  it('reports the compile error against instances added after a failed load', () => {
    const { send } = sandbox();
    send({ type: 'load', source: 'throw new Error("boom");', apiVersion: 1, scriptId: 's' });
    const msgs = send({ type: 'add', spec: { id: 'x', type: 'user:s' } });
    expect(msgs[0]).toMatchObject({
      type: 'error',
      id: 'x',
      message: expect.stringMatching(/boom/),
    });
    expect(results(msgs)).toEqual([]);
  });

  it('computes added instances and annotates step errors with lines', () => {
    const { send } = sandbox();
    send({ type: 'load', source: SMA, apiVersion: 1, scriptId: 's' });
    send({ type: 'bars', revision: 1, bars: bars(20) });
    const changes = results(send({ type: 'add', spec: { id: 'x', type: 'user:s' } }));
    expect(changes).toHaveLength(1);
    expect(changes[0]!.status).toEqual({ state: 'ok' });
    expect(Number.isNaN(changes[0]!.values.ma![3]!)).toBe(true);
    expect(changes[0]!.values.ma![19]).toBeCloseTo(
      Array.from(bars(20).close.subarray(15)).reduce((a, b) => a + b) / 5,
    );

    const bad = sandbox();
    const source = SMA.replace("c.set('ma'", "c.i > 3 && null.x; c.set('ma'");
    bad.send({ type: 'load', source, apiVersion: 1, scriptId: 's' });
    bad.send({ type: 'bars', revision: 1, bars: bars(20) });
    const [ch] = results(bad.send({ type: 'add', spec: { id: 'x', type: 'user:s' } }));
    expect(ch?.status.state).toBe('error');
    const line = SMA.split('\n').findIndex((l) => l.includes("c.set('ma'")) + 1;
    expect(ch?.status).toMatchObject({ message: expect.stringContaining(`(line ${line}:`) });
  });

  it('is deterministic: two sandboxes on the same bars give identical arrays', () => {
    const run = () => {
      const { send } = sandbox();
      send({ type: 'load', source: SMA, apiVersion: 1, scriptId: 's' });
      send({ type: 'add', spec: { id: 'x', type: 'user:s', inputs: { length: 7 } } });
      const msgs = send({ type: 'bars', revision: 1, bars: bars(300) });
      return results(msgs);
    };
    const a = run();
    const b = run();
    expect(a).toHaveLength(1);
    expect(Array.from(a[0]!.values.ma!)).toEqual(Array.from(b[0]!.values.ma!));
  });

  it('acknowledges every message, after what it caused', () => {
    const { send, out } = sandbox();
    const all: SandboxMessage[] = [
      { type: 'ping' },
      { type: 'load', source: SMA, apiVersion: 1, scriptId: 's' },
      { type: 'context', context: { intervalSeconds: 60 } },
      { type: 'bars', revision: 1, bars: bars(10) },
      { type: 'add', spec: { id: 'x', type: 'user:s' } },
      {
        type: 'bar',
        revision: 1,
        index: 10,
        bar: { time: 1_700_000_600, open: 1, high: 2, low: 0, close: 1, volume: 5 },
      },
      { type: 'setInputs', id: 'x', inputs: { length: 3 } },
      { type: 'check', bars: bars(60), context: {}, inputs: {}, liveBars: 10 },
      { type: 'remove', id: 'x' },
      { type: 'clear' },
      { type: 'timeframeMap', map: {} } as unknown as SandboxMessage,
    ];
    all.forEach((msg, i) => {
      const msgs = send(msg);
      expect(msgs.at(-1)).toEqual({ type: 'ack', seq: i + 1 });
      expect(msgs.filter((m) => m.type === 'ack')).toHaveLength(1);
    });
    // Unsupported indicator-worker messages are refused, not forwarded.
    expect(out.at(-2)).toEqual({ type: 'error', message: 'Sandbox: unknown message' });
  });

  it('posts an error (no ack) for a message without seq', () => {
    const out: FromSandbox[] = [];
    new SandboxCore((m) => out.push(m), LINE_OFFSET).handle({ msg: { type: 'ping' } });
    expect(out).toEqual([{ type: 'error', message: 'Sandbox: message without seq' }]);
  });

  it('posts results only for its own instances; built-ins are not registered', () => {
    const { send, out } = sandbox();
    send({ type: 'load', source: SMA, apiVersion: 1, scriptId: 's' });
    send({ type: 'bars', revision: 1, bars: bars(30) });
    const builtin = send({ type: 'add', spec: { id: 'b', type: 'sma' } });
    expect(builtin[0]).toMatchObject({ type: 'error', id: 'b' });
    send({ type: 'add', spec: { id: 'x', type: 'user:s' } });
    send({
      type: 'bar',
      revision: 1,
      index: 30,
      bar: { time: 1_700_001_800, open: 1, high: 2, low: 0, close: 1, volume: 5 },
    });
    const ids = new Set(results(out).map((c: ResultChange) => c.id));
    expect([...ids]).toEqual(['x']);
  });

  it('rejects a second load', () => {
    const { send } = sandbox();
    send({ type: 'load', source: SMA, apiVersion: 1, scriptId: 's' });
    const msgs = send({ type: 'load', source: SMA, apiVersion: 1, scriptId: 's' });
    expect(msgs[0]).toEqual({ type: 'error', message: 'Sandbox: a script is already loaded' });
  });

  describe('check', () => {
    const check = (source: string, liveBars = 50) => {
      const { send } = sandbox();
      send({ type: 'load', source, apiVersion: 1, scriptId: 's' });
      return send({ type: 'check', bars: bars(200), context: {}, inputs: {}, liveBars });
    };

    it('passes a script whose state lives in ta', () => {
      expect(check(SMA)).toEqual([
        { type: 'checkResult', ok: true },
        { type: 'ack', seq: 2 },
      ]);
    });

    it('flags closure state with the first mismatching output and index', () => {
      const [r] = check(COUNTER);
      expect(r).toEqual({
        type: 'checkResult',
        ok: false,
        // Bar n−K: its opening tick advanced the counter once more than a full run.
        mismatch: { outputId: 'n', index: 150, full: 150, live: 151 },
      });
    });

    it('uses the default live bar count for invalid counts and clamps to the bars', () => {
      const [r] = check(COUNTER, 0);
      expect(r).toMatchObject({ ok: false, mismatch: { index: 150 } });
      const [all] = check(COUNTER, 10_000);
      expect(all).toMatchObject({ ok: false, mismatch: { index: 0, full: 0, live: 1 } });
    });

    it('does not touch the instances the sandbox computes', () => {
      const { send } = sandbox();
      send({ type: 'load', source: SMA, apiVersion: 1, scriptId: 's' });
      send({ type: 'add', spec: { id: 'x', type: 'user:s' } });
      const msgs = send({ type: 'check', bars: bars(100), context: {}, inputs: {}, liveBars: 50 });
      expect(results(msgs)).toEqual([]);
    });

    it('reports a script error instead of a result, and needs a loaded script', () => {
      const throwing = SMA.replace(
        "c.set('ma'",
        "if (c.i === 5) throw new Error('bad'); c.set('ma'",
      );
      expect(check(throwing)[0]).toMatchObject({
        type: 'error',
        message: expect.stringMatching(/^Check \(full\): bad \(line \d+:\d+\)$/),
      });
      const { send } = sandbox();
      expect(
        send({ type: 'check', bars: bars(10), context: {}, inputs: {}, liveBars: 5 })[0],
      ).toEqual({
        type: 'error',
        message: 'Check: no script loaded',
      });
    });

    it('compares within 1e-9 relative tolerance, NaN equal to NaN', () => {
      expect(sameValue(NaN, NaN)).toBe(true);
      expect(sameValue(NaN, 0)).toBe(false);
      expect(sameValue(1e6 + 1e-4, 1e6)).toBe(true);
      expect(sameValue(1e6 + 1e-2, 1e6)).toBe(false);
      expect(sameValue(5e-10, 0)).toBe(true);
      expect(sameValue(Infinity, Infinity)).toBe(true);
      expect(sameValue(Infinity, -Infinity)).toBe(false);
    });
  });

  it('rejects probes unless enabled (production)', () => {
    const { send } = sandbox();
    expect(send({ type: 'probe', code: 'return 1;' })).toEqual([
      { type: 'error', message: 'Sandbox: unknown message' },
      { type: 'ack', seq: 1 },
    ]);
  });

  it('keeps acks in seq order while a probe runs; one probe at a time', async () => {
    const { send, out } = sandbox({ probes: true });
    send({ type: 'probe', code: 'return Promise.resolve().then(() => 1);' });
    send({ type: 'ping' });
    send({ type: 'probe', code: 'return 2;' });
    expect(out).toEqual([{ type: 'error', message: 'Sandbox: a probe is already running' }]);
    await new Promise((r) => setTimeout(r, 0));
    expect(out.slice(1)).toEqual([
      { type: 'probeResult', seq: 1, ok: true, value: '1' },
      { type: 'ack', seq: 1 },
      { type: 'ack', seq: 2 },
      { type: 'ack', seq: 3 },
    ]);
    send({ type: 'ping' });
    expect(out.at(-1)).toEqual({ type: 'ack', seq: 4 });
  });

  it('never hands a replaced Promise.prototype.then a callback (probe path)', async () => {
    const { send, out } = sandbox({ probes: true });
    const then0 = Promise.prototype.then;
    const leaked: unknown[] = [];
    // User code: records every callback attached with `then`.
    Promise.prototype.then = function (this: Promise<unknown>, f?: unknown, r?: unknown) {
      leaked.push(f);
      return Reflect.apply(then0, this, [f, r]) as Promise<never>;
    };
    try {
      send({ type: 'probe', code: 'return 7;' });
    } finally {
      Promise.prototype.then = then0;
    }
    expect(leaked).toEqual([]);
    await new Promise((r) => setTimeout(r, 0));
    expect(out).toEqual([
      { type: 'probeResult', seq: 1, ok: true, value: '7' },
      { type: 'ack', seq: 1 },
    ]);
  });

  it('runs probes and acks after the result', async () => {
    const { send, out } = sandbox({ probes: true });
    send({ type: 'probe', code: 'return Promise.resolve(6 * 7);' });
    await new Promise((r) => setTimeout(r, 0));
    expect(out).toEqual([
      { type: 'probeResult', seq: 1, ok: true, value: '42' },
      { type: 'ack', seq: 1 },
    ]);
    send({ type: 'probe', code: 'const a = 1;\n  null.x;' });
    await new Promise((r) => setTimeout(r, 0));
    expect(out[2]).toMatchObject({ type: 'probeResult', ok: false, line: 2 });
  });
});
