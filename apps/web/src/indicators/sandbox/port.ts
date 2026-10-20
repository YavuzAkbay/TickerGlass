// The controller's worker port with user scripts routed to sandboxes
// (docs/indicators.md §5a). Built-in instances go to the
// indicator worker unchanged; every `user:` instance gets its own sandbox
// worker, fed from a main-thread copy of the bars (SeriesMirror). Nothing a
// sandbox sends is trusted: only its own instance's results (typed arrays),
// errors (re-labelled with its id) and a manifest equal to the saved one.
import {
  coerceInputs,
  definitionFromManifest,
  parseManifest,
  scriptIdOf,
  USER_SCRIPT_API_VERSION,
  type AnyIndicatorDefinition,
  type InputValueMap,
  type InstanceStatus,
  type RuntimeContext,
} from '@investopen/indicators';
import type { WorkerPort } from '../controller';
import type { FromWorker, ResultChange, ToWorker } from '../protocol';
import { MAX_SCRIPT_INSTANCES_PER_CHART, SCRIPT_INSTANCE_CAP_MESSAGE } from './limits';
import { SeriesMirror } from './mirror';
import type { FromSandbox, SandboxMessage, ToSandbox } from './protocol';

/** Message port to one sandbox worker (a real Worker in the app, fake in tests). */
export interface SandboxPort {
  post(msg: ToSandbox, transfer?: Transferable[]): void;
  /**
   * `onMessage`: everything the sandbox posts (untrusted). `onFailure`: the
   * worker itself failed (load error, uncaught error, unreadable message).
   */
  listen(onMessage: (msg: FromSandbox) => void, onFailure: (message: string) => void): void;
  terminate(): void;
}

export function createSandboxWorker(): SandboxPort {
  const w = new Worker(new URL('./sandbox-worker.ts', import.meta.url), {
    type: 'module',
    name: 'sandbox',
  });
  return {
    post: (msg, transfer = []) => w.postMessage(msg, transfer),
    listen: (onMessage, onFailure) => {
      w.onmessage = (e: MessageEvent<FromSandbox>) => onMessage(e.data);
      w.onerror = (e) => {
        // Handled here: not an uncaught error of the page.
        e.preventDefault();
        onFailure(`Sandbox worker failed: ${e.message}`);
      };
      w.onmessageerror = () => onFailure('Sandbox worker: unreadable message');
    },
    terminate: () => w.terminate(),
  };
}

/** What the router needs to know about a saved script. */
export interface ScriptSource {
  source: string;
  /** null: the last save did not compile (nothing to run). */
  manifest: Record<string, unknown> | null;
}

export interface ScriptRouterDeps {
  /** The saved script, undefined if there is none (deleted / not loaded). */
  getScript(scriptId: string): ScriptSource | undefined;
  /** Default: a real sandbox worker. */
  spawn?: () => SandboxPort;
}

/** Watchdog limits (ms): a message must be acknowledged within these. */
export const SLOW_MESSAGE_MS = 10_000;
export const MESSAGE_MS = 5_000;
/** A sandbox with nothing outstanding is pinged this often. */
export const PING_MS = 10_000;
/** Resends of the bars to one sandbox per series revision. */
export const MAX_SANDBOX_RESYNCS = 3;

export const SCRIPT_CHANGED_MESSAGE =
  'Script changed since it was saved – open the editor and save again';
export const OUT_OF_SYNC_MESSAGE = 'Indicator data keeps falling out of sync with the chart';

const SLOW_TYPES = new Set<SandboxMessage['type']>(['load', 'bars', 'check']);
const MAX_MESSAGE = 500;

export const stoppedMessage = (ms: number) =>
  `Stopped: no response for ${ms / 1000} s (endless loop?)`;

/** One `user:` instance and the sandbox running it (if any). */
interface Instance {
  id: string;
  type: string;
  scriptId: string;
  /** As the controller last sent them (coerced per definition when posted). */
  inputs: InputValueMap;
  sandbox: Sandbox | null;
}

interface Pending {
  seq: number;
  limit: number;
}

/** A spawned sandbox worker with its watchdog. */
interface Sandbox {
  port: SandboxPort;
  /** Source + manifest it was loaded with. */
  sig: string;
  /** Stub definition of the saved manifest (input coercion). */
  def: AnyIndicatorDefinition;
  /** Canonical JSON of the saved manifest. */
  manifestKey: string;
  seq: number;
  /** Posted, not yet acknowledged; oldest first. */
  pending: Pending[];
  /** When the oldest pending message started waiting (its post, or the previous ack). */
  since: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** `bars` messages posted (the sandbox echoes its count in resync). */
  barsSent: number;
  resyncRevision: number;
  resyncs: number;
}

const sigOf = (s: ScriptSource) => JSON.stringify([s.source, s.manifest]);

