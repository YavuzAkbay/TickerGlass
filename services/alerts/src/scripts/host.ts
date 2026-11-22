/**
 * Runs user scripts for the alerts service in `isolated-vm` isolates: one
 * isolate per script id, shared by every series using the script. Inside there
 * is no `process`, `require`, `fetch` or timer: only what `isolate-entry.ts`
 * bundles, reached through copies (arguments and results are structured
 * clones; no host object or function is ever passed in). Everything an isolate
 * returns is untrusted and checked (`validate.ts`) before use.
 *
 * Calls: every call is asynchronous (`callAsync`): load, open, addInstances,
 * setBars and Check within the `loadMs` limit, a live bar update within `tickMs`.
 * The isolates live behind an `IsolateFactory`: in production in a child
 * process (`remoteIsolates.ts`), so the host's own state (faults, back-off,
 * strikes, CPU budgets, validation of every result) survives a script that
 * makes V8 abort its process.
 *
 * Faults (docs/alerts.md section 2.8): a load/compute timeout, an
 * out-of-memory, a dead isolate or an exceeded CPU budget disposes the isolate
 * and holds the script off for 5 minutes (doubling per repeat, up to 1 hour).
 * A live-update timeout is one strike; 3 strikes within 10 minutes are a
 * fault. After the second fault in a row at the 1 hour cap the fault is
 * `final`. Faults reset after an hour without one. Calls during the hold
 * fail with `ScriptUnavailable`.
 */
import type { ChildProcess } from 'node:child_process';
import type { UserScriptManifest } from '@tickerglass/indicators';
import { backoffMs, type Clock } from '../clock';
import { errText, type Logger } from '../log';
import {
  ScriptCallError,
  ScriptCapacity,
  ScriptCrashed,
  ScriptFault,
  ScriptStrike,
  ScriptSuperseded,
  ScriptUnavailable,
  type CrashInfo,
  type FaultKind,
} from './errors';
import { loadIsolateBundle } from './isolateBundle';
import {
  LocalIsolates,
  type CallResult,
  type IsolateFactory,
  type IsolateHandle,
  type Ivm,
} from './isolates';
import { ProcessIsolates, type ProcessOptions } from './remoteIsolates';
import type { IsolateApi, LoadResult } from './protocol';
import { readCheck, readLoad, readSeries, readVoid, unwrap, type SeriesExpect } from './validate';

export {
  ScriptCallError,
  ScriptCapacity,
  ScriptCrashed,
  ScriptFault,
  ScriptStrike,
  ScriptSuperseded,
  ScriptUnavailable,
};
export type { FaultKind, SeriesExpect };

export const FAULT_RETRY_MIN_MS = 5 * 60_000;
export const FAULT_RETRY_MAX_MS = 60 * 60_000;
/** Live-update timeouts within `TICK_STRIKE_WINDOW_MS` that make a fault. */
export const TICK_STRIKES = 3;
export const TICK_STRIKE_WINDOW_MS = 10 * 60_000;
/** Faults in a row at the retry cap after which the fault is final (alerts end in `error`). */
export const FINAL_AFTER_CAP_FAULTS = 2;
/** Time a script runs without a fault before its fault count is forgotten. */
export const HEALTHY_RESET_MS = 60 * 60_000;
/** Sliding window of the CPU budgets, and the shortest span they are judged over. */
export const CPU_WINDOW_MS = 5 * 60_000;
export const CPU_MIN_SPAN_MS = 30_000;
/** Per-script share of one CPU spent in live updates. */
export const DEFAULT_CPU_PCT = 20;
/** Share of one CPU all scripts together may spend in live updates. */
export const DEFAULT_CPU_TOTAL_PCT = 50;

/** Crashes of the isolates' process with no call in flight that make a fault for every script. */
export const UNATTRIBUTED_CRASHES = 3;

/** Hold after a process death that is probably another script's doing (not counted as a fault). */
export const SOFT_HOLD_MS = 45_000;
/** Hold when the script process has no room for another isolate. */
export const CAPACITY_HOLD_MS = 60_000;

/** Slack between a call's timeout and the time it measured (timer granularity). */
const TIMEOUT_SLACK_MS = 15;
/** How long past its time limit an async call may stay unanswered before the isolate is given up. */
export const WATCHDOG_GRACE_MS = 2000;

