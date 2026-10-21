import { describe, expect, it } from 'vitest';
import {
  alignKeys,
  alignModeFor,
  asOfIndex,
  asOfIndexAt,
  calendarContext,
  lowerBound,
  maxStaleSeconds,
  type AlignMode,
} from './align';

const DAY = 86_400;
const D1 = { unit: 'day', count: 1 } as const;
const H1 = { unit: 'hour', count: 1 } as const;

interface Leg {
  times: number[];
  closes: number[];
  tz: string | null;
}

/** Overlay closes aligned onto the main leg's rows (NaN = no value). */
function aligned(main: Leg, leg: Leg, mode: AlignMode, maxStale: number): number[] {
  const keys = (l: Leg) =>
    alignKeys(l.times, l.times.length, mode, calendarContext(l.tz, l.times, l.times.length));
  const idx = asOfIndex(keys(main), main.times.length, keys(leg), leg.times.length, maxStale);
  return [...idx].map((j) => (j < 0 ? NaN : (leg.closes[j] as number)));
}

// Jan 2, 3, 4, 5, 8 2024 at New York midnight.
const AAPL: Leg = {
  times: [1704171600, 1704258000, 1704344400, 1704430800, 1704690000],
  closes: [185, 184, 182, 181, 185],
  tz: 'America/New_York',
};
// Jan 1..8 2024 at UTC midnight.
const BTC: Leg = {
  times: Array.from({ length: 8 }, (_, k) => 1704067200 + k * DAY),
  closes: Array.from({ length: 8 }, (_, k) => 100 + k),
  tz: 'UTC',
};
// Jan 4, 5, 9 2024 at Tokyo midnight.
const TOYOTA: Leg = {
  times: [1704294000, 1704380400, 1704726000],
  closes: [2500, 2510, 2520],
  tz: 'Asia/Tokyo',
};

describe('modes and staleness', () => {
  it('alignModeFor', () => {
    expect(alignModeFor({ unit: 'minute', count: 5 })).toBe('instant');
    expect(alignModeFor(H1)).toBe('instant');
    expect(alignModeFor(D1)).toBe('calendar');
    expect(alignModeFor({ unit: 'week', count: 1 })).toBe('calendar');
    expect(alignModeFor({ unit: 'month', count: 1 })).toBe('calendar');
  });

  it('maxStaleSeconds', () => {
    expect(maxStaleSeconds({ unit: 'minute', count: 1 })).toBe(4 * DAY);
    expect(maxStaleSeconds({ unit: 'hour', count: 4 })).toBe(4 * DAY);
    expect(maxStaleSeconds({ unit: 'hour', count: 48 })).toBe(6 * DAY);
    expect(maxStaleSeconds(D1)).toBe(10 * DAY);
    expect(maxStaleSeconds({ unit: 'day', count: 5 })).toBe(15 * DAY);
    expect(maxStaleSeconds({ unit: 'week', count: 1 })).toBe(21 * DAY);
    expect(maxStaleSeconds({ unit: 'week', count: 2 })).toBe(42 * DAY);
    expect(maxStaleSeconds({ unit: 'month', count: 1 })).toBe(93 * DAY);
    expect(maxStaleSeconds({ unit: 'month', count: 6 })).toBe(540 * DAY);
  });
});

describe('calendarContext', () => {
  it('uses UTC when every stamp is a UTC midnight', () => {
    expect(calendarContext('America/New_York', BTC.times, BTC.times.length).timezone).toBeNull();
    expect(calendarContext('Asia/Tokyo', TOYOTA.times, 3).timezone).toBe('Asia/Tokyo');
    expect(calendarContext('Asia/Tokyo', [], 0).timezone).toBeNull();
  });

  it('only inspects the first n stamps', () => {
    expect(calendarContext('Asia/Tokyo', [0, DAY, 5], 2).timezone).toBeNull();
  });

  it('calendar keys are local dates', () => {
    const ctx = calendarContext(TOYOTA.tz, TOYOTA.times, 3);
    const keys = alignKeys(TOYOTA.times, 3, 'calendar', ctx);
    // Jan 4, 5, 9 2024 UTC midnight.
    expect([...keys]).toEqual([1704326400, 1704412800, 1704758400]);
    expect([...alignKeys(TOYOTA.times, 3, 'instant', ctx)]).toEqual(TOYOTA.times);
  });
});

