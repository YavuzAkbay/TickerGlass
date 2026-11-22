import {
  DEFAULT_CHECK_LIVE_BARS,
  IndicatorRegistry,
  USER_SCRIPT_API_VERSION,
  checkScript,
  compileUserScript,
  sameValue,
  type AnyIndicatorDefinition,
  type InputValueMap,
  type RuntimeContext,
} from '@tickerglass/indicators/core';
import type { BarColumns } from '@tickerglass/engine';
import { WorkerCore } from '../workerCore';
import type { FromSandbox, ProbeResult, SandboxMessage, ToSandbox } from './protocol';

export type SandboxPost = (msg: FromSandbox, transfer: Transferable[]) => void;

// The check itself lives in @tickerglass/indicators (shared with the alerts service).
export { DEFAULT_CHECK_LIVE_BARS, sameValue };

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

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * The sandbox worker's message handler (docs/indicators.md §5a),
 * independent of the Worker global so tests can run it in-process. Compiles
 * one user script into a private registry (no built-ins) and delegates the
 * indicator messages to a WorkerCore over it. Every message is acknowledged
 * with `{type:'ack', seq}` after everything it caused has been posted.
 */
export interface SandboxCoreOptions {
  /**
   * Accept `probe` messages (dev and e2e builds only: `window.sandboxProbe`).
   * Off by default; a production sandbox answers a probe as an unknown message.
   */
  probes?: boolean;
}

export class SandboxCore {
  private readonly registry = new IndicatorRegistry();
  private readonly worker: WorkerCore;
  private readonly probes: boolean;
  private definition: AnyIndicatorDefinition | null = null;
  /** Why the script could not be loaded: reported against every added instance. */
  private loadError: string | null = null;
  /**
   * A probe is running: acks of later messages wait here, so acks always go
   * out in seq order (the router rejects anything else).
   */
  private heldAcks: number[] | null = null;

  constructor(
    private readonly post: SandboxPost,
    /** `probeLineOffset()` of this engine (undefined = no line numbers). */
    private readonly lineOffset: number | undefined,
    options: SandboxCoreOptions = {},
  ) {
    this.worker = new WorkerCore(post, this.registry);
    this.probes = options.probes === true;
  }

  /**
   * Never throws: failures are posted as `error` / `compileError` messages.
   * Reads `data` once, before any user code runs for it.
   */
  handle(data: unknown): void {
    const { seq, msg } = (data ?? {}) as Partial<ToSandbox>;
    if (typeof seq !== 'number') {
      this.post({ type: 'error', message: 'Sandbox: message without seq' }, []);
      return;
    }
    if (msg?.type === 'probe' && this.probes && !this.heldAcks) {
      void this.runProbe(seq, msg.code);
      return;
    }
    try {
      this.dispatch(msg);
    } catch (err) {
      this.post({ type: 'error', message: `Sandbox: ${message(err)}` }, []);
    }
    this.ack(seq);
  }

  private ack(seq: number): void {
    if (this.heldAcks) this.heldAcks.push(seq);
    else this.post({ type: 'ack', seq }, []);
  }

  /**
   * Async (awaits what the code returns): posts the result, then the ack, then
   * the acks held meanwhile. Uses `await`, never a promise's `then`: user code
   * may have replaced `Promise.prototype.then` and must not get a callback
   * that posts. The result is rebuilt field by field.
   */
  private async runProbe(seq: number, code: unknown): Promise<void> {
    const held: number[] = [];
    this.heldAcks = held;
    const r = await this.probe(code);
    const result: Extract<FromSandbox, { type: 'probeResult' }> = {
      type: 'probeResult',
      seq,
      ok: r.ok === true,
    };
    if (typeof r.value === 'string') result.value = r.value;
    if (typeof r.error === 'string') result.error = r.error;
    if (typeof r.line === 'number') result.line = r.line;
    if (typeof r.col === 'number') result.col = r.col;
    this.post(result, []);
    this.post({ type: 'ack', seq }, []);
    this.heldAcks = null;
    for (let i = 0; i < held.length; i++) this.post({ type: 'ack', seq: held[i]! }, []);
  }

  private dispatch(msg: SandboxMessage | undefined): void {
    switch (msg?.type) {
      case 'ping':
        return;
      case 'probe':
        // Only reached when probes are off, or while another probe runs.
        this.post(
          {
            type: 'error',
            message: this.probes
              ? 'Sandbox: a probe is already running'
              : 'Sandbox: unknown message',
          },
          [],
        );
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
    const outcome = checkScript({
      registry: this.registry,
      type: def.id,
      bars,
      context,
      inputs,
      liveBars,
    });
    if ('error' in outcome) this.post({ type: 'error', message: outcome.error }, []);
    else
      this.post(
        outcome.ok
          ? { type: 'checkResult', ok: true }
          : { type: 'checkResult', ok: false, mismatch: outcome.mismatch },
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