/** An async call stayed unanswered past its limit plus the grace: the isolate's thread is stuck. */
class IsolateStuck extends Error {
  constructor() {
    super('the isolate did not answer within its time limit');
    this.name = 'IsolateStuck';
  }
}
/** The isolate enforces its time limit itself; this covers one that stays silent past it (stuck thread). */
async function withWatchdog<T>(call: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watchdog = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new IsolateStuck()), ms);
  });
  // The loser of the race may still reject later (the isolate gets disposed): not unhandled.
  call.catch(() => undefined);
  try {
    return await Promise.race([call, watchdog]);
  } finally {
    clearTimeout(timer);
  }
}
const cpuText = (u: { used: number; span: number }): string =>
  `${Math.round(u.used)} ms of CPU in ${Math.round(u.span)} ms`;
export const MANIFEST_STALE = 'saved manifest is out of date — open and re-save the script';

export interface ScriptSource {
  id: string;
  source: string;
  revision: number;
  /** The manifest the last save stored; when set, the compiled one must match it. */
  manifest?: UserScriptManifest | null;
}

/** The script is held off after a fault until `retryAt` (clock ms). */
export interface ScriptHold {
  reason: string;
  retryAt: number;
  /** Escalated: alerts on the script end in `error` instead of waiting. */
  final: boolean;
}

interface ScriptHostCommon {
  memoryMb: number;
  loadMs: number;
  tickMs: number;
  /** A script isolate may use at most this share (%) of one CPU over 5 minutes. */
  cpuPct?: number;
  /** All isolates together may use at most this share (%) of one CPU over 5 minutes. */
  cpuTotalPct?: number;
  /** Grace past a call's limit before the host stops waiting for an isolate (default 2 s). */
  watchdogGraceMs?: number;
  clock: Clock;
  log: Logger;
}

/** Where the isolates run: an `IsolateFactory`, or `isolated-vm` + the entry bundle in this process. */
export type ScriptHostOptions = ScriptHostCommon &
  ({ isolates: IsolateFactory } | { bundle: string; ivm: Ivm });

interface Entry {
  source: ScriptSource;
  iso: IsolateHandle | null;
  /** The isolate being created and loaded (one at a time per script). */
  opening: Promise<void> | null;
  /** Counts isolate generations (series re-open their state when it changes). */
  epoch: number;
  /** Manifest the isolate compiled (validated). */
  manifest: UserScriptManifest | null;
  plotIds: ReadonlySet<string>;
  /** Deterministic problems: stay until the script is saved again. */
  compileError: string | null;
  manifestError: string | null;
  fault: ScriptHold | null;
  /** Faults since the last healthy hour, and how many of them in a row waited the full cap. */
  faults: number;
  capFaults: number;
  /** When the current isolate finished loading. */
  healthySince: number;
  /** Clock times of recent live-update timeouts. */
  strikes: number[];
  /** CPU spent in live updates (clock ms of the call, isolate cpu ms), within the window. */
  usage: { t: number; ms: number }[];
  /** Asynchronous calls running or queued on the isolate, and who waits for none. */
  inflight: number;
  idleWaiters: (() => void)[];
}

export type FaultListener = (scriptId: string, reason: string, hold: ScriptHold) => void;

function newEntry(source: ScriptSource, epoch: number): Entry {
  return {
    source,
    iso: null,
    opening: null,
    epoch,
    manifest: null,
    plotIds: new Set(),
    compileError: null,
    manifestError: null,
    fault: null,
    faults: 0,
    capFaults: 0,
    healthySince: 0,
    strikes: [],
    usage: [],
    inflight: 0,
    idleWaiters: [],
  };
}

/** Whether the isolate's manifest agrees with the saved one on what alerts rely on. */
export function manifestMatches(saved: UserScriptManifest, built: UserScriptManifest): boolean {
  if ((saved.repaints === true) !== (built.repaints === true)) return false;
  const plots = (m: UserScriptManifest) =>
    m.outputs
      .filter((o) => o.type === 'plot')
      .map((o) => o.id)
      .sort()
      .join('\0');
  const inputs = (m: UserScriptManifest) =>
    Object.entries(m.inputs)
      .map(([id, def]) => `${id}:${def.kind}`)
      .sort()
      .join('\0');
  return plots(saved) === plots(built) && inputs(saved) === inputs(built);
}