/** JSON with object keys sorted, so equal manifests compare equal whatever their key order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return v;
    const rec = v as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(rec)
        .sort()
        .map((k) => [k, rec[k]]),
    );
  });
}

const textOf = (v: unknown, fallback: string) =>
  typeof v === 'string' && v ? v.slice(0, MAX_MESSAGE) : fallback;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * `WorkerPort` that runs `user:` instances in sandboxes (one each) and
 * everything else in `inner`. The controller cannot tell the difference.
 */
export class ScriptRouterPort implements WorkerPort {
  private readonly instances = new Map<string, Instance>();
  private readonly mirror = new SeriesMirror();
  private context: RuntimeContext | null = null;
  private listener: ((msg: FromWorker) => void) | null = null;
  private readonly spawnPort: () => SandboxPort;
  private terminated = false;

  constructor(
    private readonly inner: WorkerPort,
    private readonly deps: ScriptRouterDeps,
  ) {
    this.spawnPort = deps.spawn ?? createSandboxWorker;
  }

  listen(fn: (msg: FromWorker) => void): void {
    this.listener = fn;
    this.inner.listen(fn);
  }

  post(msg: ToWorker, transfer: Transferable[] = []): void {
    if (this.terminated) return;
    switch (msg.type) {
      case 'add': {
        const scriptId = scriptIdOf(msg.spec.type);
        if (scriptId !== undefined) this.add(msg.spec, scriptId);
        else this.inner.post(msg, transfer);
        return;
      }
      case 'setInputs': {
        const inst = this.instances.get(msg.id);
        if (inst) this.setInputs(inst, msg.inputs);
        else this.inner.post(msg, transfer);
        return;
      }
      case 'remove': {
        const inst = this.instances.get(msg.id);
        if (!inst) {
          this.inner.post(msg, transfer);
          return;
        }
        this.stop(inst);
        this.instances.delete(msg.id);
        return;
      }
      case 'bars':
        // Copy first: the buffers are detached once transferred.
        this.mirror.reset(msg.revision, msg.bars);
        if (msg.context) this.context = msg.context;
        this.inner.post(msg, transfer);
        for (const inst of this.instances.values())
          if (inst.sandbox) this.sendBars(inst.sandbox, msg.context);
        return;
      case 'bar':
        this.mirror.apply(msg.revision, msg.index, msg.bar);
        this.inner.post(msg, transfer);
        this.broadcast(msg);
        return;
      case 'context':
        this.context = msg.context;
        this.inner.post(msg, transfer);
        this.broadcast(msg);
        return;
      case 'clear':
        this.mirror.clear();
        this.inner.post(msg, transfer);
        this.broadcast(msg);
        return;
      default:
        // timeframeMap, tfBars, tfBar, extBars, extUpdate: scripts read chart bars only.
        this.inner.post(msg, transfer);
    }
  }

  /**
   * The saved script changed (or appeared, or went away): restart its
   * instances with the new source, or stop them if it cannot run now. Runs
   * after the controller has applied the new definition (`ctl.sync`).
   */
  reloadScript(scriptId: string): void {
    if (this.terminated) return;
    for (const inst of this.instances.values()) {
      if (inst.scriptId !== scriptId) continue;
      const script = this.deps.getScript(scriptId);
      if (inst.sandbox && script && inst.sandbox.sig === sigOf(script)) continue;
      this.stop(inst);
      this.start(inst);
    }
  }

  terminate(): void {
    this.terminated = true;
    for (const inst of this.instances.values()) this.stop(inst);
    this.instances.clear();
    this.inner.terminate();
  }

  // ------------------------------------------------------------- instances

  private add(spec: Extract<ToWorker, { type: 'add' }>['spec'], scriptId: string): void {
    const old = this.instances.get(spec.id);
    if (old) {
      this.stop(old);
      this.instances.delete(spec.id);
    }
    if (this.instances.size >= MAX_SCRIPT_INSTANCES_PER_CHART) {
      this.emit({ type: 'error', id: spec.id, message: SCRIPT_INSTANCE_CAP_MESSAGE });
      return;
    }
    const inst: Instance = {
      id: spec.id,
      type: spec.type,
      scriptId,
      inputs: spec.inputs ?? {},
      sandbox: null,
    };
    this.instances.set(spec.id, inst);
    this.start(inst);
  }

  private setInputs(inst: Instance, inputs: InputValueMap): void {
    inst.inputs = inputs;
    // Stopped (watchdog, failure): new inputs are a fresh start.
    if (!inst.sandbox) {
      this.start(inst);
      return;
    }
    this.send(inst.sandbox, {
      type: 'setInputs',
      id: inst.id,
      inputs: coerceInputs(inst.sandbox.def, inputs),
    });
  }

