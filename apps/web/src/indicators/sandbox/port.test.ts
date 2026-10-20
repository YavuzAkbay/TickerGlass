import type { BarColumns } from '@investopen/engine';
import {
  compileUserScript,
  probeLineOffset,
  type RuntimeContext,
} from '@investopen/indicators/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerPort } from '../controller';
import type { FromWorker, ToWorker } from '../protocol';
import { MAX_SCRIPT_INSTANCES_PER_CHART, SCRIPT_INSTANCE_CAP_MESSAGE } from './limits';
import {
  MAX_SANDBOX_RESYNCS,
  OUT_OF_SYNC_MESSAGE,
  SCRIPT_CHANGED_MESSAGE,
  ScriptRouterPort,
  canonicalJson,
  stoppedMessage,
  type SandboxPort,
  type ScriptSource,
} from './port';
import type { FromSandbox, SandboxMessage, ToSandbox } from './protocol';
import { SandboxCore } from './sandboxCore';

const LINE_OFFSET = probeLineOffset();

const smaSource = (title = 'MA') => `defineIndicator({
  name: 'My SMA',
  shortName: 'MySMA',
  category: 'movingAverage',
  overlay: true,
  inputs: { length: { kind: 'int', label: 'Length', default: 3, min: 1 } },
  outputs: [{ type: 'plot', id: 'ma', title: '${title}', kind: 'line', color: '#2962ff' }],
  setup({ inputs, ta }) {
    const avg = ta.sma(inputs.length);
    return (c) => c.set('ma', avg.update(c.close[c.i]));
  },
});`;

function script(source = smaSource(), id = 's1'): ScriptSource {
  const { manifest } = compileUserScript(source, { scriptId: id, lineOffset: LINE_OFFSET });
  return { source, manifest: JSON.parse(JSON.stringify(manifest)) as Record<string, unknown> };
}

function bars(n: number, start = 0): BarColumns {
  const c = {
    time: new Float64Array(n),
    open: new Float64Array(n),
    high: new Float64Array(n),
    low: new Float64Array(n),
    close: new Float64Array(n),
    volume: new Float64Array(n),
  };
  for (let i = 0; i < n; i++) {
    c.time[i] = 1_700_000_000 + (start + i) * 60;
    c.open[i] = c.high[i] = c.low[i] = c.close[i] = start + i + 1;
    c.volume[i] = 1;
  }
  return c;
}

const buffers = (c: BarColumns): Transferable[] => [
  c.time.buffer,
  c.open.buffer,
  c.high.buffer,
  c.low.buffer,
  c.close.buffer,
  c.volume.buffer,
];

const CONTEXT: RuntimeContext = {
  timezone: 'UTC',
  session: null,
  intervalSeconds: 60,
  timeframeSeconds: {},
};

class FakeInner implements WorkerPort {
  posted: { msg: ToWorker; transfer: Transferable[] }[] = [];
  fn: ((msg: FromWorker) => void) | null = null;
  terminated = false;
  post(msg: ToWorker, transfer: Transferable[] = []) {
    this.posted.push({ msg, transfer });
  }
  listen(fn: (msg: FromWorker) => void) {
    this.fn = fn;
  }
  terminate() {
    this.terminated = true;
  }
  types = () => this.posted.map((p) => p.msg.type);
}

/**
 * A sandbox worker stand-in. Manual by default (the test answers); `live`
 * runs a real SandboxCore, with messages crossing like postMessage (cloned,
 * transferred) and delivered on `flush()`.
 */
class FakeSandbox implements SandboxPort {
  posted: { data: ToSandbox; transfer: Transferable[] }[] = [];
  terminated = false;
  private onMessage: ((msg: FromSandbox) => void) | null = null;
  private onFailure: ((message: string) => void) | null = null;
  private core: SandboxCore | null = null;
  private outbox: FromSandbox[] = [];