export class ScriptHost {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners: FaultListener[] = [];
  private disposed = false;

  private readonly opts: ScriptHostCommon;
  private readonly isolates: IsolateFactory;
  /** Clock times of crashes of the isolates' process that no call in flight explains. */
  private unattributed: number[] = [];
  /** The scripts that had a request in flight at each of the last 3 deaths of the process. */
  private crashLog: { scripts: ReadonlySet<string> }[] = [];

  constructor(options: ScriptHostOptions) {
    this.opts = options;
    this.isolates =
      'isolates' in options ? options.isolates : new LocalIsolates(options.ivm, options.bundle);
    this.startedAt = options.clock.now();
    this.isolates.onCrash = (inflight, reason) => this.crashed(inflight, reason);
  }

  private get graceMs(): number {
    return this.opts.watchdogGraceMs ?? WATCHDOG_GRACE_MS;
  }

  /**
   * Load `isolated-vm` and the isolate bundle. Throws when either is
   * unavailable (no native binary for this platform/Node): the caller can
   * run on with `ScriptHost.disabled(...)`.
   */
  static async create(opts: ScriptHostCommon): Promise<ScriptHost> {
    const ivm = (await import('isolated-vm')).default;
    return new ScriptHost({ ...opts, ivm, bundle: await loadIsolateBundle() });
  }

  /**
   * The production host: isolates run in a child process (`remoteIsolates.ts`). Starts the
   * child and throws when it cannot load `isolated-vm` (no binary for this platform/Node).
   */
  static async createIsolated(
    opts: ScriptHostCommon & { process: Omit<ProcessOptions, 'log' | 'onCrash'> },
  ): Promise<ScriptHost> {
    const { process: proc, ...common } = opts;
    const isolates = new ProcessIsolates({ ...proc, log: opts.log });
    try {
      await isolates.probe();
    } catch (err) {
      isolates.dispose();
      throw err;
    }
    return new ScriptHost({ ...common, isolates });
  }

  /** A host on which every script is unavailable for `reason`. */
  static disabled(reason: string, clock: Clock, log: Logger): ScriptHost {
    const h = new ScriptHost({
      isolates: { create: () => Promise.reject(new Error(reason)), dispose: () => {} },
      memoryMb: 0,
      loadMs: 0,
      tickMs: 0,
      clock,
      log,
    });
    h.disabledReason = reason;
    return h;
  }

  private disabledReason: string | null = null;
  private readonly startedAt: number;

  /** Test hook: the child process the isolates run in (null in-process, or while it is down). */
  childProcess(): ChildProcess | null {
    return this.isolates instanceof ProcessIsolates ? this.isolates.process : null;
  }

  /** Called after an isolate was disposed by a fault (or a counted timeout), with its hold. */
  onFault(fn: FaultListener): void {
    this.listeners.push(fn);
  }

  /**
   * Make the host's scripts exactly `list`. A changed revision drops the
   * isolate and every earlier failure (the next call compiles the new
   * source); a script missing from the list is forgotten. Calls running in a
   * dropped isolate end with `ScriptSuperseded`, not a fault.
   */
  setScripts(list: readonly ScriptSource[]): void {
    const seen = new Set<string>();
    for (const src of list) {
      seen.add(src.id);
      const e = this.entries.get(src.id);
      if (e && e.source.revision === src.revision && e.source.source === src.source) continue;
      if (e) {
        e.iso?.dispose();
        e.epoch++;
      }
      this.entries.set(src.id, newEntry(src, (e?.epoch ?? 0) + 1));
    }
    for (const [id, e] of [...this.entries]) {
      if (seen.has(id)) continue;
      e.iso?.dispose();
      this.entries.delete(id);
    }
  }

  has(scriptId: string): boolean {
    return this.entries.has(scriptId);
  }

  /** Isolate generation of the script (0 when unknown). */
  epoch(scriptId: string): number {
    return this.entries.get(scriptId)?.epoch ?? 0;
  }

