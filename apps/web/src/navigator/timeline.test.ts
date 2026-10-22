import type { AlertLogEntry } from '@tickerglass/alerts';
import { describe, expect, it } from 'vitest';
import { alertRows, buildTimeline, eventRows, newsRows, TIMELINE_DAYS } from './timeline';

const NOW = 1_800_000_000;
const DAY = 86_400;

const entry = (id: number, symbol: string, at: number): AlertLogEntry =>
  ({
    id,
    alertId: 'a',
    alertName: `Alert ${id}`,
    symbol,
    interval: '1D',
    firedAt: new Date(at * 1000).toISOString(),
    barTime: at,
    message: 'crossed 200',
    values: {},
    delayed: false,
    final: false,
    read: true,
    deliveries: [],
  }) as unknown as AlertLogEntry;

describe('timeline', () => {
  it('merges alerts, news and events; upcoming first, then newest first', () => {
    const rows = [
      ...alertRows([entry(1, 'aapl', NOW - 3600), entry(2, 'MSFT', NOW - 60)], new Set(['AAPL'])),
      ...newsRows([
        {
          id: 'n1',
          title: 'Story',
          publisher: 'Wire',
          url: 'https://x',
          time: NOW - 120,
          thumbnail: null,
        },
        {
          id: 'n2',
          title: 'Undated',
          publisher: null,
          url: 'https://y',
          time: null,
          thumbnail: null,
        },
      ]),
      ...eventRows(
        {
          earnings: [
            { t: NOW + 5 * DAY, epsEstimate: 1.2, epsActual: null, surprisePercent: null },
            { t: NOW - 30 * DAY, epsEstimate: 1, epsActual: 1.1, surprisePercent: 10 },
          ],
          dividends: [{ t: NOW - (TIMELINE_DAYS + 5) * DAY, amount: 0.5 }],
          splits: [{ t: NOW - 10 * DAY, ratio: 4 }],
        },
        'AAPL',
      ),
    ];
    const { upcoming, past } = buildTimeline(rows, NOW);
    expect(upcoming.map((r) => r.kind)).toEqual(['earnings']);
    expect(past.map((r) => r.key)).toEqual([
      'nn1|0',
      'a1',
      's' + (NOW - 10 * DAY),
      'e' + (NOW - 30 * DAY),
    ]);
    expect(past[0]!.url).toBe('https://x');
    expect(past[1]!.entryId).toBe(1);
    // Other symbols' alerts, undated news and events older than the window are left out.
    expect(past.some((r) => r.key === 'a2' || r.kind === 'dividend')).toBe(false);
    expect(past[2]!.detail).toBe('4:1');
  });
});
