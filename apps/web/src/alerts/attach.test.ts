import type { Alert, AlertLogEntry } from '@investopen/alerts';
import { describe, expect, it } from 'vitest';
import { alertLinePrice, buildLines, buildMarkers, MAX_MARKERS } from './attach';

const alert = (
  id: string,
  o: Partial<Alert> = {},
  right: unknown = { kind: 'value', value: 150 },
) =>
  ({
    id,
    name: id,
    symbol: 'AAPL',
    status: 'active',
    spec: {
      left: { kind: 'price', field: 'close' },
      condition: { op: 'crossing', right },
    },
    ...o,
  }) as unknown as Alert;

const entry = (id: number, o: Partial<AlertLogEntry> = {}) =>
  ({
    id,
    alertId: 'a',
    symbol: 'AAPL',
    barTime: 1000 + id,
    message: `m${id}`,
    values: { x: 151 },
    ...o,
  }) as AlertLogEntry;

describe('price lines', () => {
  it('only active price alerts against a fixed value', () => {
    expect(alertLinePrice(alert('a'))).toBe(150);
    expect(alertLinePrice(alert('a', { status: 'paused' }))).toBeNull();
    expect(alertLinePrice(alert('a', {}, { kind: 'price', field: 'close' }))).toBeNull();
  });
  it('filters by symbol', () => {
    const lines = buildLines({ a: alert('a'), b: alert('b', { symbol: 'MSFT' }) }, 'AAPL');
    expect(lines.map((l) => l.id)).toEqual(['a']);
    expect(lines[0]).toMatchObject({
      paneId: 'main',
      price: 150,
      lineStyle: 'dashed',
      axisLabel: true,
    });
  });
});

describe('markers', () => {
  it('places price-left alerts at x, others above the bar', () => {
    const m = buildMarkers([entry(2), entry(1, { alertId: null })], { a: alert('a') }, 'AAPL');
    expect(m[0]).toMatchObject({
      id: '2',
      position: 'price',
      price: 151,
      time: 1002,
      tooltip: 'm2',
    });
    expect(m[1]).toMatchObject({ id: '1', position: 'aboveBar' });
  });
  it('filters by symbol and caps at the newest 500', () => {
    const log = Array.from({ length: 600 }, (_, i) => entry(600 - i));
    log.unshift(entry(999, { symbol: 'MSFT' }));
    const m = buildMarkers(log, {}, 'AAPL');
    expect(m).toHaveLength(MAX_MARKERS);
    expect(m[0]!.id).toBe('600');
  });
});