  /**
   * Why the script cannot run right now, or null. Creates no isolate. Covers
   * deterministic problems and the hold after a fault.
   */
  unavailable(scriptId: string): string | null {
    if (this.disabledReason !== null) return this.disabledReason;
    const e = this.entries.get(scriptId);
    if (!e) return 'script was deleted';
    if (e.compileError !== null) return `script does not compile: ${e.compileError}`;
    if (e.manifestError !== null) return e.manifestError;
    return this.faultReason(e);
  }

  /** The running hold after a fault (the script comes back by itself), or null. */
  hold(scriptId: string): ScriptHold | null {
    const f = this.entries.get(scriptId)?.fault;
    if (!f || f.retryAt <= this.opts.clock.now()) return null;
    return f;
  }

  private faultReason(e: Entry): string | null {
    const f = e.fault;
    if (!f) return null;
    const left = f.retryAt - this.opts.clock.now();
    if (left <= 0) return null;
    return `${f.reason}; the script is disabled for ${Math.ceil(left / 60_000)} more min`;
  }

  /**
   * Compile the script (creating its isolate when needed). `ok: false` for a
   * compile error, a manifest that is out of date, or a script that is held
   * off after a fault.
   */
  async ensure(
    scriptId: string,
  ): Promise<{ ok: true; manifest: UserScriptManifest } | { ok: false; reason: string }> {
    try {
      const { e } = await this.live(scriptId, false);
      return { ok: true, manifest: e.manifest! };
    } catch (err) {
      if (err instanceof ScriptUnavailable) return { ok: false, reason: err.reason };
      throw err;
    }
  }

  /**
   * Call `name` of the script's API with `args` (cloned in, result cloned
   * out and validated against `expect`) in the isolate, within the load limit,
   * or the tick limit when `tick` (a live update: its timeout is a strike, not
   * a fault). With `epoch` the
   * call only runs in that isolate generation. Resolves with the value and the
   * generation it ran in. Throws `ScriptUnavailable` (`ScriptFault` when this
   * call killed the isolate, `ScriptSuperseded` when the isolate was replaced
   * meanwhile), `ScriptStrike` or `ScriptCallError`.
   */
  async callAsync<T>(
    scriptId: string,
    name: keyof IsolateApi,
    args: unknown[],
    expect?: SeriesExpect,
    epoch?: number,
    tick = false,
  ): Promise<{ value: T; epoch: number }> {
    const counted = this.entries.get(scriptId);
    if (counted) counted.inflight++;
    try {
      const { e, iso } = await this.live(scriptId, epoch !== undefined);
      if (epoch !== undefined && e.epoch !== epoch) throw new ScriptSuperseded(scriptId);
      const limit = tick ? this.opts.tickMs : this.opts.loadMs;
      const started = performance.now();
      let result: CallResult;
      try {
        result = await withWatchdog(iso.callAsync(name, args, limit), limit + this.graceMs);
      } catch (err) {
        throw this.failure(scriptId, e, iso, err, limit, performance.now() - started, !tick);
      }
      if (this.entries.get(scriptId) !== e || e.iso !== iso) throw new ScriptSuperseded(scriptId);
      const value = this.finish<T>(
        scriptId,
        e,
        iso,
        name,
        result.raw,
        expect,
        tick && name === 'updateBar' ? result.cpuMs : null,
      );
      return { value, epoch: e.epoch };
    } finally {
      if (counted) {
        counted.inflight--;
        if (counted.inflight === 0 && !counted.opening) this.wake(counted);
      }
    }
  }

  /** Resolves when no asynchronous call is running or queued on the script (at once if none). */
  idle(scriptId: string): Promise<void> {
    const e = this.entries.get(scriptId);
    if (!e || (e.inflight === 0 && !e.opening)) return Promise.resolve();
    return new Promise((resolve) => e.idleWaiters.push(resolve));
  }

  private wake(e: Entry): void {
    const waiters = e.idleWaiters;
    e.idleWaiters = [];
    for (const w of waiters) w();
  }

