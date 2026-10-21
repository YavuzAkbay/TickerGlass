import type { BarColumns } from '@tickerglass/engine';
import {
  compileUserScript,
  probeLineOffset,
  type RuntimeContext,
} from '@tickerglass/indicators/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerPort } from '../controller';
import type { FromWorker, ToWorker } from '../protocol';
import { MAX_SCRIPT_INSTANCES_PER_CHART, SCRIPT_INSTANCE_CAP_MESSAGE } from './limits';
import {
  BACKLOG_MESSAGE,
  FLOOD_MESSAGE,
  MAX_MESSAGE_AGE_MS,
  MAX_PENDING_MESSAGES,
  MAX_SANDBOX_RESYNCS,
  OUT_OF_SYNC_MESSAGE,
  PING_DEADLINE_MS,
  POSTS_PER_PENDING,
  POSTS_SLACK,
  PROTOCOL_MESSAGE,
  SCRIPT_CHANGED_MESSAGE,
  ScriptRouterPort,
  canonicalJson,
  createSandboxWorker,
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
  outputs: [{ type: 'plot', id: 'ma', title: '${title}', kind: 'line', color: '#6E9BD6' }],
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
  private acked = 0;
  /** Ack every message not acknowledged yet. */
  ackAll() {
    for (const p of this.posted)
      if (p.data.seq > this.acked) this.emit({ type: 'ack', seq: (this.acked = p.data.seq) });
  }
  /** Ack the oldest message not acknowledged yet (a slow sandbox, one at a time). */
  ackNext() {
    const next = this.posted.find((p) => p.data.seq > this.acked);
    if (next) this.emit({ type: 'ack', seq: (this.acked = next.data.seq) });
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

  it('a stopped instance of a deleted or broken script takes no slot (as in the controller)', () => {
    const { port, sandboxes, out, scripts } = setup({
      scripts: { s1: script(), s2: script(smaSource(), 's2'), s3: script(smaSource(), 's3') },
    });
    addUser(port, 'gone', {}, 's2');
    addUser(port, 'broken', {}, 's3');
    scripts.delete('s2');
    port.reloadScript('s2');
    scripts.set('s3', { ...scripts.get('s3')!, manifest: null });
    port.reloadScript('s3');
    for (let i = 0; i < MAX_SCRIPT_INSTANCES_PER_CHART; i++) addUser(port, `u${i}`);
    expect(errors(out)).toEqual([]);
    expect(sandboxes.filter((s) => !s.terminated)).toHaveLength(MAX_SCRIPT_INSTANCES_PER_CHART);
    addUser(port, 'over');
    expect(errors(out)).toEqual([
      { type: 'error', id: 'over', message: SCRIPT_INSTANCE_CAP_MESSAGE },
    ]);
  });

  it('keeps the cap when a broken script is fixed while others took the slots', () => {
    const { port, sandboxes, out, scripts } = setup({
      scripts: { a: script(smaSource(), 'a'), b: script(smaSource(), 'b') },
    });
    for (let i = 0; i < 7; i++) addUser(port, `b${i}`, {}, 'b');
    const fixed = scripts.get('b')!;
    scripts.set('b', { ...fixed, manifest: null });
    port.reloadScript('b');
    for (let i = 0; i < MAX_SCRIPT_INSTANCES_PER_CHART; i++) addUser(port, `a${i}`, {}, 'a');
    expect(errors(out)).toEqual([]);
    scripts.set('b', fixed);
    port.reloadScript('b');
    expect(sandboxes.filter((s) => !s.terminated)).toHaveLength(MAX_SCRIPT_INSTANCES_PER_CHART);
    expect(errors(out)).toEqual(
      Array.from({ length: 7 }, (_, i) => ({
        type: 'error',
        id: `b${i}`,
        message: SCRIPT_INSTANCE_CAP_MESSAGE,
      })),
    );
    // Room again: new inputs restart one.
    port.post({ type: 'remove', id: 'a0' });
    port.post({ type: 'setInputs', id: 'b0', inputs: { length: 4 } });
    expect(sandboxes.filter((s) => !s.terminated)).toHaveLength(MAX_SCRIPT_INSTANCES_PER_CHART);
    expect(sandboxes.at(-1)!.msgs()[0]).toMatchObject({ type: 'load' });
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
    sendBars(port, 1, 2);
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

  it('drops results not bounded by the mirror and the definition', () => {
    const { port, sandboxes, out } = setup();
    sendBars(port, 3, 4);
    addUser(port, 'u1');
    const sb = sandboxes[0]!;
    const results = (patch: Record<string, unknown>, change: Record<string, unknown> = {}) => ({
      type: 'results',
      revision: 3,
      length: 4,
      changes: [
        {
          id: 'u1',
          from: 2,
          status: { state: 'ok' },
          values: { ma: new Float64Array(2) },
          colors: {},
          ...change,
        },
      ],
      ...patch,
    });
    const bad = [
      results({ length: 1e9 }, { from: 1e9 - 2 }),
      results({ length: 2 ** 31 }),
      results({ length: 5 }, { values: { ma: new Float64Array(3) } }),
      results({ revision: 2 }),
      results({ revision: 4 }),
      results({ revision: '3' }),
      results({}, { values: { ma: new Float64Array(4) } }),
      results({}, { values: { ma: new Float64Array(1) } }),
      results({}, { values: { other: new Float64Array(2) } }),
      results({}, { values: { ma: new Float64Array(2), __proto__x: new Float64Array(2) } }),
      results({}, { colors: { ma: new Uint8Array(3) } }),
      results({}, { colors: { nope: new Uint8Array(2) } }),
    ];
    for (const m of bad) sb.emit(m);
    expect(out).toEqual([]);
    expect(sb.terminated).toBe(false);
    // Shorter than the mirror (the sandbox lags a tick behind) is fine.
    sb.emit(results({ length: 3 }, { values: { ma: new Float64Array(1) } }));
    sb.emit(results({}, { colors: { ma: new Uint8Array(2) } }));
    expect(out.map((m) => m.type)).toEqual(['results', 'results']);
  });

  it('stops a sandbox whose ack names no outstanding message', () => {
    for (const seq of [1e300, 0, -1, 1.5, NaN, '2', undefined, 99]) {
      const { port, sandboxes, out } = setup();
      addUser(port, 'u1'); // load = 1, add = 2
      sandboxes[0]!.emit({ type: 'ack', seq });
      expect(sandboxes[0]!.terminated, String(seq)).toBe(true);
      expect(out).toEqual([{ type: 'error', id: 'u1', message: PROTOCOL_MESSAGE }]);
      expect(vi.getTimerCount()).toBe(0);
    }
    // Acked twice, or acked while idle.
    const { port, sandboxes, out } = setup();
    addUser(port, 'u1');
    const sb = sandboxes[0]!;
    sb.emit({ type: 'ack', seq: 2 });
    expect(sb.terminated).toBe(false);
    sb.emit({ type: 'ack', seq: 2 });
    expect(sb.terminated).toBe(true);
    expect(out).toEqual([{ type: 'error', id: 'u1', message: PROTOCOL_MESSAGE }]);
  });

  it(`stops a sandbox posting more than ${POSTS_SLACK} + ${POSTS_PER_PENDING} per outstanding message between acks`, () => {
    const { port, sandboxes, out } = setup();
    addUser(port, 'u1');
    const sb = sandboxes[0]!;
    // Two outstanding (load, add): 4 + 2·4 = 12 messages allowed.
    for (let i = 0; i < POSTS_SLACK + 2 * POSTS_PER_PENDING; i++)
      sb.emit({ type: 'error', message: `e${i}` });
    expect(sb.terminated).toBe(false);
    sb.ackAll();
    // Idle: the slack only.
    for (let i = 0; i < POSTS_SLACK; i++) sb.emit({ type: 'error', message: 'idle' });
    expect(sb.terminated).toBe(false);
    sb.emit({ type: 'error', message: 'one too many' });
    expect(sb.terminated).toBe(true);
    expect(errors(out)).toHaveLength(POSTS_SLACK * 3 + 2 * POSTS_PER_PENDING - POSTS_SLACK + 1);
    expect(errors(out).at(-1)).toEqual({ type: 'error', id: 'u1', message: FLOOD_MESSAGE });
    expect(errors(out).some((e) => e.message === 'one too many')).toBe(false);
  });

  it('a live sandbox stays under the rate cap through a burst of input changes', () => {
    const { port, sandboxes, out } = setup({ live: true });
    sendBars(port, 1, 50, CONTEXT);
    addUser(port, 'u1');
    for (let i = 1; i <= 40; i++) port.post({ type: 'setInputs', id: 'u1', inputs: { length: i } });
    sandboxes[0]!.flush();
    expect(errors(out)).toEqual([]);
    expect(sandboxes[0]!.terminated).toBe(false);
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
      // A sandbox that reports `bars: i` has handled (and acked) the i-th bars.
      sb.ackAll();
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
    sb.ackAll();
    sendBars(port, 2, 4);
    sb.ackAll();
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

  it('pings an idle sandbox every 10 s and kills it 2 s after an unanswered ping', () => {
    const { port, sandboxes, out } = setup();
    addUser(port, 'u1');
    const sb = sandboxes[0]!;
    sb.ackAll();
    vi.advanceTimersByTime(10_000);
    expect(sb.types().at(-1)).toBe('ping');
    vi.advanceTimersByTime(PING_DEADLINE_MS - 1);
    sb.ackAll();
    vi.advanceTimersByTime(10_000);
    expect(sb.types().filter((t) => t === 'ping')).toHaveLength(2);
    expect(PING_DEADLINE_MS).toBe(2_000);
    vi.advanceTimersByTime(PING_DEADLINE_MS - 1);
    expect(sb.terminated).toBe(false);
    vi.advanceTimersByTime(1);
    expect(sb.terminated).toBe(true);
    expect(out).toEqual([{ type: 'error', id: 'u1', message: stoppedMessage(2_000) }]);
    expect(stoppedMessage(2_000)).toBe('Stopped: no response for 2 s (endless loop?)');
  });

  it('a message queued behind a ping still gets its own limit', () => {
    const { port, sandboxes, out } = setup();
    sendBars(port, 1, 3);
    addUser(port, 'u1');
    const sb = sandboxes[0]!;
    sb.ackAll();
    vi.advanceTimersByTime(10_000);
    port.post({ type: 'bar', revision: 1, index: 3, bar: barAt(bars(4), 3) });
    expect(sb.types().slice(-2)).toEqual(['ping', 'bar']);
    vi.advanceTimersByTime(100);
    sb.emit({ type: 'ack', seq: sb.posted.at(-2)!.data.seq });
    vi.advanceTimersByTime(4_999);
    expect(sb.terminated).toBe(false);
    vi.advanceTimersByTime(1);
    expect(out).toEqual([{ type: 'error', id: 'u1', message: stoppedMessage(5_000) }]);
  });

  it(`stops a sandbox with more than ${MAX_PENDING_MESSAGES} messages outstanding`, () => {
    const { port, sandboxes, out } = setup();
    sendBars(port, 1, 1);
    addUser(port, 'u1'); // load, bars, add
    const sb = sandboxes[0]!;
    const tick = () => port.post({ type: 'bar', revision: 1, index: 0, bar: barAt(bars(1), 0) });
    for (let i = 3; i < MAX_PENDING_MESSAGES; i++) tick();
    expect(sb.posted).toHaveLength(MAX_PENDING_MESSAGES);
    expect(sb.terminated).toBe(false);
    tick();
    expect(sb.terminated).toBe(true);
    expect(sb.posted).toHaveLength(MAX_PENDING_MESSAGES);
    expect(out).toEqual([{ type: 'error', id: 'u1', message: BACKLOG_MESSAGE }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it(`stops a sandbox whose oldest message waits over ${MAX_MESSAGE_AGE_MS / 1000} s`, () => {
    const { port, sandboxes, out } = setup();
    sendBars(port, 1, 1);
    addUser(port, 'u1');
    const sb = sandboxes[0]!;
    sb.ackAll();
    // A tick every second; the sandbox acks one message every 4 s: never
    // late for one message, ever further behind.
    let acked = sb.posted.at(-1)!.data.seq;
    const postedAt = new Map<number, number>();
    for (let t = 1; t <= 60 && !sb.terminated; t++) {
      port.post({ type: 'bar', revision: 1, index: 0, bar: barAt(bars(1), 0) });
      postedAt.set(sb.posted.at(-1)!.data.seq, Date.now());
      vi.advanceTimersByTime(1_000);
      if (t % 4 === 0 && !sb.terminated) sb.emit({ type: 'ack', seq: ++acked });
    }
    expect(sb.terminated).toBe(true);
    expect(out).toEqual([{ type: 'error', id: 'u1', message: BACKLOG_MESSAGE }]);
    // Stopped right when the oldest unacknowledged tick turned 30 s old.
    expect(Date.now() - postedAt.get(acked + 1)!).toBeLessThanOrEqual(MAX_MESSAGE_AGE_MS + 1_000);
    expect(Date.now() - postedAt.get(acked + 1)!).toBeGreaterThanOrEqual(MAX_MESSAGE_AGE_MS);
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

describe('ScriptRouterPort coalescing', () => {
  it('a long burst of setInputs to a slow sandbox is coalesced and ends with the latest inputs', () => {
    const { port, sandboxes, out } = setup();
    sendBars(port, 1, 50);
    addUser(port, 'u1');
    const sb = sandboxes[0]!;
    sb.ackAll();
    // A spinner held for 40 s: a change every 50 ms; the sandbox needs 300 ms each.
    // Without coalescing the backlog passes the 30 s age limit.
    for (let k = 1; k <= 800; k++) {
      port.post({ type: 'setInputs', id: 'u1', inputs: { length: k } });
      vi.advanceTimersByTime(50);
      if (k % 6 === 0) sb.ackNext();
    }
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(300);
      sb.ackNext();
    }
    expect(sb.terminated).toBe(false);
    expect(errors(out)).toEqual([]);
    const sent = sb.msgs().filter((m) => m.type === 'setInputs');
    expect(sent.length).toBeLessThanOrEqual(800 / 6 + 2);
    expect(sent.at(-1)).toEqual({ type: 'setInputs', id: 'u1', inputs: { length: 800 } });
  });

  it('a newer bars reset supersedes a queued one; the latest goes out on the ack', () => {
    const { port, sandboxes } = setup();
    addUser(port, 'u1');
    const sb = sandboxes[0]!;
    sb.ackAll();
    sendBars(port, 1, 3);
    sendBars(port, 2, 4, CONTEXT);
    sendBars(port, 3, 5);
    port.post({ type: 'bar', revision: 3, index: 5, bar: barAt(bars(6), 5) });
    expect(sb.types().filter((t) => t === 'bars')).toHaveLength(1);
    sb.ackAll();
    const resent = sb.msgs().filter((m) => m.type === 'bars');
    expect(resent).toHaveLength(2);
    const last = resent[1] as Extract<SandboxMessage, { type: 'bars' }>;
    expect(last.revision).toBe(3);
    expect(last.bars.close.length).toBe(6); // includes the live bar
    expect(last.context).toEqual(CONTEXT); // a coalesced reset carried one
    // A clear drops a queued reset: nothing to send after it.
    sendBars(port, 4, 2);
    port.post({ type: 'clear' });
    sb.ackAll();
    expect(sb.msgs().filter((m) => m.type === 'bars')).toHaveLength(3);
    expect(sb.types().at(-1)).toBe('clear');
  });

  it('a live sandbox computes the latest inputs after a burst', () => {
    const { port, sandboxes, out } = setup({ live: true });
    sendBars(port, 1, 6, CONTEXT);
    addUser(port, 'u1');
    const sb = sandboxes[0]!;
    for (let k = 1; k <= 30; k++) port.post({ type: 'setInputs', id: 'u1', inputs: { length: k } });
    for (let i = 0; i < 5; i++) sb.flush();
    expect(errors(out)).toEqual([]);
    const last = out.filter((m) => m.type === 'results').at(-1) as Extract<
      FromWorker,
      { type: 'results' }
    >;
    // length 30 > 6 bars: all NaN
    expect([...last.changes[0]!.values.ma!].every(Number.isNaN)).toBe(true);
    expect(sb.msgs().filter((m) => m.type === 'setInputs').length).toBeLessThanOrEqual(3);
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

describe('createSandboxWorker', () => {
  it('caps the worker failure message', () => {
    class StubWorker {
      onerror: ((e: { message: string; preventDefault(): void }) => void) | null = null;
      postMessage() {}
      terminate() {}
    }
    const made: StubWorker[] = [];
    vi.stubGlobal(
      'Worker',
      class extends StubWorker {
        constructor() {
          super();
          made.push(this);
        }
      },
    );
    try {
      const failures: string[] = [];
      createSandboxWorker().listen(
        () => {},
        (m) => failures.push(m),
      );
      made[0]!.onerror?.({ message: 'x'.repeat(100_000), preventDefault() {} });
      made[0]!.onerror?.({ message: '', preventDefault() {} });
      expect(failures[0]).toBe(`Sandbox worker failed: ${'x'.repeat(500)}`);
      expect(failures[1]).toBe('Sandbox worker failed: unknown error');
    } finally {
      vi.unstubAllGlobals();
    }
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
