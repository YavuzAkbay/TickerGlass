/**
 * Isolates in a child process (`child.ts`), reached over IPC. `isolated-vm`'s memory limit
 * is a guideline: a script that grows a `Set` or an object without bound, or fills the
 * kept-alive list of `WeakRef`s, makes V8 abort the whole process with a fatal out-of-memory
 * that no limit or handler can stop. With the isolates in a child that is the child's death;
 * the service (alerts of built-in indicators, fault state, back-off) lives on.
 *
 * The parent restarts the child lazily (back-off 1 s up to 30 s), pings it every 5 s (no
 * answer within 10 s: SIGKILL; resident memory over `processMb`: SIGKILL, which also covers
 * allocations outside every heap limit), and rejects every call in flight with
 * `ScriptCrashed` when it dies, which the host turns into a fault of those scripts.
 */
import { fork, type ChildProcess } from 'node:child_process';
import { backoffMs } from '../clock';
import { errText, type Logger } from '../log';
import { parseFromChild, type FromChild, type ToChild } from './childProtocol';
import { ScriptCapacity, ScriptCrashed, ScriptSuperseded, type CrashInfo } from './errors';
import { closeHandle, type CallResult, type IsolateFactory, type IsolateHandle } from './isolates';

export const PING_MS = 5000;
export const PONG_TIMEOUT_MS = 10_000;
export const RESTART_MIN_MS = 1000;
export const RESTART_MAX_MS = 30_000;
const START_TIMEOUT_MS = 30_000;
/** A child that lived this long was healthy: its death starts the back-off over. */
const HEALTHY_MS = 60_000;

export interface ProcessOptions {
  /** The built child entry (`dist/scripthost.js`, or built on demand in dev and tests). */
  entry: () => Promise<string>;
  /** Resident memory cap of the child (MB), also its `--max-old-space-size`. */
  processMb: number;
  log: Logger;
  pingMs?: number;
  pongTimeoutMs?: number;
  restartMinMs?: number;
  restartMaxMs?: number;
  /** An isolate unused this long may be given up to make room for another (default 60 s). */
  evictIdleMs?: number;
}

const MB = 1024 * 1024;
/** Fraction of `processMb` the isolates may take before room is made (or refused). */
const FILL = 0.85;
/** Rough size of an isolate with a 5000-bar series, until measurements say otherwise. */
const ISOLATE_MB = 18;
/** The child itself, before any isolate. */
const BASE_MB = 50;
const EVICT_IDLE_MS = 60_000;

/** The isolate (or its call) failed inside the child; `dead`: the isolate is gone. */
class RemoteCallError extends Error {
  constructor(
    message: string,
    readonly dead: boolean,
  ) {
    super(message);
    this.name = 'RemoteCallError';
  }
}

interface Pending {
  resolve(v: FromChild): void;
  reject(err: unknown): void;
  /** The script the request is for. */
  label: string | null;
}

class RemoteIsolate implements IsolateHandle {
  disposed = false;
  crashed = false;
  private dead = false;

  lastUsed = Date.now();
  inflight = 0;

  constructor(
    private readonly owner: ProcessIsolates,
    readonly id: number,
    readonly label: string | null,
  ) {}

  get isDead(): boolean {
    return this.disposed || this.dead || this.crashed;
  }

  get died(): boolean {
    return !this.disposed && (this.dead || this.crashed);
  }

  async callAsync(name: string, args: unknown[], timeoutMs: number): Promise<CallResult> {
    if (this.crashed) throw new ScriptSuperseded(this.label ?? '');
    if (this.isDead) throw new Error('Isolate is disposed');
    this.inflight++;
    try {
      const r = await this.owner.request(
        { t: 'call', iso: this.id, name, args, timeoutMs },
        this.label,
      );
      if (r.t !== 'result') throw new ScriptCrashed('unexpected answer from the script runtime');
      return { raw: r.raw, cpuMs: r.cpuMs };
    } catch (err) {
      if (err instanceof RemoteCallError && err.dead) this.dead = true;
      throw err;
    } finally {
      this.inflight--;
      this.lastUsed = Date.now();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.owner.release(this);
  }
}

export class ProcessIsolates implements IsolateFactory {
  onCrash: ((info: CrashInfo, reason: string) => void) | undefined;

  private child: ChildProcess | null = null;
  private starting: Promise<void> | null = null;
  private disposed = false;
  private nextRid = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly live = new Set<RemoteIsolate>();
  private consecutiveCrashes = 0;
  private nextSpawnAt = 0;
  private startedAt = 0;
  private killReason: string | null = null;
  private stderrTail = '';
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pingSentAt: number | null = null;
  private crashes = 0;
  private killCause: CrashInfo['cause'] | null = null;
  private killBlame: string | null = null;
  /** Child resident memory (bytes) at the last pong, and heap + external bytes per isolate. */
  private lastRss = 0;
  private sizes = new Map<number, number>();
  private evictedSincePong = 0;
  private handshake: { resolve(): void; reject(err: Error): void } | null = null;

  constructor(private readonly opts: ProcessOptions) {}