describe('daily alignment', () => {
  const stale = maxStaleSeconds(D1);

  it('AAPL main, BTC-USD overlay', () => {
    expect(aligned(AAPL, BTC, 'calendar', stale)).toEqual([101, 102, 103, 104, 107]);
  });

  it('AAPL main, 7203.T overlay', () => {
    expect(aligned(AAPL, TOYOTA, 'calendar', stale)).toEqual([NaN, NaN, 2500, 2510, 2510]);
  });

  it('BTC-USD main, AAPL overlay forward-fills weekends', () => {
    expect(aligned(BTC, AAPL, 'calendar', stale)).toEqual([NaN, 185, 184, 182, 181, 181, 181, 185]);
  });

  it('gaps after the staleness limit', () => {
    // Jan 22 2024 New York midnight; Tokyo's last bar is Jan 9 (13 days).
    const main: Leg = { times: [1705899600], closes: [0], tz: 'America/New_York' };
    expect(aligned(main, TOYOTA, 'calendar', stale)).toEqual([NaN]);
    // Jan 19 (10 days) is still in range.
    const main2: Leg = { times: [1705640400], closes: [0], tz: 'America/New_York' };
    expect(aligned(main2, TOYOTA, 'calendar', stale)).toEqual([2520]);
  });
});

describe('intraday alignment', () => {
  const stale = maxStaleSeconds(H1);

  it('offset grids take the latest bar at or before', () => {
    const main: Leg = {
      times: [1704205800, 1704209400, 1704213000],
      closes: [0, 0, 0],
      tz: 'America/New_York',
    };
    const btc: Leg = {
      times: [1704204000, 1704207600, 1704211200, 1704214800],
      closes: [42000, 42100, 42200, 42300],
      tz: 'UTC',
    };
    expect(aligned(main, btc, 'instant', stale)).toEqual([42000, 42100, 42200]);
  });

  it('staleness limit', () => {
    const main: Leg = { times: [1704810600], closes: [0], tz: null };
    const fresh: Leg = { times: [1704400000, 1704484800], closes: [1, 2], tz: null };
    expect(1704810600 - 1704484800).toBe(325800);
    expect(aligned(main, fresh, 'instant', stale)).toEqual([2]);
    const old: Leg = { times: [1704398400], closes: [1], tz: null };
    expect(1704810600 - 1704398400).toBe(412200);
    expect(aligned(main, old, 'instant', stale)).toEqual([NaN]);
  });
});

describe('asOfIndex', () => {
  it('duplicate keys: last wins', () => {
    expect([...asOfIndex([5, 10, 20], 3, [5, 5, 10, 10, 10], 5, 100)]).toEqual([1, 4, 4]);
    expect(asOfIndexAt(10, [5, 5, 10, 10, 10], 5, 100)).toBe(4);
  });

  it('empty leg gives all -1', () => {
    expect([...asOfIndex([1, 2, 3], 3, [], 0, 100)]).toEqual([-1, -1, -1]);
    expect(asOfIndexAt(2, [], 0, 100)).toBe(-1);
  });

  it('never back-fills before the first leg bar', () => {
    expect([...asOfIndex([1, 2, 3, 4], 4, [3], 1, 100)]).toEqual([-1, -1, 0, 0]);
  });

  it('respects tn/ln and reuses out', () => {
    const out = new Int32Array(4).fill(9);
    const r = asOfIndex([1, 2, 3, 4], 2, [1, 2, 3], 1, 100, out);
    expect(r).toBe(out);
    expect([...out]).toEqual([0, 0, 9, 9]);
  });

  it('asOfIndexAt equals asOfIndex on random data', () => {
    let s = 7;
    const rand = () => {
      s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0;
      return s / 2 ** 32;
    };
    for (let trial = 0; trial < 200; trial++) {
      const series = (len: number) => {
        const xs: number[] = [];
        let t = Math.floor(rand() * 50);
        for (let i = 0; i < len; i++) {
          t += Math.floor(rand() * 20); // 0 step -> duplicates
          xs.push(t);
        }
        return xs;
      };
      const target = series(Math.floor(rand() * 40));
      const leg = series(Math.floor(rand() * 40));
      const stale = Math.floor(rand() * 60);
      const idx = asOfIndex(target, target.length, leg, leg.length, stale);
      target.forEach((key, i) => {
        expect(asOfIndexAt(key, leg, leg.length, stale)).toBe(idx[i]);
      });
    }
  });
});

describe('lowerBound', () => {
  it('first index with key >= value', () => {
    const keys = [1, 3, 3, 5];
    expect(lowerBound(keys, 4, 0)).toBe(0);
    expect(lowerBound(keys, 4, 3)).toBe(1);
    expect(lowerBound(keys, 4, 4)).toBe(3);
    expect(lowerBound(keys, 4, 6)).toBe(4);
    expect(lowerBound(keys, 2, 6)).toBe(2);
    expect(lowerBound([], 0, 1)).toBe(0);
  });
});