  /**
   * Validate a result. A live update (`cpu0` = the isolate's CPU time before it) is charged
   * to the CPU budgets; loads, full computes and Check are bounded by the load limit alone.
   */
  private finish<T>(
    scriptId: string,
    e: Entry,
    iso: IsolateHandle,
    name: keyof IsolateApi,
    raw: unknown,
    expect: SeriesExpect | undefined,
    cpuUsedMs: number | null,
  ): T {
    if (cpuUsedMs !== null) {
      const over = this.chargeCpu(scriptId, e, iso, cpuUsedMs);
      if (over) throw over;
    }
    const value = unwrap(raw);
    let out: unknown;
    switch (name) {
      case 'open':
      case 'addInstances':
      case 'setBars':
      case 'updateBar':
        if (!expect) throw new ScriptCallError(`'${name}' needs the series' known instances`);
        out = readSeries(value, expect, e.plotIds);
        break;
      case 'check':
        out = readCheck(value);
        break;
      case 'close':
      case 'removeInstance':
        out = readVoid(value);
        break;
      default:
        throw new ScriptCallError(`'${name}' cannot be called from outside`);
    }
    this.noteHealthy(e);
    return out as T;
  }

  /** Checks that hold for any use of the script; throws `ScriptUnavailable`. */
  private usable(scriptId: string): Entry {
    if (this.disposed) throw new ScriptUnavailable(scriptId, 'alerts service is stopping', true);
    if (this.disabledReason !== null) throw new ScriptUnavailable(scriptId, this.disabledReason);
    const e = this.entries.get(scriptId);
    if (!e) throw new ScriptUnavailable(scriptId, 'script was deleted');
    if (e.compileError !== null)
      throw new ScriptUnavailable(scriptId, `script does not compile: ${e.compileError}`);
    if (e.manifestError !== null) throw new ScriptUnavailable(scriptId, e.manifestError);
    return e;
  }

  private heldOff(scriptId: string, e: Entry): ScriptUnavailable | null {
    const wait = this.faultReason(e);
    return wait === null ? null : new ScriptUnavailable(scriptId, wait, !e.fault?.final);
  }

  /**
   * The script's isolate, created and compiled on first use (one creation at
   * a time; callers share it). `mustExist`: a caller that needs an isolate it
   * already has state in does not get a fresh one (`ScriptSuperseded`).
   */
  private async live(
    scriptId: string,
    mustExist: boolean,
  ): Promise<{ e: Entry; iso: IsolateHandle }> {
    for (;;) {
      const e = this.usable(scriptId);
      if (e.iso && !e.iso.isDead && e.manifest) return { e, iso: e.iso };
      if (!e.opening) {
        const held = this.heldOff(scriptId, e);
        if (held) throw held;
      }
      if (mustExist) throw new ScriptSuperseded(scriptId);
      e.opening ??= this.open(scriptId, e).finally(() => {
        e.opening = null;
        if (e.inflight === 0) this.wake(e);
      });
      await e.opening;
      if (this.entries.get(scriptId) !== e) throw new ScriptSuperseded(scriptId);
    }
  }

  /** Create the isolate, load the script, check its manifest. Failures throw; the entry keeps the verdict. */
  private async open(scriptId: string, e: Entry): Promise<void> {
    const { opts } = this;
    e.fault = null;
    e.iso?.dispose();
    e.iso = null;
    e.manifest = null;
    let iso: IsolateHandle;
    try {
      iso = await this.isolates.create(opts.memoryMb, opts.loadMs, scriptId);
    } catch (err) {
      throw this.failure(scriptId, e, null, err, opts.loadMs, 0, true);
    }
    if (this.disposed || this.entries.get(scriptId) !== e) {
      iso.dispose();
      throw new ScriptSuperseded(scriptId);
    }
    e.iso = iso;
    e.epoch++;
    e.usage = [];
    const started = performance.now();
    let raw: unknown;
    try {
      raw = (
        await withWatchdog(
          iso.callAsync('load', [scriptId, e.source.source], opts.loadMs),
          opts.loadMs + this.graceMs,
        )
      ).raw;
    } catch (err) {
      throw this.failure(scriptId, e, iso, err, opts.loadMs, performance.now() - started, true);
    }
    if (this.entries.get(scriptId) !== e || e.iso !== iso) throw new ScriptSuperseded(scriptId);
    let res: LoadResult;
    try {
      res = readLoad(unwrap(raw), scriptId);
    } catch (err) {
      return this.reject(e, iso, 'compileError', errText(err));
    }
    if (!res.ok) {
      const where = res.line !== undefined ? ` (line ${res.line}:${res.col ?? 0})` : '';
      return this.reject(e, iso, 'compileError', `${res.message}${where}`);
    }
    const saved = e.source.manifest;
    if (saved && !manifestMatches(saved, res.manifest))
      return this.reject(e, iso, 'manifestError', MANIFEST_STALE);
    e.manifest = res.manifest;
    e.plotIds = new Set(res.manifest.outputs.filter((o) => o.type === 'plot').map((o) => o.id));
    e.healthySince = opts.clock.now();
  }

