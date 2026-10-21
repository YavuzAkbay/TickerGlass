import { describe, expect, it } from 'vitest';
import { barEnd, closeDeadline, closeEventTime, CloseTracker } from './close';

const NY = { timezone: 'America/New_York', session: '0930-1600' } as const;
const utc = (y: number, mo: number, d: number, h = 0, mi = 0) =>
  Date.UTC(y, mo - 1, d, h, mi) / 1000;
const one = (t: number) => ({ time: [t], length: 1 });

describe('barEnd', () => {
  it('intraday: T + interval without a session', () => {
    const t = utc(2026, 10, 14, 14, 0);
    expect(barEnd(0, one(t), null, false, '5m')).toBe(t + 300);
    expect(barEnd(0, one(t), { timezone: 'UTC', session: null }, false, '1h')).toBe(t + 3600);
  });

  it('intraday RTH: capped at the regular session end', () => {
    // 15:30 EDT bar of a 1h series ends at 16:00 EDT = 20:00 UTC, not 16:30.
    const t = utc(2026, 10, 14, 19, 30);
    expect(barEnd(0, one(t), NY, false, '1h')).toBe(utc(2026, 10, 14, 20, 0));
    expect(barEnd(0, one(t), NY, true, '1h')).toBe(t + 3600);
    // A bar that ends before the session end is not capped.
    const early = utc(2026, 10, 14, 13, 30);
    expect(barEnd(0, one(early), NY, false, '1h')).toBe(early + 3600);
    // 4h bar opening 13:30 EDT: capped at 16:00.
    expect(barEnd(0, one(utc(2026, 10, 14, 17, 30)), NY, false, '4h')).toBe(utc(2026, 10, 14, 20));
  });

  it('daily: session end of the bar day in New York, across DST', () => {
    // Friday 2026-03-06 (EST, UTC-5): 16:00 = 21:00 UTC.
    expect(barEnd(0, one(utc(2026, 3, 6, 14, 30)), NY, false, '1D')).toBe(utc(2026, 3, 6, 21));
    // Monday 2026-03-09 (EDT after the 03-08 switch, UTC-4): 16:00 = 20:00 UTC.
    expect(barEnd(0, one(utc(2026, 3, 9, 13, 30)), NY, false, '1D')).toBe(utc(2026, 3, 9, 20));
    // Bars stamped at local midnight belong to the same day.
    expect(barEnd(0, one(utc(2026, 3, 9, 4)), NY, false, '1D')).toBe(utc(2026, 3, 9, 20));
    // 2D bar from Thursday covers Friday.
    expect(barEnd(0, one(utc(2026, 3, 5, 14, 30)), NY, false, '2D')).toBe(utc(2026, 3, 6, 21));
  });

  it('weekly and monthly: the last weekday of the period', () => {
    // Week of Monday 2026-10-05 ends Friday 10-09 16:00 EDT.
    expect(barEnd(0, one(utc(2026, 10, 5, 4)), NY, false, '1W')).toBe(utc(2026, 10, 9, 20));
    // October 2026 ends on Saturday 31: last weekday is Friday 30.
    expect(barEnd(0, one(utc(2026, 10, 1, 4)), NY, false, '1M')).toBe(utc(2026, 10, 30, 20));
  });

  it('otherwise: stepTime(T, 1, interval)', () => {
    const t = utc(2026, 10, 14);
    expect(barEnd(0, one(t), null, false, '1D')).toBe(t + 86_400);
    expect(barEnd(0, one(t), { timezone: 'UTC', session: null }, false, '1W')).toBe(t + 7 * 86_400);
    expect(barEnd(0, one(utc(2026, 1, 31)), null, false, '1M')).toBe(utc(2026, 3, 3));
  });

  it('reads bar i of the series and rejects out-of-range indices', () => {
    const series = { time: [utc(2026, 10, 14, 14), utc(2026, 10, 14, 14, 5)], length: 2 };
    expect(barEnd(1, series, null, false, '5m')).toBe(utc(2026, 10, 14, 14, 10));
    expect(() => barEnd(2, series, null, false, '5m')).toThrow(RangeError);
  });
});

describe('closeDeadline / closeEventTime', () => {
  it('adds the grace and takes the next bar when earlier', () => {
    const t0 = utc(2026, 10, 14, 14);
    expect(closeDeadline(0, one(t0), null, false, '5m')).toBe(t0 + 360);
    expect(closeDeadline(0, one(t0), null, false, '5m', 0)).toBe(t0 + 300);
    const series = { time: [t0, t0 + 300], length: 2 };
    expect(closeEventTime(0, series, null, false, '5m')).toBe((t0 + 300) * 1000);
    expect(closeEventTime(1, series, null, false, '5m')).toBe((t0 + 660) * 1000);
  });
});

