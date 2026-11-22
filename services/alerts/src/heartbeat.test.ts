import { describe, expect, it } from 'vitest';
import type { ServiceHeartbeat } from '@tickerglass/alerts';
import { ApiError } from './api';
import { FakeClock } from './test-utils';
import { Heartbeat, type HeartbeatStats } from './heartbeat';
import { createLogger } from './log';

const metrics = {
  evaluations: 1,
  evaluationFailures: 0,
  firesQueued: 0,
  fireRetries: 0,
  firesDropped: 0,
  fireQueueDepth: 0,
  statusPostFailures: 0,
  scriptFaults: 0,
  lag: { buckets: [1], counts: [1], count: 1, sum: 0.5 },
};
const stats = (): HeartbeatStats => ({
  series: 1,
  liveSymbols: 1,
  polledSeries: 0,
  lastError: null,
  waiting: [],
  metrics,
});

function setup(fail: (hb: ServiceHeartbeat) => Error | null) {
  const sent: ServiceHeartbeat[] = [];
  const lines: { level: string; msg: string }[] = [];
  const api = {
    heartbeat: async (hb: ServiceHeartbeat): Promise<void> => {
      sent.push(hb);
      const err = fail(hb);
      if (err) throw err;
    },
  };
  const log = createLogger('debug', (l) => lines.push(JSON.parse(l)));
  const beat = new Heartbeat(api, new FakeClock(0), log, stats, 'test', 0);
  return { beat, sent, lines };
}

const withMetrics = (sent: ServiceHeartbeat[]) => sent.map((h) => h.metrics !== undefined);

describe('Heartbeat metrics fallback', () => {
  it('retries once without metrics on 422 and stops sending them', async () => {
    const { beat, sent, lines } = setup((hb) =>
      hb.metrics ? new ApiError('HTTP 422', 422) : null,
    );
    await beat.beat();
    expect(withMetrics(sent)).toEqual([true, false]);
    await beat.beat();
    await beat.beat();
    expect(withMetrics(sent)).toEqual([true, false, false, false]);
    const infos = lines.filter((l) => l.level === 'info');
    expect(infos).toHaveLength(1);
    expect(infos[0]?.msg).toBe('API does not accept heartbeat metrics; upgrade the API');
  });

  it('keeps sending metrics after other failures', async () => {
    let n = 0;
    const { beat, sent } = setup(() => (n++ === 0 ? new ApiError('HTTP 503', 503) : null));
    await beat.beat();
    await beat.beat();
    expect(withMetrics(sent)).toEqual([true, true]);
  });

  it('does not give up on metrics when the retry without them fails too', async () => {
    const { beat, sent, lines } = setup(() => new ApiError('HTTP 422', 422));
    await beat.beat();
    await beat.beat();
    expect(withMetrics(sent)).toEqual([true, false, true, false]);
    expect(lines.some((l) => l.level === 'info')).toBe(false);
  });
});
