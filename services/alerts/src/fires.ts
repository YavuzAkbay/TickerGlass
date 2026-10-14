/**
 * Fire queue (docs/alerts.md §3.1): `POST /fire` with the same `fireId` until
 * 2xx, 409 (drop and reload the alert) or 404/422 (drop); in order per alert.
 */
import type { AlertLogEntry } from '@investopen/alerts';
import { ApiError, type ApiClient } from './api';
import { backoffMs, jitter, type Clock } from './clock';
import { errText, type Logger } from './log';
import type { FireJob } from './alert-runner';

export interface FireQueueOptions {
  api: Pick<ApiClient, 'fire'>;
  clock: Clock;
  log: Logger;
  /** The API rejected the fire as stale (409) or the alert is gone: reload it. */
  onConflict: (alertId: string, reason: 'conflict' | 'gone' | 'invalid') => void;
  onFired?: (job: FireJob, entry: AlertLogEntry) => void;
  onError?: (message: string) => void;
}

export class FireQueue {
  private readonly queues = new Map<string, FireJob[]>();
  private readonly running = new Set<string>();
  private readonly cancels = new Set<() => void>();
  private stopped = false;
  private idle: (() => void)[] = [];

  constructor(private readonly o: FireQueueOptions) {}

  get pending(): number {
    let n = 0;
    for (const q of this.queues.values()) n += q.length;
    return n;
  }

  enqueue(job: FireJob): void {
    if (this.stopped) return;
    const q = this.queues.get(job.alertId) ?? [];
    q.push(job);
    this.queues.set(job.alertId, q);
    if (!this.running.has(job.alertId)) void this.drain(job.alertId);
  }

  /** Queued (unacknowledged) jobs of an alert, oldest first. */
  pendingFor(alertId: string): readonly FireJob[] {
    return this.queues.get(alertId) ?? [];
  }

  /** Drop queued fires of an alert (it was edited or detached). */
  drop(alertId: string): void {
    const q = this.queues.get(alertId);
    if (q) q.length = 0;
  }

  /** Resolves when nothing is queued or in flight. */
  whenIdle(): Promise<void> {
    if (this.running.size === 0) return Promise.resolve();
    return new Promise((r) => this.idle.push(r));
  }

  stop(): void {
    this.stopped = true;
    for (const c of [...this.cancels]) c();
    this.cancels.clear();
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const cancel = this.o.clock.setTimeout(() => {
        this.cancels.delete(stop);
        resolve();
      }, ms);
      const stop = () => {
        cancel();
        resolve();
      };
      this.cancels.add(stop);
    });
  }

  private async drain(alertId: string): Promise<void> {
    this.running.add(alertId);
    try {
      for (;;) {
        const q = this.queues.get(alertId);
        const job = q?.[0];
        if (!q || !job || this.stopped) break;
        const res = await this.send(job);
        // Stopped mid-send: keep the job queued so it is persisted with the state.
        if (res === 'stopped') break;
        // The queue may have been cleared (drop) while sending.
        if (q[0] === job) q.shift();
        // A rejected job only invalidates jobs of its own or an older revision.
        if (res === 'gone') q.length = 0;
        else if (res === 'stale') {
          for (let i = q.length - 1; i >= 0; i--)
            if (q[i]!.revision <= job.revision) q.splice(i, 1);
        }
      }
    } finally {
      this.running.delete(alertId);
      if (!this.queues.get(alertId)?.length) this.queues.delete(alertId);
      if (this.running.size === 0) {
        const done = this.idle;
        this.idle = [];
        for (const r of done) r();
      }
    }
  }

  private async send(job: FireJob): Promise<'ok' | 'stale' | 'gone' | 'stopped'> {
    for (let attempt = 0; !this.stopped; attempt++) {
      try {
        const entry = await this.o.api.fire(job.alertId, job.body);
        this.o.onFired?.(job, entry);
        return 'ok';
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          this.o.log.info('fire rejected (stale), reloading', { alertId: job.alertId });
          this.o.onConflict(job.alertId, 'conflict');
          return 'stale';
        }
        if (err instanceof ApiError && (err.status === 404 || err.status === 422)) {
          this.o.log.warn('fire dropped', {
            alertId: job.alertId,
            status: err.status,
            error: err.message,
          });
          this.o.onConflict(job.alertId, err.status === 404 ? 'gone' : 'invalid');
          return err.status === 404 ? 'gone' : 'stale';
        }
        this.o.onError?.(errText(err));
        this.o.log.warn('fire failed, will retry', { alertId: job.alertId, error: errText(err) });
        await this.wait(jitter(backoffMs(attempt, 1000, 60_000)));
      }
    }
    return 'stopped';
  }
}