  /** Start the child (and fail if it cannot load `isolated-vm`). */
  async probe(): Promise<void> {
    await this.ensureChild();
  }

  async create(memoryMb: number, loadMs: number, label?: string): Promise<IsolateHandle> {
    await this.ensureChild();
    this.makeRoom();
    const r = await this.request({ t: 'create', memoryMb, loadMs }, label ?? null);
    if (r.t !== 'created') throw new ScriptCrashed('unexpected answer from the script runtime');
    const iso = new RemoteIsolate(this, r.iso, label ?? null);
    this.live.add(iso);
    return iso;
  }

  /**
   * Another isolate must fit under `FILL` of `processMb`: otherwise the isolate least recently
   * used (and idle for a while) is given up, its series rebuild when next needed; with none to
   * give up the request is refused (`ScriptCapacity`), so the child is never driven into the
   * memory kill by the number of scripts alone.
   */
  private makeRoom(): void {
    const limit = this.opts.processMb * FILL;
    const idleMs = this.opts.evictIdleMs ?? EVICT_IDLE_MS;
    const measured = [...this.sizes.values()];
    const each = Math.max(
      ISOLATE_MB,
      measured.length ? measured.reduce((a, b) => a + b, 0) / measured.length / MB : 0,
    );
    const used = () =>
      Math.max(this.lastRss / MB - this.evictedSincePong * each, BASE_MB + this.live.size * each);
    while (used() + each > limit) {
      const now = Date.now();
      let victim: RemoteIsolate | null = null;
      for (const iso of this.live)
        if (
          iso.inflight === 0 &&
          now - iso.lastUsed >= idleMs &&
          (!victim || iso.lastUsed < victim.lastUsed)
        )
          victim = iso;
      if (!victim) throw new ScriptCapacity();
      this.opts.log.info('script isolate given up to make room', { script: victim.label });
      victim.dispose();
      this.evictedSincePong++;
    }
  }

  /** Test hook: the running child process. */
  get process(): ChildProcess | null {
    return this.child;
  }

  dispose(): void {
    this.disposed = true;
    this.stopPing();
    const child = this.child;
    this.child = null;
    child?.kill('SIGKILL');
    this.failPending(new ScriptCrashed('the script runtime is stopping'));
  }

  // ------------------------------------------------------------- requests

  request(
    msg: DistributiveOmit<Extract<ToChild, { rid: number }>, 'rid'>,
    label: string | null,
  ): Promise<FromChild> {
    const child = this.child;
    if (!child || !child.connected)
      return Promise.reject(new ScriptCrashed('the script runtime is not running'));
    const rid = this.nextRid++;
    return new Promise((resolve, reject) => {
      this.pending.set(rid, { resolve, reject, label });
      child.send({ ...msg, rid }, (err) => {
        if (!err) return;
        this.pending.delete(rid);
        reject(new ScriptCrashed(`could not reach the script runtime: ${err.message}`));
      });
    });
  }

  /** An isolate was disposed by the host: tell the child (it is gone with the child otherwise). */
  release(iso: RemoteIsolate): void {
    this.live.delete(iso);
    const child = this.child;
    if (!child || !child.connected || iso.crashed) return;
    child.send({ t: 'dispose', iso: iso.id } satisfies ToChild, () => undefined);
  }

  // ---------------------------------------------------------------- child

  private async ensureChild(): Promise<void> {
    if (this.disposed) throw new ScriptCrashed('the script runtime is stopping');
    if (this.child) return;
    this.starting ??= this.start().finally(() => {
      this.starting = null;
    });
    await this.starting;
  }

  private async start(): Promise<void> {
    const wait = this.nextSpawnAt - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    if (this.disposed) throw new ScriptCrashed('the script runtime is stopping');
    const entry = await this.opts.entry();
    const child = fork(entry, [], {
      // `isolated-vm` needs --no-node-snapshot (Node 20+); the old-space cap bounds the child's
      // own JS heap, the isolates' memory is bounded by the resident-memory check below.
      execArgv: ['--no-node-snapshot', `--max-old-space-size=${this.opts.processMb}`],
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: {},
    });
    this.stderrTail = '';
    this.killReason = null;
    this.killCause = null;
    this.killBlame = null;
    this.lastRss = 0;
    this.sizes.clear();
    this.evictedSincePong = 0;
    this.pingSentAt = null;
    child.stderr?.on('data', (d: Buffer) => {
      this.stderrTail = (this.stderrTail + d.toString()).slice(-1500);
    });
    child.on('message', (m: unknown, handle?: unknown) => {
      closeHandle(handle); // the child has no business sending handles
      this.onMessage(child, m);
    });
    child.on('exit', (code, signal) => this.onExit(child, code, signal));
    child.on('error', (err) => {
      this.opts.log.warn('script runtime process error', { error: errText(err) });
    });
    const ready = new Promise<void>((resolve, reject) => {
      this.handshake = { resolve, reject };
    });
    this.child = child;
    const timer = setTimeout(
      () => this.kill(child, 'did not start in time', 'exit'),
      START_TIMEOUT_MS,
    );
    try {
      await ready;
    } catch (err) {
      this.kill(child, 'failed to start', 'exit');
      throw err instanceof Error ? err : new Error(errText(err));
    } finally {
      clearTimeout(timer);
      this.handshake = null;
    }
    this.startedAt = Date.now();
    this.startPing(child);
  }

