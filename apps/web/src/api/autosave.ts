/**
 * Debounced, serialized saving with flush on page hide and conflict hooks
 * (docs/persistence.md §Autosave).
 */
import { isRetryable, type ApiError } from './client';
import { isConflict, saveLayout } from './persistence';
import type { Layout } from './types';

type Listenable = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

export interface SaveContext {
  /** True when flushing because the page is being hidden/unloaded. */
  keepalive: boolean;
}

export interface AutosaverOptions<T> {
  /** Debounce in ms (default 1000). */
  delay?: number;
  /**
   * First retry delay after a retryable failure (`isRetryable`: offline, 5xx,
   * 408, 429) in ms, doubling per consecutive failure up to `maxRetryDelay`;
   * 0 = no automatic retry (default 5000).
   */
  retryDelay?: number;
  /** Cap of the retry backoff in ms (default 60000). */
  maxRetryDelay?: number;
  /** A save failed with 409. The value is dropped; reschedule it to retry (e.g. after rebasing). */
  onConflict?: (err: ApiError, value: T) => void;
  /**
   * A save failed otherwise. Retryable errors keep the value pending (and
   * retry); others (404, 422, ...) drop it: saving it again would fail the same way.
   */
  onError?: (err: unknown, value: T) => void;
  /**
   * The page is being hidden with a value still unsaved (called before the
   * flush starts, synchronously). Write a recovery copy (e.g. localStorage):
   * the flush may not complete, and keepalive requests are limited to 64 KB.
   */
  onHide?: (value: T) => void;
  onSaved?: (value: T) => void;
  /** `pagehide` source (default `window`). */
  window?: Listenable;
  /** `visibilitychange` source (default `document`); flushes when hidden. */
  document?: Listenable & { visibilityState?: DocumentVisibilityState };
}

export interface Autosaver<T> {
  /** Replace the pending value and restart the debounce timer. */
  schedule: (value: T) => void;
  /** Save the pending value now; resolves once it (and any save in flight) settled. */
  flush: (ctx?: Partial<SaveContext>) => Promise<void>;
  /** Drop the pending value. */
  cancel: () => void;
  /** Flush and stop listening for page hide. */
  dispose: () => Promise<void>;
  /** A value is waiting to be saved (or failed and awaits retry). */
  readonly pending: boolean;
  readonly saving: boolean;
}

/**
 * Debounced saves of the latest scheduled value. Saves never overlap (a value
 * scheduled while one is in flight is saved after it), so revision chains stay
 * ordered. On `pagehide` pending work is flushed with `keepalive: true` (pass
 * it to fetch: `requestJson(..., { keepalive })`, which drops it for bodies
 * over 60 KB); on hidden visibility with a normal request. Both call `onHide`
 * first so the caller can keep a recovery copy.
 */
export function createAutosaver<T>(
  save: (value: T, ctx: SaveContext) => Promise<void>,
  opts: AutosaverOptions<T> = {},
): Autosaver<T> {
  const delay = opts.delay ?? 1000;
  const retryDelay = opts.retryDelay ?? 5000;
  const maxRetryDelay = opts.maxRetryDelay ?? 60_000;
  let failures = 0;
  let disposed = false;
  const win = opts.window ?? (globalThis.window as Listenable | undefined);
  const doc = opts.document ?? (globalThis.document as AutosaverOptions<T>['document']);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let has = false;
  let value: T | undefined;
  let saving = false;
  let chain: Promise<void> = Promise.resolve();

  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const arm = (ms: number) => {
    clear();
    if (disposed) return;
    timer = setTimeout(() => void run({ keepalive: false }), ms);
  };

  const step = async (ctx: SaveContext) => {
    if (!has) return;
    const v = value as T;
    has = false;
    value = undefined;
    saving = true;
    try {
      await save(v, ctx);
      failures = 0;
      opts.onSaved?.(v);
    } catch (err) {
      if (isConflict(err)) {
        failures = 0;
        opts.onConflict?.(err, v);
      } else if (isRetryable(err)) {
        failures++;
        if (!has) {
          // Keep it for the next flush/retry unless something newer replaced it.
          has = true;
          value = v;
          if (retryDelay > 0 && !timer)
            arm(Math.min(maxRetryDelay, retryDelay * 2 ** (failures - 1)));
        }
        opts.onError?.(err, v);
      } else {
        // Permanent (4xx): drop it; a newer scheduled value is still saved.
        failures = 0;
        opts.onError?.(err, v);
      }
    } finally {
      saving = false;
    }
  };

  const run = (ctx: SaveContext): Promise<void> => {
    clear();
    chain = chain.then(() => step(ctx));
    return chain;
  };

  const recover = () => {
    if (has) opts.onHide?.(value as T);
  };
  // Page going away: keepalive lets the request outlive it (small bodies only).
  const onPageHide = () => {
    recover();
    void run({ keepalive: true });
  };
  // Tab switched away: the page lives on, so a normal request is fine.
  const onVisibility = () => {
    if (doc?.visibilityState !== 'hidden') return;
    recover();
    void run({ keepalive: false });
  };
  win?.addEventListener('pagehide', onPageHide);
  doc?.addEventListener('visibilitychange', onVisibility);

  return {
    schedule: (v) => {
      has = true;
      value = v;
      arm(delay);
    },
    flush: (ctx) => run({ keepalive: ctx?.keepalive ?? false }),
    cancel: () => {
      clear();
      has = false;
      value = undefined;
    },
    dispose: () => {
      disposed = true;
      win?.removeEventListener('pagehide', onPageHide);
      doc?.removeEventListener('visibilitychange', onVisibility);
      return run({ keepalive: false });
    },
    get pending() {
      return has;
    },
    get saving() {
      return saving;
    },
  };
}

export interface LayoutAutosaver<S> extends Autosaver<S> {
  readonly id: string;
  /** Revision the next save is based on. */
  readonly revision: number;
  /** After resolving a conflict: base the next save on `revision` (e.g. the server's). */
  setRevision: (revision: number) => void;
}

/**
 * Autosave one layout's state with optimistic concurrency. Each successful
 * save advances `revision`; a 409 calls `onConflict` (use `layoutConflict(err)`
 * for the server copy): to keep local, `setRevision(server.revision)` and
 * `schedule(state)`; to take theirs, apply the server state and `setRevision`.
 */
export function createLayoutAutosaver<S>(
  layout: Pick<Layout, 'id' | 'revision'>,
  opts: Omit<AutosaverOptions<S>, 'onSaved'> & {
    schemaVersion?: number;
    onSaved?: (layout: Layout<S>) => void;
    /** The PUT call (default `saveLayout`; tests inject a fake server). */
    save?: typeof saveLayout;
  } = {},
): LayoutAutosaver<S> {
  let revision = layout.revision;
  const { onSaved, schemaVersion, save = saveLayout, ...rest } = opts;
  const saver = createAutosaver<S>(async (state, { keepalive }) => {
    const saved = await save<S>(
      layout.id,
      { state, revision, ...(schemaVersion !== undefined ? { schemaVersion } : {}) },
      { keepalive },
    );
    revision = saved.revision;
    onSaved?.(saved);
  }, rest);
  return {
    schedule: saver.schedule,
    flush: saver.flush,
    cancel: saver.cancel,
    dispose: saver.dispose,
    get pending() {
      return saver.pending;
    },
    get saving() {
      return saver.saving;
    },
    id: layout.id,
    get revision() {
      return revision;
    },
    setRevision: (r: number) => {
      revision = r;
    },
  };
}
