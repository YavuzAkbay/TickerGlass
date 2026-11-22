/**
 * Counters and the evaluation-lag histogram the heartbeat carries as `metrics`
 * (docs/design/metrics.md §6). One instance per service, passed to whoever counts: no
 * module state, so two services (tests) never share numbers.
 */
import type { ServiceMetricsSnapshot } from '@tickerglass/alerts';

export type MetricsSnapshot = ServiceMetricsSnapshot;

/** Upper bounds of the lag histogram, seconds (fixed by the heartbeat contract). */
export const LAG_BUCKETS: readonly number[] = [0.25, 0.5, 1, 2, 5, 10, 30, 60, 120, 300];

export class ServiceMetrics {
  /** Runner evaluation passes (seed, tick, bar close, poll). */
  evaluations = 0;
  /** `runnerFailure` calls. */
  evaluationFailures = 0;
  /** `enqueueFire` calls. */
  firesQueued = 0;
  /** Fire sends that failed and will be retried. */
  fireRetries = 0;
  /** Fires the API rejected with 404/422. */
  firesDropped = 0;
  statusPostFailures = 0;
  /** Fault events from the script host. */
  scriptFaults = 0;

  private readonly lagCounts: number[] = LAG_BUCKETS.map(() => 0);
  private lagCount = 0;
  private lagSum = 0;

  /** Record one lag observation (seconds); negative and non-finite values count as 0. */
  observeLag(seconds: number): void {
    const s = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
    for (let i = 0; i < LAG_BUCKETS.length; i++) if (s <= LAG_BUCKETS[i]!) this.lagCounts[i]!++;
    this.lagCount++;
    this.lagSum += s;
  }

  /** Lag of an evaluation that was due at `dueMs` and finished at `doneMs` (clock ms). */
  observeLagMs(dueMs: number, doneMs: number): void {
    this.observeLag((doneMs - dueMs) / 1000);
  }

  snapshot(fireQueueDepth: number): MetricsSnapshot {
    return {
      evaluations: this.evaluations,
      evaluationFailures: this.evaluationFailures,
      firesQueued: this.firesQueued,
      fireRetries: this.fireRetries,
      firesDropped: this.firesDropped,
      fireQueueDepth,
      statusPostFailures: this.statusPostFailures,
      scriptFaults: this.scriptFaults,
      lag: {
        buckets: [...LAG_BUCKETS],
        counts: [...this.lagCounts],
        count: this.lagCount,
        sum: this.lagSum,
      },
    };
  }
}