  constructor(live: boolean) {
    if (live)
      this.core = new SandboxCore(
        (msg, transfer) => this.outbox.push(structuredClone(msg, { transfer })),
        LINE_OFFSET,
      );
  }
  /** Live: lose the next messages of these types (never reach the core; acked). */
  lose = new Set<string>();
  post(data: ToSandbox, transfer: Transferable[] = []) {
    if (this.terminated) throw new Error('post after terminate');
    this.posted.push({ data, transfer });
    if (this.core && this.lose.delete(data.msg.type)) {
      this.outbox.push({ type: 'ack', seq: data.seq });
      return;
    }
    this.core?.handle(structuredClone(data, { transfer }));
  }
  listen(onMessage: (msg: FromSandbox) => void, onFailure: (message: string) => void) {
    this.onMessage = onMessage;
    this.onFailure = onFailure;
  }
  terminate() {
    this.terminated = true;
  }
  /** Deliver what the live core posted. */
  flush() {
    const out = this.outbox;
    this.outbox = [];
    if (!this.terminated) for (const m of out) this.onMessage?.(m);
  }
  emit(msg: unknown) {
    this.onMessage?.(msg as FromSandbox);
  }
  fail(message: string) {
    this.onFailure?.(message);
  }
  ackAll() {
    for (const p of this.posted) this.emit({ type: 'ack', seq: p.data.seq });
  }
  msgs = (): SandboxMessage[] => this.posted.map((p) => p.data.msg);
  types = () => this.msgs().map((m) => m.type);
}

interface Setup {
  port: ScriptRouterPort;
  inner: FakeInner;
  sandboxes: FakeSandbox[];
  out: FromWorker[];
  scripts: Map<string, ScriptSource>;
}

function setup(opts: { live?: boolean; scripts?: Record<string, ScriptSource> } = {}): Setup {
  const inner = new FakeInner();
  const sandboxes: FakeSandbox[] = [];
  const scripts = new Map(Object.entries(opts.scripts ?? { s1: script() }));
  const port = new ScriptRouterPort(inner, {
    getScript: (id) => scripts.get(id),
    spawn: () => {
      const sb = new FakeSandbox(opts.live ?? false);
      sandboxes.push(sb);
      return sb;
    },
  });
  const out: FromWorker[] = [];
  port.listen((m) => out.push(m));
  return { port, inner, sandboxes, out, scripts };
}

const addUser = (port: ScriptRouterPort, id = 'u1', inputs = {}, scriptId = 's1') =>
  port.post({ type: 'add', spec: { id, type: `user:${scriptId}`, inputs } });

function sendBars(port: ScriptRouterPort, revision: number, n: number, context?: RuntimeContext) {
  const b = bars(n);
  port.post({ type: 'bars', revision, bars: b, ...(context ? { context } : {}) }, buffers(b));
  return b;
}