  /**
   * Spawn a sandbox for `inst` and replay: load, context, bars, add. Nothing
   * if the script is missing or has no (valid) manifest: the controller shows
   * why (`userScriptProblem`).
   */
  private start(inst: Instance): void {
    const script = this.deps.getScript(inst.scriptId);
    if (!script?.manifest) return;
    let def: AnyIndicatorDefinition;
    let manifestKey: string;
    try {
      const manifest = parseManifest(script.manifest);
      manifestKey = canonicalJson(manifest);
      def = { ...definitionFromManifest(manifest), id: inst.type };
    } catch {
      return; // No stub is registered for it either: the controller reports it.
    }
    let port: SandboxPort;
    try {
      port = this.spawnPort();
    } catch (err) {
      this.emit({
        type: 'error',
        id: inst.id,
        message: `Sandbox worker failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }
    const sb: Sandbox = {
      port,
      sig: sigOf(script),
      def,
      manifestKey,
      seq: 0,
      pending: [],
      since: 0,
      timer: null,
      barsSent: 0,
      resyncRevision: -1,
      resyncs: 0,
    };
    inst.sandbox = sb;
    port.listen(
      (msg) => {
        if (inst.sandbox === sb) this.onSandboxMessage(inst, sb, msg);
      },
      (message) => {
        if (inst.sandbox !== sb) return;
        this.stop(inst);
        this.emit({ type: 'error', id: inst.id, message });
      },
    );
    this.send(sb, {
      type: 'load',
      source: script.source,
      apiVersion: USER_SCRIPT_API_VERSION,
      scriptId: inst.scriptId,
    });
    if (this.context) this.send(sb, { type: 'context', context: this.context });
    if (this.mirror.valid) this.sendBars(sb);
    this.send(sb, {
      type: 'add',
      spec: { id: inst.id, type: inst.type, inputs: coerceInputs(def, inst.inputs) },
    });
    this.arm(sb);
  }

  /** Terminate the instance's sandbox (if any); the instance stays known. */
  private stop(inst: Instance): void {
    const sb = inst.sandbox;
    if (!sb) return;
    inst.sandbox = null;
    if (sb.timer !== null) clearTimeout(sb.timer);
    sb.timer = null;
    sb.port.terminate();
  }

  // --------------------------------------------------------------- sending

  private broadcast(msg: Extract<SandboxMessage, { type: 'bar' | 'context' | 'clear' }>): void {
    for (const inst of this.instances.values()) if (inst.sandbox) this.send(inst.sandbox, msg);
  }

  /** The mirror's bars to one sandbox (a fresh copy each, transferred). */
  private sendBars(sb: Sandbox, context?: RuntimeContext): void {
    if (!this.mirror.valid) return;
    const bars = this.mirror.copyColumns();
    sb.barsSent++;
    this.send(
      sb,
      { type: 'bars', revision: this.mirror.revision, bars, ...(context ? { context } : {}) },
      [
        bars.time.buffer,
        bars.open.buffer,
        bars.high.buffer,
        bars.low.buffer,
        bars.close.buffer,
        bars.volume.buffer,
      ],
    );
  }

  private send(sb: Sandbox, msg: SandboxMessage, transfer: Transferable[] = []): void {
    const seq = ++sb.seq;
    if (!sb.pending.length) sb.since = Date.now();
    sb.pending.push({ seq, limit: SLOW_TYPES.has(msg.type) ? SLOW_MESSAGE_MS : MESSAGE_MS });
    sb.port.post({ seq, msg }, transfer);
    this.arm(sb);
  }

  // -------------------------------------------------------------- watchdog

  /**
   * One timer per sandbox: the oldest unacknowledged message's deadline, or
   * the next idle ping when nothing is outstanding.
   */
  private arm(sb: Sandbox): void {
    if (sb.timer !== null) clearTimeout(sb.timer);
    const oldest = sb.pending[0];
    if (!oldest) {
      sb.timer = setTimeout(() => {
        sb.timer = null;
        this.send(sb, { type: 'ping' });
      }, PING_MS);
      return;
    }
    const wait = Math.max(0, sb.since + oldest.limit - Date.now());
    sb.timer = setTimeout(() => this.onTimeout(sb, oldest), wait);
  }

  private onTimeout(sb: Sandbox, oldest: Pending): void {
    sb.timer = null;
    const inst = [...this.instances.values()].find((i) => i.sandbox === sb);
    if (!inst) return;
    this.stop(inst);
    this.emit({ type: 'error', id: inst.id, message: stoppedMessage(oldest.limit) });
  }

  private onAck(sb: Sandbox, seq: unknown): void {
    if (typeof seq !== 'number') return;
    const before = sb.pending.length;
    sb.pending = sb.pending.filter((p) => p.seq > seq);
    if (sb.pending.length === before) return;
    // The next message's handling starts now.
    sb.since = Date.now();
    this.arm(sb);
  }

  // ------------------------------------------------------------- receiving

  private onSandboxMessage(inst: Instance, sb: Sandbox, msg: FromSandbox): void {
    if (!isObj(msg)) return;
    switch (msg.type) {
      case 'ack':
        this.onAck(sb, msg.seq);
        return;
      case 'results': {
        const results = ownResults(msg, inst.id);
        if (results) this.emit(results);
        return;
      }
      case 'error':
        // Without id the sandbox means itself: it only ever runs this instance.
        this.emit({ type: 'error', id: inst.id, message: textOf(msg.message, 'Script error') });
        return;
      case 'loaded':
        this.onLoaded(inst, sb, msg.manifest);
        return;
      case 'resync':
        this.onResync(sb, inst, msg);
        return;
      default:
        // timeframes / symbols (scripts have no such inputs), compileError (the
        // `add` that follows reports it with the instance id), check/probe results.
        return;
    }
  }

  /** The compiled script must be the one the chart was set up with. */
  private onLoaded(inst: Instance, sb: Sandbox, manifest: unknown): void {
    let same: boolean;
    try {
      same = canonicalJson(parseManifest(manifest)) === sb.manifestKey;
    } catch {
      same = false; // Not a valid manifest: cannot be the saved one.
    }
    if (same) return;
    this.stop(inst);
    this.emit({ type: 'error', id: inst.id, message: SCRIPT_CHANGED_MESSAGE });
  }

  /** A live bar did not fit the sandbox's series: resend the mirror, at most 3 times per revision. */
  private onResync(sb: Sandbox, inst: Instance, msg: Record<string, unknown>): void {
    const { revision, bars } = msg;
    if (typeof revision !== 'number' || typeof bars !== 'number') return;
    // A resend is already in flight, or the series moved on (its own bars follow).
    if (bars < sb.barsSent || revision !== this.mirror.revision || !this.mirror.valid) return;
    if (sb.resyncRevision !== revision) {
      sb.resyncRevision = revision;
      sb.resyncs = 0;
    }
    if (++sb.resyncs > MAX_SANDBOX_RESYNCS) {
      if (sb.resyncs === MAX_SANDBOX_RESYNCS + 1)
        this.emit({ type: 'error', id: inst.id, message: OUT_OF_SYNC_MESSAGE });
      return;
    }
    this.sendBars(sb);
  }

  private emit(msg: FromWorker): void {
    this.listener?.(msg);
  }
}

/**
 * The `results` message reduced to `id`'s changes, rebuilt from validated
 * fields (Float64Array values, Uint8Array colours); null if nothing is left.
 */
function ownResults(msg: Record<string, unknown>, id: string): FromWorker | null {
  const { revision, length, changes } = msg;
  if (!Number.isInteger(revision) || !Number.isInteger(length) || (length as number) < 0)
    return null;
  if (!Array.isArray(changes)) return null;
  const out: ResultChange[] = [];
  for (const ch of changes as unknown[]) {
    if (!isObj(ch) || ch.id !== id) continue;
    const change = ownChange(ch, id, length as number);
    if (change) out.push(change);
  }
  if (!out.length) return null;
  return { type: 'results', revision: revision as number, length: length as number, changes: out };
}

function ownChange(ch: Record<string, unknown>, id: string, length: number): ResultChange | null {
  const { from, status, values, colors } = ch;
  if (!Number.isInteger(from) || (from as number) < 0 || (from as number) > length) return null;
  const st = statusOf(status);
  if (!st || !isObj(values) || !isObj(colors)) return null;
  const vals = typedEntries(values, Float64Array);
  const cols = typedEntries(colors, Uint8Array);
  if (!vals || !cols) return null;
  return {
    id,
    from: from as number,
    status: st,
    values: Object.fromEntries(vals),
    colors: Object.fromEntries(cols),
  };
}

function typedEntries<T extends Float64Array | Uint8Array>(
  rec: Record<string, unknown>,
  ctor: abstract new (...args: never[]) => T,
): [string, T][] | null {
  const out: [string, T][] = [];
  for (const [k, v] of Object.entries(rec)) {
    if (!(v instanceof ctor)) return null;
    out.push([k, v]);
  }
  return out;
}

function statusOf(v: unknown): InstanceStatus | null {
  if (!isObj(v)) return null;
  switch (v.state) {
    case 'ok':
      return { state: 'ok' };
    case 'error':
      return { state: 'error', message: textOf(v.message, 'Script error') };
    case 'waiting':
      // Scripts have no timeframe/symbol inputs; keep it well-formed anyway.
      return typeof v.timeframe === 'string'
        ? { state: 'waiting', timeframe: v.timeframe.slice(0, 50) }
        : null;
    default:
      return null;
  }
}
