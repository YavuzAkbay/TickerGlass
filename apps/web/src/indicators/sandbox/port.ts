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
  // Must stay `type: 'module'`: module code is always strict, and the sandbox
  // relies on strict mode (no `arguments.callee` / `fn.caller` / sloppy stack
  // frames leaking the captured post). The built file also starts with
  // "use strict" (vite.config.ts sandboxWorkerSelfContained).
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
        onFailure(`Sandbox worker failed: ${textOf(e.message, 'unknown error')}`);
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
/**
 * A ping must be acknowledged within this: it is only sent to an idle sandbox,
 * which answers at once, so a longer wait means user code keeps the worker
 * busy in the background. Generous for a loaded machine or a GC pause.
 */
export const PING_DEADLINE_MS = 2_000;
/** Messages awaiting an ack beyond which a sandbox is stopped (it cannot keep up). */
export const MAX_PENDING_MESSAGES = 500;
/** No message may wait longer than this for its ack, however the queue moves. */
export const MAX_MESSAGE_AGE_MS = 30_000;
/**
 * Non-ack messages a sandbox may post between two acks: this many, plus
 * POSTS_PER_PENDING per message it has not acknowledged yet (the most one
 * message causes is 3: results or error, timeframes, symbols).
 */
export const POSTS_SLACK = 4;
export const POSTS_PER_PENDING = 4;
/** Resends of the bars to one sandbox per series revision. */
export const MAX_SANDBOX_RESYNCS = 3;

export const SCRIPT_CHANGED_MESSAGE =
  'Script changed since it was saved – open the editor and save again';
export const OUT_OF_SYNC_MESSAGE = 'Indicator data keeps falling out of sync with the chart';
export const PROTOCOL_MESSAGE = 'Stopped: the script broke the sandbox protocol';
export const FLOOD_MESSAGE = 'Stopped: the script sent too many messages';
export const BACKLOG_MESSAGE = 'Stopped: the script cannot keep up with the chart';

const SLOW_TYPES = new Set<SandboxMessage['type']>(['load', 'bars', 'check']);

const limitOf = (type: SandboxMessage['type']) =>
  type === 'ping' ? PING_DEADLINE_MS : SLOW_TYPES.has(type) ? SLOW_MESSAGE_MS : MESSAGE_MS;
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
  /** Date.now() of its post (MAX_MESSAGE_AGE_MS). */
  posted: number;
}