describe('CloseTracker', () => {
  it('intraday: next-bar rule closes the previous bar once', () => {
    const tr = new CloseTracker({ interval: '5m', symbolInfo: null, prepost: false });
    const t0 = utc(2026, 10, 14, 14);
    expect(tr.onBar(t0, t0 * 1000)).toEqual({ kind: 'append', closed: null });
    expect(tr.onBar(t0, t0 * 1000 + 5000)).toEqual({ kind: 'update', closed: null });
    const r = tr.onBar(t0 + 300, (t0 + 301) * 1000);
    expect(r).toEqual({
      kind: 'append',
      closed: { barTime: t0, rule: 'nextBar', at: (t0 + 301) * 1000 },
    });
    expect(tr.onBar(t0, (t0 + 302) * 1000)).toEqual({ kind: 'old', closed: null });
    expect(tr.lastBarTime).toBe(t0 + 300);
    expect(tr.closed).toBe(false);
  });

  it('clock rule: end + grace, once; a later bar does not close it again', () => {
    const tr = new CloseTracker({ interval: '5m', symbolInfo: null, prepost: false, graceS: 60 });
    const t0 = utc(2026, 10, 14, 14);
    tr.onBar(t0, t0 * 1000);
    expect(tr.onClock((t0 + 359) * 1000)).toBeNull();
    expect(tr.onClock((t0 + 360) * 1000)).toEqual({
      barTime: t0,
      rule: 'clock',
      at: (t0 + 360) * 1000,
    });
    expect(tr.closed).toBe(true);
    expect(tr.onClock((t0 + 400) * 1000)).toBeNull();
    // A late revision of the closed bar: no second close.
    expect(tr.onBar(t0, (t0 + 401) * 1000)).toEqual({ kind: 'update', closed: null });
    expect(tr.onBar(t0 + 300, (t0 + 410) * 1000).closed).toBeNull();
  });

  it('RTH cap: the last bar of the day closes at the session end + grace', () => {
    const tr = new CloseTracker({ interval: '1h', symbolInfo: NY, prepost: false });
    const t = utc(2026, 10, 14, 19, 30); // 15:30 EDT
    tr.onBar(t, t * 1000);
    expect(tr.onClock(utc(2026, 10, 14, 20, 0) * 1000 + 59_999)).toBeNull();
    expect(tr.onClock(utc(2026, 10, 14, 20, 1) * 1000)?.rule).toBe('clock');
  });

  it('daily session close in New York, incl. DST', () => {
    const tr = new CloseTracker({ interval: '1D', symbolInfo: NY, prepost: false });
    const fri = utc(2026, 3, 6, 14, 30);
    tr.onBar(fri, fri * 1000);
    expect(tr.onClock(utc(2026, 3, 6, 21, 0) * 1000)).toBeNull();
    expect(tr.onClock(utc(2026, 3, 6, 21, 1) * 1000)?.barTime).toBe(fri);
    const mon = utc(2026, 3, 9, 13, 30);
    expect(tr.onBar(mon, mon * 1000).closed).toBeNull();
    expect(tr.onClock(utc(2026, 3, 9, 20, 0) * 1000 + 59_000)).toBeNull();
    expect(tr.onClock(utc(2026, 3, 9, 20, 1) * 1000)?.barTime).toBe(mon);
  });

  it('a holiday gap emits no extra close', () => {
    const tr = new CloseTracker({ interval: '1D', symbolInfo: NY, prepost: false });
    const wed = utc(2026, 11, 25, 14, 30); // Thanksgiving is Thursday 11-26
    tr.onBar(wed, wed * 1000);
    const events = [];
    // Clock every hour from Wednesday until Friday's open.
    for (let t = wed; t < utc(2026, 11, 27, 14, 30); t += 3600) {
      const e = tr.onClock(t * 1000);
      if (e) events.push(e);
    }
    expect(events).toEqual([{ barTime: wed, rule: 'clock', at: utc(2026, 11, 25, 21, 30) * 1000 }]);
    const fri = utc(2026, 11, 27, 14, 30);
    expect(tr.onBar(fri, fri * 1000)).toEqual({ kind: 'append', closed: null });
  });

  it('reset adopts a loaded history', () => {
    const tr = new CloseTracker({ interval: '5m', symbolInfo: null, prepost: false });
    const t0 = utc(2026, 10, 14, 14);
    tr.reset(t0, true);
    expect(tr.closed).toBe(true);
    expect(tr.onBar(t0 + 300, 0).closed).toBeNull();
    tr.reset(t0, false);
    expect(tr.onClock((t0 + 360) * 1000)?.barTime).toBe(t0);
    tr.reset(null, false);
    expect(tr.onClock(Number.MAX_SAFE_INTEGER)).toBeNull();
  });
});