const errors = (out: FromWorker[]) =>
  out.filter((m): m is Extract<FromWorker, { type: 'error' }> => m.type === 'error');

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('ScriptRouterPort routing', () => {
  it('sends built-ins to the inner worker and spawns a sandbox per user instance', () => {
    const { port, inner, sandboxes } = setup();
    port.post({ type: 'add', spec: { id: 'b1', type: 'sma', inputs: {} } });
    expect(inner.types()).toEqual(['add']);
    expect(sandboxes).toHaveLength(0);
    addUser(port, 'u1');
    addUser(port, 'u2');
    expect(inner.types()).toEqual(['add']);
    expect(sandboxes).toHaveLength(2);
    expect(sandboxes[0]!.types()).toEqual(['load', 'add']);
    const load = sandboxes[0]!.msgs()[0] as Extract<SandboxMessage, { type: 'load' }>;
    expect(load).toEqual({ type: 'load', source: smaSource(), apiVersion: 1, scriptId: 's1' });
    // Wrapped with increasing seqs.
    expect(sandboxes[0]!.posted.map((p) => p.data.seq)).toEqual([1, 2]);
  });

  it('replays context and the mirrored bars to a sandbox spawned later', () => {
    const { port, sandboxes } = setup();
    port.post({ type: 'context', context: CONTEXT });
    sendBars(port, 4, 10);
    port.post({ type: 'bar', revision: 4, index: 10, bar: { ...barAt(bars(11), 10) } });
    addUser(port, 'u1', { length: 5 });
    const sb = sandboxes[0]!;
    expect(sb.types()).toEqual(['load', 'context', 'bars', 'add']);
    const b = sb.msgs()[2] as Extract<SandboxMessage, { type: 'bars' }>;
    expect(b.revision).toBe(4);
    expect(b.bars.close.length).toBe(11);
    expect(b.bars.close[10]).toBe(11);
    expect(sb.msgs()[3]).toEqual({
      type: 'add',
      spec: { id: 'u1', type: 'user:s1', inputs: { length: 5 } },
    });
  });

  it('coerces inputs to the saved definition on add and setInputs', () => {
    const { port, sandboxes } = setup();
    addUser(port, 'u1', { length: 'x', bogus: 1 });
    expect(sandboxes[0]!.msgs()[1]).toEqual({
      type: 'add',
      spec: { id: 'u1', type: 'user:s1', inputs: { length: 3 } },
    });
    port.post({ type: 'setInputs', id: 'u1', inputs: { length: 7, other: true } });
    expect(sandboxes[0]!.msgs()[2]).toEqual({
      type: 'setInputs',
      id: 'u1',
      inputs: { length: 7 },
    });
  });

  it('inner gets the transferred bars; each sandbox gets its own copy', () => {
    const { port, inner, sandboxes } = setup();
    addUser(port, 'u1');
    addUser(port, 'u2');
    const b = sendBars(port, 1, 5, CONTEXT);
    const posted = inner.posted.at(-1)!;
    expect(posted.msg.type).toBe('bars');
    expect(posted.transfer).toEqual(buffers(b));
    expect((posted.msg as Extract<ToWorker, { type: 'bars' }>).bars).toBe(b);
    const copies = sandboxes.map((sb) => {
      const p = sb.posted.at(-1)!;
      const msg = p.data.msg as Extract<SandboxMessage, { type: 'bars' }>;
      expect(msg.context).toEqual(CONTEXT);
      expect(p.transfer).toEqual(buffers(msg.bars));
      return msg.bars;
    });
    expect(copies[0]!.close).not.toBe(b.close);
    expect(copies[0]!.close).not.toBe(copies[1]!.close);
    expect([...copies[0]!.close]).toEqual([...b.close]);
    expect([...copies[1]!.close]).toEqual([1, 2, 3, 4, 5]);
  });

  it('broadcasts bar, context and clear; keeps chart-only messages in the inner worker', () => {
    const { port, inner, sandboxes } = setup();
    addUser(port, 'u1');
    sendBars(port, 1, 3);
    const n = sandboxes[0]!.posted.length;
    port.post({ type: 'bar', revision: 1, index: 3, bar: barAt(bars(4), 3) });
    port.post({ type: 'context', context: CONTEXT });
    port.post({ type: 'clear' });
    port.post({ type: 'timeframeMap', map: {} });
    port.post({ type: 'tfBars', tf: '1D', bars: bars(2) });
    port.post({ type: 'tfBar', tf: '1D', bar: barAt(bars(1), 0) });
    port.post({ type: 'extBars', revision: 1, symbol: 'X', bars: bars(2) });
    port.post({ type: 'extUpdate', revision: 1, symbol: 'X', from: 0, bars: bars(1) });
    expect(sandboxes[0]!.types().slice(n)).toEqual(['bar', 'context', 'clear']);
    expect(inner.types()).toEqual([
      'bars',
      'bar',
      'context',
      'clear',
      'timeframeMap',
      'tfBars',
      'tfBar',
      'extBars',
      'extUpdate',
    ]);
  });

  it('routes setInputs and remove by instance id', () => {
    const { port, inner, sandboxes } = setup();
    addUser(port, 'u1');
    port.post({ type: 'setInputs', id: 'b1', inputs: {} });
    port.post({ type: 'remove', id: 'b1' });
    expect(inner.types()).toEqual(['setInputs', 'remove']);
    port.post({ type: 'remove', id: 'u1' });
    expect(sandboxes[0]!.terminated).toBe(true);
    expect(inner.types()).toEqual(['setInputs', 'remove']);
    // Gone: later messages for it go nowhere special.
    sendBars(port, 1, 2);
    expect(sandboxes[0]!.types()).toEqual(['load', 'add']);
  });

  it('spawns nothing for a missing script or one without a manifest', () => {
    const { port, sandboxes, out } = setup({
      scripts: { broken: { source: 'x', manifest: null } },
    });
    addUser(port, 'u1', {}, 'gone');
    addUser(port, 'u2', {}, 'broken');
    expect(sandboxes).toHaveLength(0);
    expect(out).toEqual([]);
  });

  it(`caps sandboxes at ${MAX_SCRIPT_INSTANCES_PER_CHART}`, () => {
    const { port, sandboxes, out } = setup();
    for (let i = 0; i <= MAX_SCRIPT_INSTANCES_PER_CHART; i++) addUser(port, `u${i}`);
    expect(sandboxes).toHaveLength(MAX_SCRIPT_INSTANCES_PER_CHART);
    expect(errors(out)).toEqual([
      {
        type: 'error',
        id: `u${MAX_SCRIPT_INSTANCES_PER_CHART}`,
        message: SCRIPT_INSTANCE_CAP_MESSAGE,
      },
    ]);
  });

  it('terminate kills every sandbox and the inner worker', () => {
    const { port, inner, sandboxes } = setup();
    addUser(port, 'u1');
    addUser(port, 'u2');
    port.terminate();
    expect(inner.terminated).toBe(true);
    expect(sandboxes.every((s) => s.terminated)).toBe(true);
    // No timers left behind.
    expect(vi.getTimerCount()).toBe(0);
    port.post({ type: 'bars', revision: 1, bars: bars(1) });
    expect(inner.types()).toEqual([]);
  });
});

