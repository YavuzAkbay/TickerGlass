import {
  IndicatorRegistry,
  IndicatorRuntime,
  USER_SCRIPT_API_VERSION,
  compileUserScript,
  type AnyIndicatorDefinition,
  type BarInput,
  type IndicatorResult,
  type InputValueMap,
  type RuntimeContext,
} from '@investopen/indicators/core';
import type { BarColumns } from '@investopen/engine';
import { WorkerCore } from '../workerCore';
import type {
  CheckMismatch,
  FromSandbox,
  ProbeResult,
  SandboxMessage,
  ToSandbox,
} from './protocol';

export type SandboxPost = (msg: FromSandbox, transfer: Transferable[]) => void;

/** Live bars a `check` feeds as ticks when the request names no valid count. */
export const DEFAULT_CHECK_LIVE_BARS = 50;

const WORKER_TYPES = new Set<string>([
  'context',
  'add',
  'setInputs',
  'remove',
  'bars',
  'bar',
  'clear',
] satisfies SandboxMessage['type'][]);

const SCRIPT_PARAMS = ['defineIndicator', 'NO_COLOR', 'PRICE_SOURCES', 'calendarPeriod'] as const;
const STACK_POSITION = /user-script\.js:(\d+):(\d+)/;
/** Location suffix `annotateError` appends. */
const LOCATION_SUFFIX = / \(line (\d+):(\d+)\)$/;
const CHECK_ID = 'check';

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * The sandbox worker's message handler (docs/indicators.md §5a),
 * independent of the Worker global so tests can run it in-process. Compiles
 * one user script into a private registry (no built-ins) and delegates the
 * indicator messages to a WorkerCore over it. Every message is acknowledged
 * with `{type:'ack', seq}` after everything it caused has been posted.
 */
export class SandboxCore {
  private readonly registry = new IndicatorRegistry();
  private readonly worker: WorkerCore;
  private definition: AnyIndicatorDefinition | null = null;
  /** Why the script could not be loaded: reported against every added instance. */
  private loadError: string | null = null;

  constructor(
    private readonly post: SandboxPost,
    /** `probeLineOffset()` of this engine (undefined = no line numbers). */
    private readonly lineOffset: number | undefined,
  ) {
    this.worker = new WorkerCore(post, this.registry);
  }

  /** Never throws: failures are posted as `error` / `compileError` messages. */
  handle(data: unknown): void {
    const { seq, msg } = (data ?? {}) as Partial<ToSandbox>;
    if (typeof seq !== 'number') {
      this.post({ type: 'error', message: 'Sandbox: message without seq' }, []);
      return;
    }
    if (msg?.type === 'probe') {
      // Async (awaits what the code returns): ack once it settled.
      void this.probe(msg.code).then((result) => {
        this.post({ type: 'probeResult', seq, ...result }, []);
        this.post({ type: 'ack', seq }, []);
      });
      return;
    }
    try {
      this.dispatch(msg);
    } catch (err) {
      this.post({ type: 'error', message: `Sandbox: ${message(err)}` }, []);
    }
    this.post({ type: 'ack', seq }, []);
  }

  private dispatch(msg: SandboxMessage | undefined): void {
    switch (msg?.type) {
      case 'ping':
        return;
      case 'load':
        this.load(msg.source, msg.apiVersion, msg.scriptId);
        return;
      case 'check':
        this.check(msg.bars, msg.context, msg.inputs, msg.liveBars);
        return;
      case 'add':
        if (this.loadError !== null) {
          this.post({ type: 'error', id: msg.spec.id, message: this.loadError }, []);
          return;
        }
        this.worker.handle(msg);
        return;
      default:
        if (msg && WORKER_TYPES.has(msg.type)) {
          this.worker.handle(msg as Extract<SandboxMessage, { type: 'context' }>);
          return;
        }
        this.post({ type: 'error', message: 'Sandbox: unknown message' }, []);
    }
  }

  private load(source: unknown, apiVersion: unknown, scriptId: unknown): void {
    if (this.definition || this.loadError !== null) {
      this.post({ type: 'error', message: 'Sandbox: a script is already loaded' }, []);
      return;
    }
    if (apiVersion !== USER_SCRIPT_API_VERSION) {
      this.compileError(new Error(`Unsupported script API version ${String(apiVersion)}`));
      return;
    }
    if (typeof source !== 'string' || typeof scriptId !== 'string') {
      this.compileError(new Error('Sandbox: invalid load message'));
      return;
    }
    let compiled;
    try {
      compiled = compileUserScript(source, { scriptId, lineOffset: this.lineOffset });
      this.registry.register(compiled.definition);
    } catch (err) {
      this.compileError(err);
      return;
    }
    this.definition = compiled.definition;
    this.post({ type: 'loaded', manifest: compiled.manifest }, []);
  }

  private compileError(err: unknown): void {
    const text = message(err);
    this.loadError = text;
    const m = LOCATION_SUFFIX.exec(text);
    if (!m) {
      this.post({ type: 'compileError', message: text }, []);
      return;
    }
    this.post(
      {
        type: 'compileError',
        message: text.slice(0, m.index),
        line: Number(m[1]),
        col: Number(m[2]),
      },
      [],
    );
  }

