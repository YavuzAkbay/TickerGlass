/** Dirty set of alert states, flushed with `PUT /alerts/states` (docs/alerts.md §3.5). */
import type { AlertRuntimeState } from '@tickerglass/alerts';
import { ApiError, type ApiClient } from './api';
import { errText, type Logger } from './log';

const CHUNK = 1000;

export class StateStore {
  private readonly dirty = new Map<string, { revision: number; get: () => AlertRuntimeState }>();

  constructor(
    private readonly api: Pick<ApiClient, 'putStates'>,
    private readonly log: Logger,
  ) {}

  get size(): number {
    return this.dirty.size;
  }

  mark(alertId: string, revision: number, get: () => AlertRuntimeState): void {
    this.dirty.set(alertId, { revision, get });
  }

  forget(alertId: string): void {
    this.dirty.delete(alertId);
  }

  private running: Promise<void> | null = null;
  private again = false;

  /**
   * Never throws: failures leave the rows dirty for the next flush. Flushes never overlap
   * (an older snapshot landing after a newer one would persist stale state): a call while one
   * is running queues one more pass and resolves when that pass is done.
   */
  flush(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    const run = (async () => {
      try {
        do {
          this.again = false;
          await this.flushOnce();
        } while (this.again);
      } finally {
        this.running = null;
      }
    })();
    this.running = run;
    return run;
  }

  private async flushOnce(): Promise<void> {
    if (this.dirty.size === 0) return;
    const batch = [...this.dirty].map(([alertId, d]) => ({
      alertId,
      revision: d.revision,
      state: d.get(),
      src: d,
    }));
    for (let i = 0; i < batch.length; i += CHUNK) {
      const chunk = batch.slice(i, i + CHUNK);
      try {
        await this.api.putStates(
          chunk.map(({ alertId, revision, state }) => ({ alertId, revision, state })),
        );
      } catch (err) {
        if (err instanceof ApiError && isPermanent(err.status)) {
          // Retrying can never succeed (e.g. 413/422): drop the chunk instead of starving the rest.
          this.log.error('state flush rejected, dropping chunk', {
            error: errText(err),
            status: err.status,
            alerts: chunk.length,
          });
        } else {
          this.log.warn('state flush failed', { error: errText(err) });
          return;
        }
      }
      for (const c of chunk) if (this.dirty.get(c.alertId) === c.src) this.dirty.delete(c.alertId);
    }
  }
}

/**
 * A 4xx about the payload itself fails identically on retry. Auth / routing errors (401, 403,
 * 404: token rotation, API mid-deploy), request-timeout and rate-limit are not about the payload:
 * keep the rows and retry.
 */
const isPermanent = (status: number): boolean =>
  status >= 400 && status < 500 && ![401, 403, 404, 408, 429].includes(status);
