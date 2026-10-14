/** Dirty set of alert states, flushed with `PUT /alerts/states` (docs/alerts.md §3.5). */
import type { AlertRuntimeState } from '@investopen/alerts';
import type { ApiClient } from './api';
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

  /** Never throws: failures leave the rows dirty for the next flush. */
  async flush(): Promise<void> {
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
        for (const c of chunk)
          if (this.dirty.get(c.alertId) === c.src) this.dirty.delete(c.alertId);
      } catch (err) {
        this.log.warn('state flush failed', { error: errText(err) });
        return;
      }
    }
  }
}
