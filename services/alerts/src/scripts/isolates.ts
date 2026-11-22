/**
 * Where script isolates live. `ScriptHost` (fault state, validation, budgets) talks to
 * `IsolateFactory` / `IsolateHandle` only: `LocalIsolates` run `isolated-vm` isolates in
 * this process (the script child process uses them, and so do host tests);
 * `ProcessIsolates` (`remoteIsolates.ts`) reach them over IPC in a child process, so that a
 * script that makes V8 abort the process (fatal out-of-memory, not covered by `memoryLimit`)
 * takes down the child and not the service.
 */
import type IsolatedVM from 'isolated-vm';
import { ScriptCallError, type CrashInfo } from './errors';
import { API_NAMES, type IsolateApi } from './protocol';

/** The `isolated-vm` module (loaded lazily: a missing native binary only disables scripts). */
export type Ivm = typeof IsolatedVM;

/** The result of one call into an isolate: the raw envelope, and the CPU time the call used. */
export interface CallResult {
  raw: unknown;
  cpuMs: number;
}

export interface IsolateHandle {
  /** Disposed by the host on purpose (edit, delete, stop, fault handling). */
  readonly disposed: boolean;
  /** The isolate is gone (disposed by the host, died: memory limit, or its process crashed). */
  readonly isDead: boolean;
  /** The isolate died by itself, not because the host disposed it. */
  readonly died: boolean;
  /** Enforces `timeoutMs` for the script's own run; rejects with the isolate's error. */
  callAsync(name: string, args: unknown[], timeoutMs: number): Promise<CallResult>;
  dispose(): void;
}

export interface IsolateFactory {
  /** `label`: the script the isolate is for (the process manager blames scripts by it). */
  create(memoryMb: number, loadMs: number, label?: string): Promise<IsolateHandle>;
  /** Called after the isolates' process died: what was in flight at that moment, who is to blame, and why. */
  onCrash?: ((info: CrashInfo, reason: string) => void) | undefined;
  dispose(): void;
}

type Fn = IsolatedVM.Reference<(...args: unknown[]) => unknown>;

/** One live `isolated-vm` isolate with the API object's functions as references. */
export class LocalIsolate implements IsolateHandle {
  private readonly fns = new Map<string, Fn>();
  disposed = false;

  private constructor(private readonly isolate: IsolatedVM.Isolate) {}

  static async create(
    ivm: Ivm,
    bundle: string,
    memoryMb: number,
    loadMs: number,
  ): Promise<LocalIsolate> {
    const self = new LocalIsolate(new ivm.Isolate({ memoryLimit: memoryMb }));
    try {
      const context = await self.isolate.createContext();
      const script = await self.isolate.compileScript(bundle);
      await script.run(context, { timeout: loadMs });
      const api = (await context.global.get('__tg', {
        reference: true,
      })) as IsolatedVM.Reference<IsolateApi>;
      // From here on only the host holds the API: the script cannot reach it.
      await context.global.delete('__tg');
      for (const name of API_NAMES)
        self.fns.set(name, (await api.get(name, { reference: true })) as unknown as Fn);
    } catch (err) {
      self.dispose();
      throw err;
    }
    return self;
  }

  get isDead(): boolean {
    return this.disposed || this.isolate.isDisposed;
  }

  get died(): boolean {
    return !this.disposed && this.isolate.isDisposed;
  }

  private cpuMs(): number {
    try {
      return Number(this.isolate.cpuTime) / 1e6;
    } catch {
      return 0;
    }
  }

  /** Heap in use plus external memory (bytes), or null when the isolate does not answer in `waitMs`. */
  async heapBytes(waitMs: number): Promise<number | null> {
    if (this.isDead) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const stats = await Promise.race([
        this.isolate.getHeapStatistics(),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), waitMs);
        }),
      ]);
      return stats ? stats.used_heap_size + stats.externally_allocated_size : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async callAsync(name: string, args: unknown[], timeoutMs: number): Promise<CallResult> {
    const fn = this.fns.get(name);
    if (!fn) throw new ScriptCallError(`unknown isolate function '${name}'`);
    const cpu0 = this.cpuMs();
    const raw = await fn.apply(undefined, args, {
      arguments: { copy: true },
      result: { copy: true },
      timeout: timeoutMs,
    });
    return { raw, cpuMs: Math.max(0, this.cpuMs() - cpu0) };
  }

  dispose(): void {
    this.disposed = true;
    this.fns.clear();
    try {
      if (!this.isolate.isDisposed) this.isolate.dispose();
    } catch {
      // already gone
    }
  }
}

/** Isolates in this process. */
export class LocalIsolates implements IsolateFactory {
  constructor(
    private readonly ivm: Ivm,
    private readonly bundle: string,
  ) {}

  create(memoryMb: number, loadMs: number, _label?: string): Promise<IsolateHandle> {
    return LocalIsolate.create(this.ivm, this.bundle, memoryMb, loadMs);
  }

  dispose(): void {}
}

/** Close a handle (socket, server ...) that arrived with a message nobody asked for. */
export function closeHandle(handle: unknown): void {
  if (typeof handle !== 'object' || handle === null) return;
  const h = handle as { close?: () => void; destroy?: () => void };
  try {
    if (typeof h.destroy === 'function') h.destroy();
    else if (typeof h.close === 'function') h.close();
  } catch {
    // already closed
  }
}
