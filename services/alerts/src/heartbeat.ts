/** `POST /alerts/service/heartbeat` every 30 s (docs/alerts.md §3.1). */
import type { ServiceHeartbeat } from '@investopen/alerts';
import type { ApiClient } from './api';
import type { Clock } from './clock';
import { errText, type Logger } from './log';

export const HEARTBEAT_MS = 30_000;

export interface HeartbeatStats {
  series: number;
  liveSymbols: number;
  polledSeries: number;
  lastError: string | null;
}

export class Heartbeat {
  private cancel: (() => void) | null = null;

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
    };
    try {
      await this.api.heartbeat(hb);
    } catch (err) {
      this.log.debug('heartbeat failed', { error: errText(err) });
    }
  }
}