  /** A deterministic load failure: remembered until the script is saved again. */
  private reject(
    e: Entry,
    iso: IsolateHandle,
    field: 'compileError' | 'manifestError',
    text: string,
  ): never {
    e[field] = text;
    iso.dispose();
    e.iso = null;
    throw new ScriptUnavailable(
      e.source.id,
      field === 'compileError' ? `script does not compile: ${text}` : text,
    );
  }

  /**
   * Classify an error out of the isolate. The entry reports every script error
   * through an envelope, so an error here came from the isolate itself: it
   * died (memory limit, crash) or the call hit its time limit; anything else is
   * a call error that leaves the isolate usable. Message text is only read to
   * tell memory from other deaths and after the timing check agrees.
   */
  private failure(
    scriptId: string,
    e: Entry,
    iso: IsolateHandle | null,
    err: unknown,
    timeoutMs: number,
    elapsedMs: number,
    slow: boolean,
  ): Error {
    if (this.disposed || this.entries.get(scriptId) !== e || iso?.disposed)
      return new ScriptSuperseded(scriptId);
    if (iso !== null && e.iso !== iso) return new ScriptSuperseded(scriptId);
    const text = errText(err);
    const limits = `${this.opts.loadMs} ms to load/compute, ${this.opts.tickMs} ms per update`;
    let kind: FaultKind | null = null;
    let reason = '';
    if (err instanceof ScriptSuperseded) return err;
    if (err instanceof ScriptCapacity) {
      return this.softHold(scriptId, e, iso, 'capacity', err.message, CAPACITY_HOLD_MS, text);
    }
    if (err instanceof ScriptCrashed) return this.blameCrash(scriptId, e, iso, err, text);
    if (iso === null || iso.died) {
      if (/memory limit/i.test(text)) {
        kind = 'memory';
        reason = `script exceeded its memory limit (${this.opts.memoryMb} MB)`;
      } else {
        kind = 'crash';
        reason = `script isolate failed: ${text}`.slice(0, 300);
      }
    } else if (
      err instanceof IsolateStuck ||
      (/timed out/i.test(text) && elapsedMs >= timeoutMs - TIMEOUT_SLACK_MS)
    ) {
      kind = 'timeout';
      reason = `script exceeded its time limit (${limits})`;
    }
    if (kind === null) return err instanceof ScriptCallError ? err : new ScriptCallError(text);
    if (kind === 'timeout' && !slow) {
      const now = this.opts.clock.now();
      e.strikes = e.strikes.filter((t) => now - t < TICK_STRIKE_WINDOW_MS);
      e.strikes.push(now);
      if (e.strikes.length < TICK_STRIKES) return this.strike(scriptId, e, reason, text);
    }
    return this.fault(scriptId, e, iso, kind, reason, text);
  }