  /**
   * §4: full compute on all bars vs compute on n−K bars, then the last K bars
   * via `updateBar` (each appended as a perturbed tick, then set to its final
   * value). First differing output value (by bar index) is the mismatch.
   */
  private check(
    bars: BarColumns,
    context: RuntimeContext,
    inputs: InputValueMap,
    liveBars: number,
  ): void {
    const def = this.definition;
    if (!def) {
      this.post({ type: 'error', message: 'Check: no script loaded' }, []);
      return;
    }
    const n = bars.time.length;
    const k = Math.min(
      n,
      Number.isInteger(liveBars) && liveBars > 0 ? liveBars : DEFAULT_CHECK_LIVE_BARS,
    );
    const runtime = () => {
      const rt = new IndicatorRuntime({ registry: this.registry, context });
      rt.add({ id: CHECK_ID, type: def.id, inputs });
      return rt;
    };

    const full = runtime();
    full.setBars(bars);
    const live = runtime();
    live.setBars(sliceColumns(bars, n - k));
    for (let i = n - k; i < n; i++) {
      const bar = barAt(bars, i);
      live.updateBar(i, firstTick(bar));
      live.updateBar(i, bar);
    }

    const a = full.result(CHECK_ID);
    const b = live.result(CHECK_ID);
    if (!a || !b) throw new Error('check instance missing');
    for (const [r, what] of [
      [a, 'full'],
      [b, 'live'],
    ] as const) {
      if (r.status.state === 'error') {
        this.post({ type: 'error', message: `Check (${what}): ${r.status.message}` }, []);
        return;
      }
    }
    const mismatch = firstMismatch(a, b, n);
    this.post(
      mismatch ? { type: 'checkResult', ok: false, mismatch } : { type: 'checkResult', ok: true },
      [],
    );
  }

  /** Runs `code` as a script body (no `defineIndicator`); dev/e2e probe. */
  private async probe(code: unknown): Promise<ProbeResult> {
    try {
      if (typeof code !== 'string') throw new TypeError('probe code must be a string');
      const fn = new Function(
        ...SCRIPT_PARAMS,
        `"use strict";\n${code}\n//# sourceURL=user-script.js`,
      ) as (...args: unknown[]) => unknown;
      const value = await fn(undefined, undefined, undefined, undefined);
      return { ok: true, value: describe(value) };
    } catch (err) {
      const pos = stackPosition(err);
      const at =
        pos && this.lineOffset !== undefined
          ? { line: pos.line - this.lineOffset, col: pos.col }
          : {};
      return { ok: false, error: describe(err), ...at };
    }
  }
}

/** |a−b| <= 1e-9·max(1,|b|); NaN equals NaN. */
export function sameValue(a: number, b: number): boolean {
  if (a === b) return true;
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.isNaN(a) && Number.isNaN(b);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false; // unequal infinities
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));
}

/** Earliest bar index at which any output (value or palette index) of `live` differs from `full`. */
function firstMismatch(
  full: IndicatorResult,
  live: IndicatorResult,
  n: number,
): CheckMismatch | null {
  const columns: [string, ArrayLike<number>, ArrayLike<number> | undefined][] = [
    ...Object.entries(full.values).map(
      ([id, arr]) =>
        [id, arr, live.values[id]] as [string, ArrayLike<number>, ArrayLike<number> | undefined],
    ),
    ...Object.entries(full.colors).map(
      ([id, arr]) =>
        [id, arr, live.colors[id]] as [string, ArrayLike<number>, ArrayLike<number> | undefined],
    ),
  ];
  const at = (arr: ArrayLike<number> | undefined, i: number) =>
    arr && i < arr.length ? arr[i]! : NaN;
  for (let i = 0; i < n; i++) {
    for (const [outputId, f, l] of columns) {
      const x = at(f, i);
      const y = at(l, i);
      if (!sameValue(y, x)) return { outputId, index: i, full: x, live: y };
    }
  }
  return null;
}

function barAt(cols: BarColumns, i: number): BarInput {
  return {
    time: cols.time[i]!,
    open: cols.open[i]!,
    high: cols.high[i]!,
    low: cols.low[i]!,
    close: cols.close[i]!,
    volume: cols.volume[i]!,
  };
}

/** The opening tick of a live bar: every price at the open, a tenth of the volume. */
function firstTick(bar: BarInput): BarInput {
  const o = bar.open;
  return { ...bar, high: o, low: o, close: o, volume: bar.volume * 0.1 };
}

function sliceColumns(cols: BarColumns, to: number): BarColumns {
  return {
    time: cols.time.subarray(0, to),
    open: cols.open.subarray(0, to),
    high: cols.high.subarray(0, to),
    low: cols.low.subarray(0, to),
    close: cols.close.subarray(0, to),
    volume: cols.volume.subarray(0, to),
  };
}

/** Engine line/column of the user-script frame in `err`'s stack, if any. */
function stackPosition(err: unknown): { line: number; col: number } | null {
  try {
    const stack = (err as { stack?: unknown } | null)?.stack;
    const m = typeof stack === 'string' ? STACK_POSITION.exec(stack) : null;
    return m ? { line: Number(m[1]), col: Number(m[2]) } : null;
  } catch {
    return null; // a user object with a throwing `stack` getter
  }
}

function describe(value: unknown): string {
  try {
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    return String(value);
  } catch {
    return 'Unprintable value';
  }
}