describe('ScriptRouterPort messages from sandboxes', () => {
  it('passes results of a live sandbox through', () => {
    const { port, sandboxes, out } = setup({ live: true });
    sendBars(port, 2, 5, CONTEXT);
    addUser(port, 'u1');
    sandboxes[0]!.flush();
    const results = out.filter((m) => m.type === 'results');
    expect(results).toHaveLength(1);
    const r = results[0] as Extract<FromWorker, { type: 'results' }>;
    expect(r.revision).toBe(2);
    expect(r.changes.map((c) => c.id)).toEqual(['u1']);
    expect([...r.changes[0]!.values.ma!]).toEqual([NaN, NaN, 2, 3, 4]);
    expect(errors(out)).toEqual([]);
  });

  it('drops spoofed results for other instances and malformed arrays', () => {
    const { port, sandboxes, out } = setup();
    addUser(port, 'u1');
    port.post({ type: 'add', spec: { id: 'b1', type: 'sma', inputs: {} } });
    const sb = sandboxes[0]!;
    const change = (id: string, values: unknown, colors: unknown = {}) => ({
      id,
      from: 0,
      status: { state: 'ok' },
      values,
      colors,
    });
    sb.emit({
      type: 'results',
      revision: 1,
      length: 2,
      changes: [change('b1', { v: new Float64Array([6, 6]) })],
    });
    sb.emit({
      type: 'results',
      revision: 1,
      length: 2,
      changes: [change('u1', { ma: [1, 2] })],
    });
    sb.emit({
      type: 'results',
      revision: 1,
      length: 2,
      changes: [change('u1', { ma: new Float64Array(2) }, { ma: new Float64Array(2) })],
    });
    sb.emit({
      type: 'results',
      revision: 1,
      length: 2,
      changes: [{ ...change('u1', {}), from: 9 }],
    });
    expect(out).toEqual([]);
    sb.emit({
      type: 'results',
      revision: 1,
      length: 2,
      changes: [
        change('b1', { v: new Float64Array([6, 6]) }),
        change('u1', { ma: new Float64Array([1, 2]) }, { ma: new Uint8Array([0, 1]) }),
      ],
    });
    expect(out).toEqual([
      {
        type: 'results',
        revision: 1,
        length: 2,
        changes: [
          {
            id: 'u1',
            from: 0,
            status: { state: 'ok' },
            values: { ma: new Float64Array([1, 2]) },
            colors: { ma: new Uint8Array([0, 1]) },
          },
        ],
      },
    ]);
  });

  it('labels id-less (and foreign) errors with the instance id', () => {
    const { port, sandboxes, out } = setup();
    addUser(port, 'u1');
    sandboxes[0]!.emit({ type: 'error', message: 'Sandbox: unknown message' });
    sandboxes[0]!.emit({ type: 'error', id: 'b1', message: 'boom' });
    expect(errors(out)).toEqual([
      { type: 'error', id: 'u1', message: 'Sandbox: unknown message' },
      { type: 'error', id: 'u1', message: 'boom' },
    ]);
  });

  it('a compile error reaches the instance through its add', () => {
    const broken = script();
    broken.source = 'defineIndicator(;';
    const { port, sandboxes, out } = setup({ live: true, scripts: { s1: broken } });
    addUser(port, 'u1');
    sandboxes[0]!.flush();
    const errs = errors(out);
    expect(errs).toHaveLength(1);
    expect(errs[0]!.id).toBe('u1');
    expect(errs[0]!.message).toMatch(/SyntaxError/);
  });

  it('drops timeframes, symbols and stray messages', () => {
    const { port, sandboxes, out } = setup();
    addUser(port, 'u1');
    const sb = sandboxes[0]!;
    sb.emit({ type: 'timeframes', timeframes: ['1D'] });
    sb.emit({ type: 'symbols', symbols: ['AAPL'] });
    sb.emit({ type: 'checkResult', ok: true });
    sb.emit(null);
    sb.emit('results');
    expect(out).toEqual([]);
  });

  it('stops the instance when the compiled manifest differs from the saved one', () => {
    const { port, sandboxes, out, scripts } = setup({ live: true });
    // Saved manifest says title 'MA'; the stored source now compiles to 'Other'.
    scripts.set('s1', { ...script(), source: smaSource('Other') });
    addUser(port, 'u1');
    sandboxes[0]!.flush();
    expect(errors(out)).toEqual([{ type: 'error', id: 'u1', message: SCRIPT_CHANGED_MESSAGE }]);
    expect(sandboxes[0]!.terminated).toBe(true);
    expect(out.some((m) => m.type === 'results')).toBe(false);
  });

  it('accepts the same manifest in any key order', () => {
    const { port, sandboxes, out, scripts } = setup();
    const s = script();
    const reordered = Object.fromEntries(Object.entries(s.manifest!).reverse());
    scripts.set('s1', { ...s, manifest: reordered });
    addUser(port, 'u1');
    sandboxes[0]!.emit({ type: 'loaded', manifest: s.manifest });
    expect(out).toEqual([]);
    expect(sandboxes[0]!.terminated).toBe(false);
    expect(canonicalJson({ b: 1, a: [{ d: 1, c: 2 }] })).toBe('{"a":[{"c":2,"d":1}],"b":1}');
  });

  it('a worker failure is an error of that instance only', () => {
    const { port, inner, sandboxes, out } = setup();
    addUser(port, 'u1');
    addUser(port, 'u2');
    sandboxes[0]!.fail('Sandbox worker failed: boom');
    expect(errors(out)).toEqual([
      { type: 'error', id: 'u1', message: 'Sandbox worker failed: boom' },
    ]);
    expect(sandboxes[0]!.terminated).toBe(true);
    expect(sandboxes[1]!.terminated).toBe(false);
    sendBars(port, 1, 3);
    expect(inner.types()).toEqual(['bars']);
    expect(sandboxes[1]!.types().at(-1)).toBe('bars');
  });

  it('resends the mirror on resync, at most 3 times per revision, never forwarding it', () => {
    const { port, sandboxes, out } = setup();
    addUser(port, 'u1');
    sendBars(port, 1, 4);
    const sb = sandboxes[0]!;
    const barsPosted = () => sb.types().filter((t) => t === 'bars').length;
    expect(barsPosted()).toBe(1);
    // Stale: the sandbox had not seen the latest bars yet.
    sb.emit({ type: 'resync', revision: 1, bars: 0 });
    expect(barsPosted()).toBe(1);
    // Wrong revision.
    sb.emit({ type: 'resync', revision: 0, bars: 1 });
    expect(barsPosted()).toBe(1);
    for (let i = 1; i <= MAX_SANDBOX_RESYNCS; i++) {
      sb.emit({ type: 'resync', revision: 1, bars: i });
      expect(barsPosted()).toBe(1 + i);
    }
    const last = sb.msgs().at(-1) as Extract<SandboxMessage, { type: 'bars' }>;
    expect([...last.bars.close]).toEqual([1, 2, 3, 4]);
    sb.emit({ type: 'resync', revision: 1, bars: 4 });
    sb.emit({ type: 'resync', revision: 1, bars: 4 });
    expect(barsPosted()).toBe(1 + MAX_SANDBOX_RESYNCS);
    expect(out).toEqual([{ type: 'error', id: 'u1', message: OUT_OF_SYNC_MESSAGE }]);
    // A new revision resets the budget.
    sendBars(port, 2, 4);
    sb.emit({ type: 'resync', revision: 2, bars: 5 });
    expect(barsPosted()).toBe(3 + MAX_SANDBOX_RESYNCS);
  });

  it('does not resync from a dirty mirror (the next bars repair it)', () => {
    const { port, sandboxes } = setup();
    addUser(port, 'u1');
    sendBars(port, 1, 4);
    port.post({ type: 'bar', revision: 1, index: 9, bar: barAt(bars(1), 0) });
    const sb = sandboxes[0]!;
    const n = sb.posted.length;
    sb.emit({ type: 'resync', revision: 1, bars: 1 });
    expect(sb.posted.length).toBe(n);
  });

  it('a live resync through a real SandboxCore heals a gap', () => {
    const { port, sandboxes, out } = setup({ live: true });
    sendBars(port, 1, 4);
    addUser(port, 'u1');
    const sb = sandboxes[0]!;
    sb.flush();
    // The sandbox misses bar 4, so bar 5 does not fit its series.
    sb.lose.add('bar');
    port.post({ type: 'bar', revision: 1, index: 4, bar: barAt(bars(5), 4) });
    port.post({ type: 'bar', revision: 1, index: 5, bar: barAt(bars(6), 5) });
    const before = sb.types().length;
    out.length = 0;
    sb.flush();
    // resync answered inside the port with the mirror (6 bars), not forwarded.
    expect(sb.types().slice(before)).toEqual(['bars']);
    expect(out.some((m) => m.type === 'resync')).toBe(false);
    sb.flush();
    const r = out.filter((m) => m.type === 'results').at(-1) as Extract<
      FromWorker,
      { type: 'results' }
    >;
    expect(r.length).toBe(6);
    expect(r.changes[0]!.from).toBe(0);
    expect([...r.changes[0]!.values.ma!]).toEqual([NaN, NaN, 2, 3, 4, 5]);
  });
});