  /**
   * The process the isolates live in died while `scriptId` had a request in flight. The script
   * is blamed (a counted fault: back-off grows) only when it is the likeliest cause: it was the
   * only script with a request in flight, or it was in flight at 2 of the last 3 deaths, or the
   * process was killed for memory and its isolate was the largest. Any other script that merely
   * shared the process gets a short hold that does not count (no back-off, never final).
   */
  private blameCrash(
    scriptId: string,
    e: Entry,
    iso: IsolateHandle | null,
    err: ScriptCrashed,
    text: string,
  ): ScriptFault | ScriptSuperseded {
    const c = err.crash;
    if (c?.cause === 'stopping') return new ScriptSuperseded(scriptId);
    let counted: boolean;
    if (!c) counted = false;
    else if (c.blame !== null) counted = c.blame === scriptId;
    else
      counted =
        (c.scripts.size === 1 && c.scripts.has(scriptId)) ||
        this.crashLog.filter((x) => x.scripts.has(scriptId)).length >= 2;
    if (counted)
      return this.fault(
        scriptId,
        e,
        iso,
        'crash',
        `script crashed the script runtime (${text}), most likely by running out of memory`,
        text,
      );
    return this.softHold(
      scriptId,
      e,
      iso,
      'crash',
      `the script runtime stopped while this script was using it (${text}); another script is the likelier cause, retrying shortly`,
      SOFT_HOLD_MS,
      text,
    );
  }

  /** A short hold that is not the script's fault: no fault count, no back-off growth, never final. */
  private softHold(
    scriptId: string,
    e: Entry,
    iso: IsolateHandle | null,
    kind: FaultKind,
    reason: string,
    ms: number,
    text: string,
  ): ScriptFault {
    const now = this.opts.clock.now();
    this.drop(e, iso);
    const hold: ScriptHold = { reason, retryAt: now + ms, final: false };
    e.fault = hold;
    this.opts.log.warn('script held for a moment', { scriptId, kind, error: text, retryInMs: ms });
    this.notify(scriptId, hold);
    return new ScriptFault(scriptId, kind, reason, hold.retryAt, false);
  }

  /**
   * A live update timed out, not yet often enough for a fault. The isolate stays up, other
   * series are untouched; the series that timed out has to start over (`ScriptStrike`),
   * as the update may have left its state half-written.
   */
  private strike(scriptId: string, e: Entry, reason: string, text: string): ScriptStrike {
    const full = `${reason} (${e.strikes.length} of ${TICK_STRIKES} before it is held off)`;
    this.opts.log.warn('script update timed out, its series starts over', {
      scriptId,
      error: text,
      strikes: e.strikes.length,
    });
    return new ScriptStrike(scriptId, e.strikes.length, full);
  }

  /** The isolate is disposed and the script is held off, with a growing back-off. */
  private fault(
    scriptId: string,
    e: Entry,
    iso: IsolateHandle | null,
    kind: FaultKind,
    reason: string,
    text: string,
  ): ScriptFault {
    const now = this.opts.clock.now();
    this.drop(e, iso);
    e.strikes = [];
    e.usage = [];
    e.faults++;
    const wait = backoffMs(e.faults - 1, FAULT_RETRY_MIN_MS, FAULT_RETRY_MAX_MS);
    e.capFaults = wait >= FAULT_RETRY_MAX_MS ? e.capFaults + 1 : 0;
    const final = e.capFaults >= FINAL_AFTER_CAP_FAULTS;
    const full = final
      ? `${reason}; it kept failing, edit the script or restart the alert`
      : reason;
    const hold: ScriptHold = { reason: full, retryAt: now + wait, final };
    e.fault = hold;
    this.opts.log.warn('script isolate disposed', {
      scriptId,
      kind,
      error: text,
      retryInMs: wait,
      faults: e.faults,
      final,
    });
    this.notify(scriptId, hold);
    return new ScriptFault(scriptId, kind, full, hold.retryAt, final);
  }

  private drop(e: Entry, iso: IsolateHandle | null): void {
    iso?.dispose();
    if (iso === null || e.iso === iso) {
      e.iso?.dispose();
      e.iso = null;
      e.manifest = null;
    }
  }

  private notify(scriptId: string, hold: ScriptHold): void {
    for (const l of [...this.listeners]) {
      try {
        l(scriptId, hold.reason, hold);
      } catch (err) {
        this.opts.log.error('script fault listener failed', { scriptId, error: errText(err) });
      }
    }
  }

  /** Healthy for an hour since the isolate loaded: forget earlier faults. */
  private noteHealthy(e: Entry): void {
    if (e.faults > 0 && this.opts.clock.now() - e.healthySince >= HEALTHY_RESET_MS) {
      e.faults = 0;
      e.capFaults = 0;
    }
  }

