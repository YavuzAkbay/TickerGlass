/** `POST /alerts/service/heartbeat` every 30 s (docs/alerts.md §3.1). */
import type { ServiceHeartbeat } from '@tickerglass/alerts';
import { ApiError, type ApiClient } from './api';
import type { Clock } from './clock';
import { errText, type Logger } from './log';
import type { MetricsSnapshot } from './metrics';

export const HEARTBEAT_MS = 30_000;

export interface HeartbeatStats {
  series: number;
  liveSymbols: number;
  polledSeries: number;
  lastError: string | null;
  waiting: { alertId: string; reason: string; resumeAt: number }[];
  metrics: MetricsSnapshot;
}

/** The most waiting alerts one heartbeat carries (the API accepts 500). */
const MAX_WAITING = 200;

export class Heartbeat {
  private cancel: (() => void) | null = null;
  /** The API rejected a heartbeat with `metrics` (422): an older API, so stop sending them. */
  private metricsRejected = false;

  constructor(
    private readonly api: Pick<ApiClient, 'heartbeat'>,
    private readonly clock: Clock,
    private readonly log: Logger,
    private readonly stats: () => HeartbeatStats,
    private readonly version: string,
    private readonly startedAt: number,
  ) {}

  start(): void {
    void this.beat();
    this.cancel = this.clock.setInterval(() => void this.beat(), HEARTBEAT_MS);
  }

  stop(): void {
    this.cancel?.();
    this.cancel = null;
  }

  async beat(): Promise<void> {
    const s = this.stats();
    const hb: ServiceHeartbeat = {
      version: this.version,
      startedAt: new Date(this.startedAt).toISOString(),
      series: s.series,
      liveSymbols: s.liveSymbols,
      polledSeries: s.polledSeries,
      lastError: s.lastError ? s.lastError.slice(0, 1000) : null,
      waiting: s.waiting.slice(0, MAX_WAITING).map((w) => ({
        alertId: w.alertId,
        reason: w.reason.slice(0, 500),
        resumeAt: new Date(w.resumeAt).toISOString(),
      })),
      ...(this.metricsRejected ? {} : { metrics: s.metrics }),
    };
    try {
      await this.send(hb);
    } catch (err) {
      this.log.debug('heartbeat failed', { error: errText(err) });
    }
  }

  /** POST; a 422 for a heartbeat that carried `metrics` is retried once without them. */
  private async send(hb: ServiceHeartbeat): Promise<void> {
    try {
      await this.api.heartbeat(hb);
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 422 || hb.metrics === undefined) throw err;
      const { metrics: _dropped, ...rest } = hb;
      await this.api.heartbeat(rest);
      // Accepted without them: the metrics were the problem (an API that predates them).
      this.metricsRejected = true;
      this.log.info('API does not accept heartbeat metrics; upgrade the API');
    }
  }
}