  private onMessage(child: ChildProcess, raw: unknown): void {
    if (child !== this.child) return;
    const m = parseFromChild(raw);
    if (!m) {
      // A child that sends what it never would is broken (or taken over): do not keep it.
      this.opts.log.warn('script runtime sent a malformed message');
      this.kill(child, 'sent a malformed message', 'protocol');
      return;
    }
    switch (m.t) {
      case 'ready':
        this.handshake?.resolve();
        return;
      case 'fatal':
        this.handshake?.reject(new Error(m.message));
        return;
      case 'pong': {
        this.pingSentAt = null;
        this.lastRss = m.rss;
        this.evictedSincePong = 0;
        this.sizes = new Map(m.isolates.map((i) => [i.iso, i.bytes]));
        if (m.rss > this.opts.processMb * MB)
          this.kill(
            child,
            `used ${Math.round(m.rss / MB)} MB of memory, over its ${this.opts.processMb} MB limit`,
            'memory',
            this.largest(),
          );
        return;
      }
      case 'created':
      case 'result':
      case 'err': {
        const p = this.pending.get(m.rid);
        if (!p) return; // the host stopped waiting (watchdog) or the call was never made
        this.pending.delete(m.rid);
        if (m.t === 'err') p.reject(new RemoteCallError(m.message, m.dead));
        else p.resolve(m);
        return;
      }
    }
  }

  /** The script whose isolate holds the most memory, by the last measurements. */
  private largest(): string | null {
    let best: { bytes: number; label: string | null } | null = null;
    for (const iso of this.live) {
      const bytes = this.sizes.get(iso.id);
      if (bytes !== undefined && (!best || bytes > best.bytes)) best = { bytes, label: iso.label };
    }
    return best?.label ?? null;
  }

  private onExit(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (child !== this.child) {
      // Killed on purpose after it was replaced or the host stopped.
      return;
    }
    this.child = null;
    this.stopPing();
    const how = signal ? `killed by ${signal}` : `exited with code ${code ?? '?'}`;
    const text = this.killReason ? `${how}: ${this.killReason}` : how;
    const lived = Date.now() - this.startedAt;
    this.consecutiveCrashes =
      lived >= HEALTHY_MS && this.startedAt > 0 ? 1 : this.consecutiveCrashes + 1;
    this.nextSpawnAt =
      Date.now() +
      backoffMs(
        this.consecutiveCrashes - 1,
        this.opts.restartMinMs ?? RESTART_MIN_MS,
        this.opts.restartMaxMs ?? RESTART_MAX_MS,
      );
    this.startedAt = 0;
    for (const iso of this.live) iso.crashed = true;
    this.live.clear();
    const scripts = new Set<string>();
    for (const p of this.pending.values()) if (p.label !== null) scripts.add(p.label);
    const inflight = this.pending.size;
    const info: CrashInfo = {
      id: ++this.crashes,
      scripts,
      blame: this.killBlame,
      cause: this.disposed ? 'stopping' : (this.killCause ?? 'exit'),
    };
    this.handshake?.reject(new ScriptCrashed(`the script runtime ${text}`, info));
    this.failPending(new ScriptCrashed(`the script runtime ${text}`, info));
    if (!this.disposed) {
      this.opts.log.warn('script runtime process ended', {
        reason: text,
        inflight,
        scripts: [...scripts],
        blame: info.blame,
        stderr: this.stderrTail.trim().split('\n').slice(-6).join(' | ').slice(0, 600),
      });
      this.onCrash?.(info, text);
    }
  }

  private failPending(err: ScriptCrashed): void {
    const all = [...this.pending.values()];
    this.pending.clear();
    for (const p of all) p.reject(err);
  }

  private kill(
    child: ChildProcess,
    why: string,
    cause: CrashInfo['cause'],
    blame: string | null = null,
  ): void {
    if (child === this.child && this.killReason === null) {
      this.killReason = why;
      this.killCause = cause;
      this.killBlame = blame;
    }
    child.kill('SIGKILL');
  }

  // ----------------------------------------------------------------- ping

  private startPing(child: ChildProcess): void {
    this.stopPing();
    const every = this.opts.pingMs ?? PING_MS;
    const limit = this.opts.pongTimeoutMs ?? PONG_TIMEOUT_MS;
    this.pingTimer = setInterval(() => {
      if (child !== this.child) return;
      const now = Date.now();
      if (this.pingSentAt !== null) {
        if (now - this.pingSentAt >= limit)
          this.kill(
            child,
            `did not answer for ${Math.round((now - this.pingSentAt) / 1000)} s`,
            'ping',
          );
        return;
      }
      this.pingSentAt = now;
      child.send({ t: 'ping' } satisfies ToChild, () => undefined);
    }, every);
    this.pingTimer.unref();
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.pingSentAt = null;
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