  /**
   * CPU budgets, charged for live updates only (loads, full computes and Check are bounded
   * by the load limit; a burst of them is not a sign of a runaway script). Over a sliding 5
   * minute window, judged once 30 s of it have passed, an isolate may use `cpuPct` percent of
   * one CPU, and all isolates together `cpuTotalPct`; over the total, the isolate that used
   * the most is faulted. Returns the fault when it is `scriptId`'s own.
   */
  private chargeCpu(
    scriptId: string,
    e: Entry,
    iso: IsolateHandle,
    usedMs: number,
  ): ScriptFault | null {
    const now = this.opts.clock.now();
    e.usage.push({ t: now, ms: Math.max(0, usedMs) });
    const own = this.cpuUsed(e, now);
    const pct = this.opts.cpuPct ?? DEFAULT_CPU_PCT;
    if (own.span >= CPU_MIN_SPAN_MS && own.used / own.span > pct / 100) {
      const reason = `script used more than ${pct}% of a CPU over ${Math.round(own.span / 60_000)} min`;
      return this.fault(scriptId, e, iso, 'cpu', reason, cpuText(own));
    }
    const totalPct = this.opts.cpuTotalPct ?? DEFAULT_CPU_TOTAL_PCT;
    let total = 0;
    let top: { id: string; e: Entry; used: number } | null = null;
    for (const [id, other] of this.entries) {
      const u = this.cpuUsed(other, now).used;
      total += u;
      if (!top || u > top.used) top = { id, e: other, used: u };
    }
    const span = Math.min(CPU_WINDOW_MS, now - this.startedAt);
    if (!top || span < CPU_MIN_SPAN_MS || total / span <= totalPct / 100) return null;
    const reason = `scripts together used more than ${totalPct}% of a CPU over ${Math.round(span / 60_000)} min and this one used the most`;
    const f = this.fault(
      top.id,
      top.e,
      top.e.iso,
      'cpu',
      reason,
      `${Math.round(top.used)} of ${Math.round(total)} ms`,
    );
    return top.e === e ? f : null;
  }

  /** CPU spent in live updates within the window, and the span it covers. */
  private cpuUsed(e: Entry, now: number): { used: number; span: number } {
    const from = Math.max(e.healthySince, now - CPU_WINDOW_MS);
    e.usage = e.usage.filter((u) => u.t >= now - CPU_WINDOW_MS);
    let used = 0;
    for (const u of e.usage) if (u.t >= from) used += u.ms;
    return { used, span: now - from };
  }

  /**
   * The process the isolates live in crashed. Scripts with a call in flight were faulted by
   * their own failed calls; a crash nobody was running a call for cannot be attributed.
   * Three of those in 10 minutes hold every script (normal back-off), so a script that
   * crashes the process while idle cannot make it restart forever.
   */
  private crashed(info: CrashInfo, reason: string): void {
    const now = this.opts.clock.now();
    this.opts.log.warn('script runtime crashed', {
      reason,
      scripts: [...info.scripts],
      blame: info.blame,
    });
    if (this.disposed || info.cause === 'stopping') return;
    this.crashLog.push({ scripts: info.scripts });
    if (this.crashLog.length > 3) this.crashLog.shift();
    if (info.blame !== null) {
      // Killed for memory: the largest isolate is the culprit, in flight or not (a call of
      // its own in flight is faulted by that call's failure).
      const e = this.entries.get(info.blame);
      if (e?.iso && !info.scripts.has(info.blame))
        this.fault(
          info.blame,
          e,
          e.iso,
          'crash',
          `script held the most memory when the script runtime was stopped (${reason})`,
          reason,
        );
      return;
    }
    if (info.scripts.size > 0) return;
    this.unattributed = this.unattributed.filter((t) => now - t < TICK_STRIKE_WINDOW_MS);
    this.unattributed.push(now);
    if (this.unattributed.length < UNATTRIBUTED_CRASHES) return;
    this.unattributed = [];
    for (const [id, e] of [...this.entries])
      this.fault(id, e, e.iso, 'crash', 'the script runtime kept crashing', reason);
  }

  dispose(): void {
    this.disposed = true;
    for (const e of this.entries.values()) e.iso?.dispose();
    this.entries.clear();
    this.isolates.dispose();
  }
}