describe('ScriptRouterPort watchdog', () => {
  it('kills a sandbox that does not ack load within 10 s', () => {
    const { port, sandboxes, out } = setup();
    addUser(port, 'u1');
    vi.advanceTimersByTime(9_999);
    expect(sandboxes[0]!.terminated).toBe(false);
    vi.advanceTimersByTime(1);
    expect(sandboxes[0]!.terminated).toBe(true);
    expect(out).toEqual([{ type: 'error', id: 'u1', message: stoppedMessage(10_000) }]);
    expect(stoppedMessage(10_000)).toBe('Stopped: no response for 10 s (endless loop?)');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('gives other messages 5 s, measured from when they become the oldest', () => {
    const { port, sandboxes, out } = setup();
    addUser(port, 'u1');
    const sb = sandboxes[0]!;
    // load handled after 8 s: the add (posted at 0) now gets its own 5 s.
    vi.advanceTimersByTime(8_000);
    sb.emit({ type: 'ack', seq: 1 });
    vi.advanceTimersByTime(4_999);
    expect(sb.terminated).toBe(false);
    vi.advanceTimersByTime(1);
    expect(sb.terminated).toBe(true);
    expect(out).toEqual([{ type: 'error', id: 'u1', message: stoppedMessage(5_000) }]);
  });

  it('gives bars 10 s', () => {
    const { port, sandboxes, out } = setup();
    addUser(port, 'u1');
    const sb = sandboxes[0]!;
    sb.ackAll();
    sendBars(port, 1, 3);
    vi.advanceTimersByTime(9_999);
    expect(sb.terminated).toBe(false);
    vi.advanceTimersByTime(1);
    expect(out).toEqual([{ type: 'error', id: 'u1', message: stoppedMessage(10_000) }]);
  });

  it('pings an idle sandbox every 10 s and kills it 5 s after an unanswered ping', () => {
    const { port, sandboxes, out } = setup();
    addUser(port, 'u1');
    const sb = sandboxes[0]!;
    sb.ackAll();
    vi.advanceTimersByTime(10_000);
    expect(sb.types().at(-1)).toBe('ping');
    sb.ackAll();
    vi.advanceTimersByTime(10_000);
    expect(sb.types().filter((t) => t === 'ping')).toHaveLength(2);
    vi.advanceTimersByTime(4_999);
    expect(sb.terminated).toBe(false);
    vi.advanceTimersByTime(1);
    expect(sb.terminated).toBe(true);
    expect(out).toEqual([{ type: 'error', id: 'u1', message: stoppedMessage(5_000) }]);
  });

  it('a live sandbox that keeps answering is never stopped', () => {
    const { port, sandboxes, out } = setup({ live: true });
    sendBars(port, 1, 5);
    addUser(port, 'u1');
    const sb = sandboxes[0]!;
    for (let t = 0; t < 60; t++) {
      sb.flush();
      vi.advanceTimersByTime(1_000);
    }
    expect(sb.terminated).toBe(false);
    expect(errors(out)).toEqual([]);
    expect(sb.types().filter((t) => t === 'ping').length).toBeGreaterThanOrEqual(5);
  });

  it('does not restart on its own; new inputs respawn with a full replay', () => {
    const { port, sandboxes } = setup();
    port.post({ type: 'context', context: CONTEXT });
    sendBars(port, 1, 3);
    addUser(port, 'u1');
    vi.advanceTimersByTime(10_000);
    expect(sandboxes).toHaveLength(1);
    sendBars(port, 2, 4);
    port.post({ type: 'bar', revision: 2, index: 4, bar: barAt(bars(5), 4) });
    vi.advanceTimersByTime(60_000);
    expect(sandboxes).toHaveLength(1);
    port.post({ type: 'setInputs', id: 'u1', inputs: { length: 2 } });
    expect(sandboxes).toHaveLength(2);
    const sb = sandboxes[1]!;
    expect(sb.types()).toEqual(['load', 'context', 'bars', 'add']);
    const b = sb.msgs()[2] as Extract<SandboxMessage, { type: 'bars' }>;
    expect(b.revision).toBe(2);
    expect(b.bars.close.length).toBe(5);
    expect(sb.msgs()[3]).toEqual({
      type: 'add',
      spec: { id: 'u1', type: 'user:s1', inputs: { length: 2 } },
    });
  });
});

describe('ScriptRouterPort reloadScript', () => {
  it('respawns every instance of a changed script with a replay', () => {
    const { port, sandboxes, scripts } = setup({
      scripts: { s1: script(), s2: script(smaSource(), 's2') },
    });
    port.post({ type: 'context', context: CONTEXT });
    sendBars(port, 1, 3);
    addUser(port, 'u1', { length: 2 });
    addUser(port, 'u2');
    addUser(port, 'u3', {}, 's2');
    expect(sandboxes).toHaveLength(3);
    // Unchanged: nothing happens.
    port.reloadScript('s1');
    expect(sandboxes).toHaveLength(3);
    scripts.set('s1', script(smaSource('Changed')));
    port.reloadScript('s1');
    expect(sandboxes).toHaveLength(5);
    expect(sandboxes.map((s) => s.terminated)).toEqual([true, true, false, false, false]);
    expect(sandboxes[3]!.types()).toEqual(['load', 'context', 'bars', 'add']);
    expect((sandboxes[3]!.msgs()[0] as { source: string }).source).toBe(smaSource('Changed'));
    expect(sandboxes[3]!.msgs()[3]).toEqual({
      type: 'add',
      spec: { id: 'u1', type: 'user:s1', inputs: { length: 2 } },
    });
  });

  it('stops instances of a deleted script and restarts them when it returns', () => {
    const { port, sandboxes, scripts, out } = setup();
    addUser(port, 'u1');
    const saved = scripts.get('s1')!;
    scripts.delete('s1');
    port.reloadScript('s1');
    expect(sandboxes[0]!.terminated).toBe(true);
    expect(sandboxes).toHaveLength(1);
    // The controller shows "Script deleted"; the port adds nothing.
    expect(out).toEqual([]);
    scripts.set('s1', { ...saved, manifest: null });
    port.reloadScript('s1');
    expect(sandboxes).toHaveLength(1);
    scripts.set('s1', saved);
    port.reloadScript('s1');
    expect(sandboxes).toHaveLength(2);
    expect(sandboxes[1]!.types()).toEqual(['load', 'add']);
  });

  it('restarts a sandbox the watchdog stopped', () => {
    const { port, sandboxes, scripts } = setup();
    addUser(port, 'u1');
    vi.advanceTimersByTime(10_000);
    expect(sandboxes[0]!.terminated).toBe(true);
    scripts.set('s1', script(smaSource('Fixed')));
    port.reloadScript('s1');
    expect(sandboxes).toHaveLength(2);
    expect(sandboxes[1]!.terminated).toBe(false);
  });

  it('ignores late messages of a replaced sandbox', () => {
    const { port, sandboxes, scripts, out } = setup();
    addUser(port, 'u1');
    scripts.set('s1', script(smaSource('New')));
    port.reloadScript('s1');
    sandboxes[0]!.emit({ type: 'error', message: 'late' });
    sandboxes[0]!.emit({
      type: 'results',
      revision: 0,
      length: 1,
      changes: [
        {
          id: 'u1',
          from: 0,
          status: { state: 'ok' },
          values: { ma: new Float64Array(1) },
          colors: {},
        },
      ],
    });
    expect(out).toEqual([]);
  });
});

function barAt(c: BarColumns, i: number) {
  return {
    time: c.time[i]!,
    open: c.open[i]!,
    high: c.high[i]!,
    low: c.low[i]!,
    close: c.close[i]!,
    volume: c.volume[i]!,
  };
}
