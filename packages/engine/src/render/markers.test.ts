import { describe, expect, it } from 'vitest';
import type { AnchorTimeline } from '../drawings/mapping';
import type { Interval } from '../types';
import {
  MARKER_SIZE,
  hitMarker,
  layoutMarkers,
  type ChartMarker,
  type MarkerLayoutInput,
} from './markers';
import { hitPriceLine, layoutPriceLines, type ChartPriceLine } from './price-lines';

const H = 3600;
const D = 86_400;
const START = 1_700_438_400; // Monday 2023-11-20 00:00 UTC

function input(times: number[], interval: Interval, over: Partial<MarkerLayoutInput> = {}) {
  const n = times.length;
  const timeline: AnchorTimeline = {
    time: Float64Array.from(times),
    length: n,
    interval,
    bricks: false,
    endTime: times[n - 1]!,
  };
  const inp: MarkerLayoutInput = {
    timeline,
    high: Float64Array.from(times, () => 110),
    low: Float64Array.from(times, () => 90),
    indexToX: (i) => i * 10 + 5,
    priceToY: (p) => 200 - p,
    paneWidth: 100_000,
    paneHeight: 300,
    ...over,
  };
  return inp;
}

const m = (id: string, time: number, extra: Partial<ChartMarker> = {}): ChartMarker => ({
  id,
  time,
  position: 'aboveBar',
  color: '#fff',
  shape: 'bell',
  ...extra,
});

function groups(...list: ChartMarker[]) {
  return new Map([['alerts', list]]);
}

describe('layoutMarkers time mapping', () => {
  it('places a marker on the bar containing its time, across intervals', () => {
    const t = START + 5 * D + 10 * H; // Saturday-ish, mid-bar on any interval below
    const hourly = Array.from({ length: 24 * 10 }, (_, i) => START + i * H);
    const daily = Array.from({ length: 10 }, (_, i) => START + i * D);
    const fourHour = Array.from({ length: 6 * 10 }, (_, i) => START + i * 4 * H);
    const at = (times: number[], iv: Interval) =>
      layoutMarkers(groups(m('a', t)), input(times, iv)).map((p) => (p.x - 5) / 10);
    expect(at(hourly, { unit: 'hour', count: 1 })).toEqual([5 * 24 + 10]);
    expect(at(fourHour, { unit: 'hour', count: 4 })).toEqual([5 * 6 + 2]);
    expect(at(daily, { unit: 'day', count: 1 })).toEqual([5]);
  });

  it('puts the marker above the high / below the low of that bar', () => {
    const times = [START, START + D, START + 2 * D];
    const above = layoutMarkers(groups(m('a', START + D)), input(times, { unit: 'day', count: 1 }));
    const below = layoutMarkers(
      groups(m('b', START + D, { position: 'belowBar' })),
      input(times, { unit: 'day', count: 1 }),
    );
    expect(above[0]!.y).toBeLessThan(200 - 110);
    expect(below[0]!.y).toBeGreaterThan(200 - 90);
  });

  it('places price markers at their price and ignores a missing price', () => {
    const times = [START, START + D];
    const iv = { unit: 'day', count: 1 } as const;
    const ok = layoutMarkers(
      groups(m('p', START, { position: 'price', price: 150 })),
      input(times, iv),
    );
    expect(ok[0]!.y).toBe(50);
    const bad = layoutMarkers(groups(m('q', START, { position: 'price' })), input(times, iv));
    expect(bad).toEqual([]);
  });

  it('stacks markers on the same bar and side', () => {
    const times = [START, START + D];
    const iv = { unit: 'day', count: 1 } as const;
    const out = layoutMarkers(groups(m('a', START), m('b', START)), input(times, iv));
    expect(out[0]!.y - out[1]!.y).toBeGreaterThanOrEqual(MARKER_SIZE);
  });
});

describe('layoutMarkers culling', () => {
  const iv = { unit: 'day', count: 1 } as const;
  const times = Array.from({ length: 200 }, (_, i) => START + i * D);

  it('drops markers outside the visible x range', () => {
    const out = layoutMarkers(
      groups(m('in', START + 10 * D), m('right', START + 150 * D), m('left', START)),
      input(times, iv, { indexToX: (i) => (i - 5) * 10 + 5, paneWidth: 300 }),
    );
    expect(out.map((p) => p.marker.id)).toEqual(['in']);
    const only = layoutMarkers(
      groups(m('left', START)),
      input(times, iv, { indexToX: (i) => (i - 50) * 10 + 5, paneWidth: 300 }),
    );
    expect(only).toEqual([]);
  });

  it('drops above/below markers before the data but keeps price markers', () => {
    const before = START - 3 * D;
    const out = layoutMarkers(
      groups(m('a', before), m('c', before, { position: 'price', price: 100 })),
      input(times, iv, { indexToX: (i) => (i + 10) * 10 }),
    );
    expect(out.map((p) => p.marker.id)).toEqual(['c']);
  });

  it('puts a future marker past the last bar at the last bar extreme', () => {
    const after = START + 205 * D;
    const out = layoutMarkers(
      groups(m('f', after, { position: 'belowBar', shape: 'letter', text: 'E' })),
      input(times, iv, { indexToX: (i) => i * 10 + 5 }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.x).toBe(205 * 10 + 5);
    // low 90 -> y 110, plus gap and half marker.
    expect(out[0]!.y).toBe(110 + 6 + MARKER_SIZE / 2);
  });

  it('drops markers whose y is outside the pane and handles empty data', () => {
    const out = layoutMarkers(
      groups(m('far', START, { position: 'price', price: 5000 })),
      input(times, iv),
    );
    expect(out).toEqual([]);
    expect(layoutMarkers(groups(m('a', START)), input([], iv))).toEqual([]);
  });
});

describe('hit testing', () => {
  it('hits the topmost marker within its box', () => {
    const iv = { unit: 'day', count: 1 } as const;
    const placed = layoutMarkers(
      groups(m('a', START, { position: 'price', price: 100 })),
      input([START, START + D], iv),
    );
    const p = placed[0]!;
    expect(hitMarker(placed, p.x + 3, p.y - 3)?.marker.id).toBe('a');
    expect(hitMarker(placed, p.x + 30, p.y)).toBeNull();
  });

  it('hits price lines by stroke and by axis label, per pane', () => {
    const line = (
      id: string,
      price: number,
      extra: Partial<ChartPriceLine> = {},
    ): ChartPriceLine => ({
      id,
      paneId: 'main',
      price,
      color: '#f00',
      lineStyle: 'dashed',
      axisLabel: true,
      ...extra,
    });
    const map = new Map([
      ['alerts', [line('a', 150), line('b', 120, { paneId: 'other' }), line('far', 9999)]],
    ]);
    const placed = layoutPriceLines(map, 'main', 300, (p) => 200 - p);
    expect(placed.map((p) => p.line.id)).toEqual(['a']);
    expect(hitPriceLine(placed, 100, 52, 800, 300)?.line.id).toBe('a');
    expect(hitPriceLine(placed, 100, 60, 800, 300)).toBeNull();
    expect(hitPriceLine(placed, 810, 55, 800, 300)?.line.id).toBe('a');
    expect(hitPriceLine(placed, 810, 80, 800, 300)).toBeNull();
  });
});