/** A spawned sandbox worker with its watchdog. */
interface Sandbox {
  port: SandboxPort;
  /** Source + manifest it was loaded with. */
  sig: string;
  /** Stub definition of the saved manifest (input coercion). */
  def: AnyIndicatorDefinition;
  /** Output ids of `def`: the only keys a result may carry. */
  outputIds: ReadonlySet<string>;
  /** Canonical JSON of the saved manifest. */
  manifestKey: string;
  seq: number;
  /** Posted, not yet acknowledged; oldest first. */
  pending: Pending[];
  /** When the oldest pending message started waiting (its post, or the previous ack). */
  since: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** Non-ack messages received since the last ack (rate cap). */
  received: number;
  /** Terminated: nothing more is sent or armed. */
  stopped: boolean;
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
    // Counted like the controller: instances whose script can run (a stopped
    // instance of a deleted or broken script takes no slot).
    let running = 0;
    for (const i of this.instances.values()) if (i.sandbox || this.runnable(i.scriptId)) running++;
    if (running >= MAX_SCRIPT_INSTANCES_PER_CHART) {
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
    const parsed = script && parsedManifest(script);
    // No stub is registered for it either: the controller reports it.
    if (!script || !parsed) return;
    const def: AnyIndicatorDefinition = { ...parsed.def, id: inst.type };
    const { manifestKey } = parsed;
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
      outputIds: new Set(def.outputs.map((o) => o.id)),
      manifestKey,
      seq: 0,
      pending: [],
      since: 0,
      timer: null,
      received: 0,
      stopped: false,
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

  /** The saved script of `scriptId` has a manifest a sandbox can start with. */
  private runnable(scriptId: string): boolean {
    const script = this.deps.getScript(scriptId);
    return !!script && parsedManifest(script) !== null;
  }

  /** Stop `sb` (if still its instance's sandbox) and report `message` on the instance. */
  private kill(sb: Sandbox, message: string): void {
    const inst = [...this.instances.values()].find((i) => i.sandbox === sb);
    if (!inst) return;
    this.stop(inst);
    this.emit({ type: 'error', id: inst.id, message });
  }

  /** Terminate the instance's sandbox (if any); the instance stays known. */
  private stop(inst: Instance): void {
    const sb = inst.sandbox;
    if (!sb) return;
    inst.sandbox = null;
    sb.stopped = true;
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
    if (sb.stopped) return;
    if (sb.pending.length >= MAX_PENDING_MESSAGES) {
      this.kill(sb, BACKLOG_MESSAGE);
      return;
    }
    const seq = ++sb.seq;
    const now = Date.now();
    if (!sb.pending.length) sb.since = now;
    sb.pending.push({ seq, limit: limitOf(msg.type), posted: now });
    sb.port.post({ seq, msg }, transfer);
    this.arm(sb);
  }

  // -------------------------------------------------------------- watchdog

  /**
   * One timer per sandbox: the oldest unacknowledged message's deadline (its
   * limit from when it became the oldest, capped at MAX_MESSAGE_AGE_MS from
   * its post), or the next idle ping when nothing is outstanding.
   */
  private arm(sb: Sandbox): void {
    if (sb.timer !== null) clearTimeout(sb.timer);
    sb.timer = null;
    if (sb.stopped) return;
    const oldest = sb.pending[0];
    if (!oldest) {
      sb.timer = setTimeout(() => {
        sb.timer = null;
        this.send(sb, { type: 'ping' });
      }, PING_MS);
      return;
    }
    const deadline = sb.since + oldest.limit;
    const tooOld = oldest.posted + MAX_MESSAGE_AGE_MS;
    const message = tooOld < deadline ? BACKLOG_MESSAGE : stoppedMessage(oldest.limit);
    const wait = Math.max(0, Math.min(deadline, tooOld) - Date.now());
    sb.timer = setTimeout(() => {
      sb.timer = null;
      this.kill(sb, message);
    }, wait);
  }

  /**
   * Acks are cumulative and must name a message that is outstanding
   * (`pending[0].seq <= seq <= sb.seq`); anything else is a protocol
   * violation and stops the sandbox.
   */
  private onAck(sb: Sandbox, seq: unknown): void {
    const first = sb.pending[0];
    if (
      typeof seq !== 'number' ||
      !Number.isInteger(seq) ||
      !first ||
      seq < first.seq ||
      seq > sb.seq
    ) {
      this.kill(sb, PROTOCOL_MESSAGE);
      return;
    }
    sb.pending = sb.pending.filter((p) => p.seq > seq);
    sb.received = 0;
    // The next message's handling starts now.
    sb.since = Date.now();
    this.arm(sb);
  }

  // ------------------------------------------------------------- receiving

  private onSandboxMessage(inst: Instance, sb: Sandbox, msg: FromSandbox): void {
    if (isObj(msg) && msg.type === 'ack') {
      this.onAck(sb, msg.seq);
      return;
    }
    // Rate cap: everything else must be caused by a message still outstanding.
    if (++sb.received > POSTS_SLACK + POSTS_PER_PENDING * sb.pending.length) {
      this.kill(sb, FLOOD_MESSAGE);
      return;
    }
    if (!isObj(msg)) return;
    switch (msg.type) {
      case 'results': {
        const results = ownResults(msg, inst.id, this.mirror, sb.outputIds);
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

/** Parsed saved manifest: its stub definition and canonical JSON; null if it cannot run. */
function parsedManifest(
  script: ScriptSource,
): { def: AnyIndicatorDefinition; manifestKey: string } | null {
  if (!script.manifest) return null;
  try {
    const manifest = parseManifest(script.manifest);
    return { def: definitionFromManifest(manifest), manifestKey: canonicalJson(manifest) };
  } catch {
    return null;
  }
}

/**
 * The `results` message reduced to `id`'s changes, rebuilt from validated
 * fields; null if nothing is left. Bounded by what the router itself sent:
 * the mirror's revision, at most its length, arrays of exactly
 * `length - from` (Float64Array values, Uint8Array colours) keyed by output
 * ids of the instance's definition.
 */
function ownResults(
  msg: Record<string, unknown>,
  id: string,
  mirror: { readonly revision: number; readonly length: number },
  outputIds: ReadonlySet<string>,
): FromWorker | null {
  const { revision, length, changes } = msg;
  if (revision !== mirror.revision || !Number.isInteger(length)) return null;
  if ((length as number) < 0 || (length as number) > mirror.length) return null;
  if (!Array.isArray(changes)) return null;
  const out: ResultChange[] = [];
  for (const ch of changes as unknown[]) {
    if (!isObj(ch) || ch.id !== id) continue;
    const change = ownChange(ch, id, length as number, outputIds);
    if (change) out.push(change);
  }
  if (!out.length) return null;
  return { type: 'results', revision: revision as number, length: length as number, changes: out };
}

function ownChange(
  ch: Record<string, unknown>,
  id: string,
  length: number,
  outputIds: ReadonlySet<string>,
): ResultChange | null {
  const { from, status, values, colors } = ch;
  if (!Number.isInteger(from) || (from as number) < 0 || (from as number) > length) return null;
  const st = statusOf(status);
  if (!st || !isObj(values) || !isObj(colors)) return null;
  const size = length - (from as number);
  const vals = typedEntries(values, Float64Array, size, outputIds);
  const cols = typedEntries(colors, Uint8Array, size, outputIds);
  if (!vals || !cols) return null;
  return {
    id,
    from: from as number,
    status: st,
    values: Object.fromEntries(vals),
    colors: Object.fromEntries(cols),
  };
}

/** Entries of `rec` if every one is a `ctor` of exactly `size` under a known output id; else null. */
function typedEntries<T extends Float64Array | Uint8Array>(
  rec: Record<string, unknown>,
  ctor: abstract new (...args: never[]) => T,
  size: number,
  outputIds: ReadonlySet<string>,
): [string, T][] | null {
  const out: [string, T][] = [];
  for (const [k, v] of Object.entries(rec)) {
    if (!outputIds.has(k) || !(v instanceof ctor) || v.length !== size) return null;
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
