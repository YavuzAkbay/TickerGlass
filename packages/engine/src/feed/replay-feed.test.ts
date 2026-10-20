import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Chart } from '../chart';
import type {
  Bar,
  BarColumns,
  BarListener,
  DataFeed,
  GetBarsRequest,
  GetBarsResult,
  Interval,
  SubscribeRequest,
  SymbolInfo,
} from '../types';
import { ExpressionFeed } from './expression-feed';
import { formatInterval, intervalSeconds } from './intervals';
import { chooseTick, ReplayFeed, tickIntervals } from './replay-feed';
import { ResamplingFeed } from './resampling-feed';
import { SyntheticFeed } from './synthetic-feed';

const MIN = 60;
const HOUR = 3600;
const DAY = 86_400;
const H1: Interval = { unit: 'hour', count: 1 };
const H4: Interval = { unit: 'hour', count: 4 };
const D1: Interval = { unit: 'day', count: 1 };
const D2: Interval = { unit: 'day', count: 2 };
const W1: Interval = { unit: 'week', count: 1 };
const z = (iso: string): number => Date.parse(iso) / 1000;
/** A Monday, midnight UTC. */
const MON = z('2024-01-01T00:00:00Z');

function bars(times: number[], seed = 0): Bar[] {
  return times.map((time, i) => {
    const p = 100 + seed + Math.sin((i + seed) / 3) * 5;
    return {
      time,
      open: p,
      high: p + 1 + (i % 3),
      low: p - 1 - (i % 4),
      close: p + 0.5,
      volume: 10 + (i % 7),
    };
  });
}

function columns(list: Bar[]): BarColumns {
  const col = (k: keyof Bar) => Float64Array.from(list, (b) => b[k]);
  return {
    time: col('time'),
    open: col('open'),
    high: col('high'),
    low: col('low'),
    close: col('close'),
    volume: col('volume'),
  };
}

function times(c: BarColumns): number[] {
  return Array.from(c.time);
}

/** Weekday times starting at `start`, `step` apart within each day. */
function weekdays(start: number, days: number): number[] {
  const out: number[] = [];
  for (let d = 0; d < days; d++) {
    const t = start + d * DAY;
    const dow = new Date(t * 1000).getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(t);
  }
  return out;
}

function evenly(start: number, n: number, step: number): number[] {
  return Array.from({ length: n }, (_, i) => start + i * step);
}

function info(symbol: string): SymbolInfo {
  return {
    symbol,
    name: symbol,
    exchange: null,
    exchangeName: null,
    type: null,
    currency: null,
    timezone: 'UTC',
    session: null,
    priceHint: 2,
    minTick: 0.01,
  };
}

/** In-memory feed with API paging semantics: newest `limit` bars with t < to. */
class FakeFeed implements DataFeed {
  readonly requests: GetBarsRequest[] = [];
  readonly listeners = new Set<BarListener>();
  subscribeCalls = 0;
  unsubscribeCalls = 0;
  /** Return bars regardless of `to` (exercises the post-filter). */
  ignoreTo = false;

  constructor(private readonly data: Record<string, Bar[]>) {}

  async resolveSymbol(symbol: string): Promise<SymbolInfo> {
    return info(symbol.toUpperCase());
  }

  async searchSymbols() {
    return [];
  }

  async getBars(req: GetBarsRequest): Promise<GetBarsResult> {
    this.requests.push(req);
    const all = this.data[`${req.symbol.toUpperCase()}|${formatInterval(req.interval)}`];
    if (all === undefined)
      throw new Error(`no data for ${req.symbol} ${formatInterval(req.interval)}`);
    let end = all.length;
    if (req.to !== undefined && !this.ignoreTo) {
      end = 0;
      while (end < all.length && (all[end] as Bar).time < req.to) end++;
    }
    const start = Math.max(0, end - req.limit);
    return { bars: columns(all.slice(start, end)), hasMore: start > 0 };
  }

  subscribe(_req: SubscribeRequest, _lastBar: Bar | null, onBar: BarListener) {
    this.subscribeCalls++;
    this.listeners.add(onBar);
    return () => {
      this.unsubscribeCalls++;
      this.listeners.delete(onBar);
    };
  }

  push(bar: Bar): void {
    for (const l of this.listeners) l(bar);
  }
}

/** Let queued microtasks and already-resolved promise chains run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

function collect(feed: ReplayFeed, symbol: string, interval: Interval, lastBar: Bar | null = null) {
  const got: Bar[] = [];
  const unsub = feed.subscribe({ symbol, interval }, lastBar, (b) => got.push(b));
  return { got, unsub };
}

// Five weeks of weekday bars and the matching Monday-anchored weekly bars.
const DAYS = weekdays(MON, 35);
const DAILY = bars(DAYS);
const WEEKLY = bars(evenly(MON, 5, 7 * DAY), 3);
const FAR_FUTURE = () => MON + 365 * DAY;

function dailyFeed(): FakeFeed {
  return new FakeFeed({ 'AAA|1D': DAILY, 'BBB|1D': bars(DAYS, 7), 'AAA|1W': WEEKLY });
}

describe('ReplayFeed live mode', () => {
  it('passes getBars, resolveSymbol and subscribe straight through', async () => {
    const inner = dailyFeed();
    const feed = new ReplayFeed(inner, { now: FAR_FUTURE });
    expect(feed.mode).toBe('live');
    const req: GetBarsRequest = { symbol: 'AAA', interval: D1, limit: 10, adjusted: true };
    const res = await feed.getBars(req);
    expect(inner.requests).toEqual([req]);
    expect(times(res.bars)).toEqual(DAYS.slice(-10));
    expect((await feed.resolveSymbol('aaa')).symbol).toBe('AAA');

    const got: Bar[] = [];
    const unsub = feed.subscribe({ symbol: 'AAA', interval: D1 }, null, (b) => got.push(b));
    expect(inner.subscribeCalls).toBe(1);
    inner.push(DAILY[0] as Bar);
    expect(got).toEqual([DAILY[0]]);
    unsub();
    unsub();
    expect(inner.unsubscribeCalls).toBe(1);
  });
});

describe('ReplayFeed start / getBars', () => {
  it('makes the picked bar the last visible one and reports the clock', async () => {
    const feed = new ReplayFeed(dailyFeed(), { now: FAR_FUTURE });
    const clocks: unknown[] = [];
    feed.on('clock', (c) => clocks.push(c));
    const picked = DAYS[10] as number;
    const info = await feed.start({
      symbol: 'AAA',
      interval: D1,
      lastVisible: picked,
      update: 'bars',
      prepost: false,
    });
    expect(info).toEqual({ tick: null, warning: null });
    expect(feed.mode).toBe('replay');
    expect(feed.clock).toEqual({ last: picked, next: DAYS[11] });
    expect(clocks).toEqual([{ last: picked, next: DAYS[11] }]);
    const res = await feed.getBars({ symbol: 'AAA', interval: D1, limit: 1000 });
    expect(times(res.bars)).toEqual(DAYS.slice(0, 11));
    expect(res.hasMore).toBe(false);
  });

  it('caps `to` at the cutoff and post-filters inner results', async () => {
    const inner = dailyFeed();
    const feed = new ReplayFeed(inner, { now: FAR_FUTURE });
    await feed.start({
      symbol: 'AAA',
      interval: D1,
      lastVisible: DAYS[10] as number,
      update: 'bars',
      prepost: false,
    });
    inner.requests.length = 0;
    const later = await feed.getBars({ symbol: 'AAA', interval: D1, limit: 5, to: MON + 99 * DAY });
    expect(inner.requests.at(-1)?.to).toBe(DAYS[11]);
    expect(times(later.bars)).toEqual(DAYS.slice(6, 11));
    expect(later.hasMore).toBe(true);
    const earlier = await feed.getBars({
      symbol: 'AAA',
      interval: D1,
      limit: 3,
      to: DAYS[4] as number,
    });
    expect(inner.requests.at(-1)?.to).toBe(DAYS[4]);
    expect(times(earlier.bars)).toEqual(DAYS.slice(1, 4));

    inner.ignoreTo = true;
    const all = await feed.getBars({ symbol: 'AAA', interval: D1, limit: 1000 });
    expect(times(all.bars)).toEqual(DAYS.slice(0, 11));
  });

  it('clips spread bars behind ExpressionFeed', async () => {
    const inner = dailyFeed();
    const feed = new ReplayFeed(new ExpressionFeed(inner), { now: FAR_FUTURE });
    await feed.start({
      symbol: 'AAA',
      interval: D1,
      lastVisible: DAYS[10] as number,
      update: 'bars',
      prepost: false,
    });
    // The expression feed pads leg requests past `to`; nothing may leak through.
    inner.ignoreTo = true;
    const res = await feed.getBars({ symbol: 'AAA/BBB', interval: D1, limit: 1000 });
    expect(res.bars.time.length).toBeGreaterThan(0);
    expect(Math.max(...times(res.bars))).toBe(DAYS[10]);
  });

  it('serves the first page around the clock and pages forward with halving', async () => {
    // "1D" data every 8h: a 1000-day span holds 3000 bars, so the first forward
    // page is full and starts after `from`, which forces span halving.
    const t0 = MON;
    const dense = bars(evenly(t0, 9000, DAY / 3));
    const inner = new FakeFeed({ 'AAA|1D': dense });
    const feed = new ReplayFeed(inner, { now: () => t0 + 10_000 * DAY });
    const picked = t0 + 100 * DAY;
    await feed.start({
      symbol: 'AAA',
      interval: D1,
      lastVisible: picked,
      update: 'bars',
      prepost: false,
    });
    const fwd = inner.requests.filter((r) => r.limit === 2000).map((r) => r.to);
    expect(fwd.slice(0, 2)).toEqual([picked + 1000 * DAY, picked + 500 * DAY]);
    expect(feed.clock).toEqual({ last: picked, next: picked + DAY / 3 });
    for (let i = 0; i < 3; i++) expect(await feed.step()).toBe('ok');
    expect(feed.clock.next).toBe(picked + (4 * DAY) / 3);
  });

  it('steps to the newest bar, then reports the end once', async () => {
    const list = bars(evenly(MON, 30, DAY));
    const inner = new FakeFeed({ 'AAA|1D': list });
    const feed = new ReplayFeed(inner, { now: () => MON + 30 * DAY });
    const ends: unknown[] = [];
    feed.on('end', (e) => ends.push(e));
    await feed.start({
      symbol: 'AAA',
      interval: D1,
      lastVisible: MON + 25 * DAY,
      update: 'bars',
      prepost: false,
    });
    for (let i = 0; i < 4; i++) expect(await feed.step()).toBe('ok');
    expect(feed.clock).toEqual({ last: MON + 29 * DAY, next: MON + 30 * DAY });
    const res = await feed.getBars({ symbol: 'AAA', interval: D1, limit: 100 });
    expect(times(res.bars).at(-1)).toBe(MON + 29 * DAY);
    expect(await feed.step()).toBe('end');
    expect(await feed.step()).toBe('end');
    expect(ends).toHaveLength(1);
  });

  it('throws on step outside replay', async () => {
    const feed = new ReplayFeed(dailyFeed());
    await expect(feed.step()).rejects.toThrow(/not in replay/);
  });
});

describe('ReplayFeed subscriptions', () => {
  async function started(lastVisibleIndex = 10) {
    const inner = dailyFeed();
    const feed = new ReplayFeed(inner, { now: FAR_FUTURE });
    await feed.start({
      symbol: 'AAA',
      interval: D1,
      lastVisible: DAYS[lastVisibleIndex] as number,
      update: 'bars',
      prepost: false,
    });
    return { inner, feed };
  }

  it('mutes live subscriptions on start and never subscribes the inner feed', async () => {
    const inner = dailyFeed();
    const feed = new ReplayFeed(inner, { now: FAR_FUTURE });
    const got: Bar[] = [];
    const unsub = feed.subscribe({ symbol: 'AAA', interval: D1 }, null, (b) => got.push(b));
    expect(inner.listeners.size).toBe(1);
    await feed.start({
      symbol: 'AAA',
      interval: D1,
      lastVisible: DAYS[10] as number,
      update: 'bars',
      prepost: false,
    });
    expect(inner.listeners.size).toBe(0);
    expect(inner.unsubscribeCalls).toBe(1);
    unsub();
    expect(inner.unsubscribeCalls).toBe(1);

    const replayed = collect(feed, 'AAA', D1);
    await flush();
    await feed.step();
    expect(inner.subscribeCalls).toBe(1);
    expect(got).toEqual([]);
    expect(replayed.got.map((b) => b.time)).toEqual([DAYS[11]]);
  });

  it('emits newly closed bars in time order on each step', async () => {
    const { feed } = await started();
    const a = collect(feed, 'AAA', D1);
    const b = collect(feed, 'bbb', D1);
    await flush();
    expect(a.got).toEqual([]);
    await feed.step();
    await feed.step();
    expect(a.got).toEqual([DAILY[11], DAILY[12]]);
    expect(b.got.map((x) => x.time)).toEqual([DAYS[11], DAYS[12]]);
    a.unsub();
    await feed.step();
    expect(a.got).toHaveLength(2);
    expect(b.got).toHaveLength(3);
  });

  it('catches up from lastBar when a step ran between getBars and subscribe', async () => {
    const { feed } = await started();
    const res = await feed.getBars({ symbol: 'AAA', interval: D1, limit: 100 });
    const n = res.bars.time.length;
    const last: Bar = {
      time: res.bars.time[n - 1] as number,
      open: res.bars.open[n - 1] as number,
      high: res.bars.high[n - 1] as number,
      low: res.bars.low[n - 1] as number,
      close: res.bars.close[n - 1] as number,
      volume: res.bars.volume[n - 1] as number,
    };
    await feed.step();
    const s = collect(feed, 'AAA', D1, last);
    await flush();
    expect(s.got).toEqual([DAILY[11]]);
  });

  it('rule P: a series with offset bars shows a bar only once it has closed', async () => {
    const hours = evenly(MON, 200, HOUR);
    const inner = new FakeFeed({
      'AAA|1h': bars(hours),
      'BBB|1h': bars(
        hours.map((t) => t + 30 * MIN),
        5,
      ),
    });
    const feed = new ReplayFeed(inner, { now: FAR_FUTURE });
    await feed.start({
      symbol: 'AAA',
      interval: H1,
      lastVisible: MON + 9 * HOUR,
      update: 'bars',
      prepost: false,
    });
    expect(feed.clock.next).toBe(MON + 10 * HOUR);
    // BBB 09:30 is still forming at E = 10:00.
    const res = await feed.getBars({ symbol: 'BBB', interval: H1, limit: 100 });
    expect(times(res.bars).at(-1)).toBe(MON + 8 * HOUR + 30 * MIN);
    const s = collect(feed, 'BBB', H1);
    await flush();
    expect(s.got).toEqual([]);
    await feed.step();
    expect(s.got.map((b) => b.time)).toEqual([MON + 9 * HOUR + 30 * MIN]);
  });

  it('rule A: a weekly subscription over daily ticks aggregates the forming week', async () => {
    // DAYS[12] is the Wednesday of week 3.
    const { feed } = await started(12);
    const weekStart = MON + 14 * DAY;
    expect(DAYS[10]).toBe(weekStart);
    const res = await feed.getBars({ symbol: 'AAA', interval: W1, limit: 100 });
    expect(times(res.bars)).toEqual([MON, MON + 7 * DAY]);

    const s = collect(feed, 'AAA', W1);
    await flush();
    const week = DAILY.slice(10, 13);
    const agg = (list: Bar[]): Bar => ({
      time: weekStart,
      open: (list[0] as Bar).open,
      high: Math.max(...list.map((b) => b.high)),
      low: Math.min(...list.map((b) => b.low)),
      close: (list[list.length - 1] as Bar).close,
      volume: list.reduce((v, b) => v + b.volume, 0),
    });
    expect(s.got).toEqual([agg(week)]);
    await feed.step(); // Thursday
    await feed.step(); // Friday
    expect(s.got.slice(1)).toEqual([agg(DAILY.slice(10, 14)), agg(DAILY.slice(10, 15))]);
    await feed.step(); // next Monday starts a new week
    expect(s.got.at(-1)).toEqual({ ...DAILY[15], time: MON + 21 * DAY });
    const after = await feed.getBars({ symbol: 'AAA', interval: W1, limit: 100 });
    expect(times(after.bars)).toEqual([MON, MON + 7 * DAY, MON + 14 * DAY]);
  });
});

describe('ReplayFeed epoch and primary changes', () => {
  it('increments the epoch on start, seek and stop', async () => {
    const feed = new ReplayFeed(dailyFeed(), { now: FAR_FUTURE });
    const opts = {
      symbol: 'AAA',
      interval: D1,
      lastVisible: DAYS[10] as number,
      update: 'bars' as const,
      prepost: false,
    };
    expect(feed.epoch).toBe(0);
    await feed.start(opts);
    expect(feed.epoch).toBe(1);
    await feed.step();
    expect(feed.epoch).toBe(1);
    await feed.start({ ...opts, lastVisible: DAYS[5] as number });
    expect(feed.epoch).toBe(2);
    expect(feed.clock.next).toBe(DAYS[6]);
    feed.stop();
    expect(feed.epoch).toBe(3);
    expect(feed.mode).toBe('live');
    feed.stop();
    expect(feed.epoch).toBe(3);
    await expect(feed.step()).rejects.toThrow();
  });

  it('snaps E back to the newest tick of the new interval', async () => {
    const feed = new ReplayFeed(dailyFeed(), { now: FAR_FUTURE });
    await feed.start({
      symbol: 'AAA',
      interval: D1,
      lastVisible: DAYS[12] as number, // Wednesday, week 3
      update: 'bars',
      prepost: false,
    });
    expect(feed.clock.next).toBe(DAYS[13]);
    const epoch = feed.epoch;
    expect(await feed.setPrimary('AAA', W1)).toEqual({ tick: null, warning: null });
    expect(feed.clock).toEqual({ last: MON + 7 * DAY, next: MON + 14 * DAY });
    expect(feed.epoch).toBe(epoch + 1);
    const res = await feed.getBars({ symbol: 'AAA', interval: W1, limit: 10 });
    expect(times(res.bars)).toEqual([MON, MON + 7 * DAY]);
    // Same pair again: no-op.
    await feed.setPrimary('aaa', { unit: 'week', count: 1 });
    expect(feed.epoch).toBe(epoch + 1);

    // Back to daily: Monday of week 3 is itself a tick, so E stays.
    const before = feed.epoch;
    await feed.setPrimary('AAA', D1);
    expect(feed.clock.next).toBe(MON + 14 * DAY);
    expect(feed.epoch).toBe(before);
    expect(await feed.step()).toBe('ok');
    expect(feed.clock.next).toBe(DAYS[11]);
  });
});

describe('ReplayFeed fixes', () => {
  it('reveals another symbol bar once its own interval elapsed, across its holiday', async () => {
    // BBB has no bar on the Monday of week 2 (DAYS[5]); its Friday bar must still
    // show once AAA's clock reaches that Monday.
    const bbbDays = DAYS.filter((t) => t !== DAYS[5]);
    const inner = new FakeFeed({ 'AAA|1D': DAILY, 'BBB|1D': bars(bbbDays, 7) });
    const feed = new ReplayFeed(inner, { now: FAR_FUTURE });
    await feed.start({
      symbol: 'AAA',
      interval: D1,
      lastVisible: DAYS[3] as number, // Thursday
      update: 'bars',
      prepost: false,
    });
    const s = collect(feed, 'BBB', D1);
    await flush();
    await feed.step();
    expect(feed.clock.next).toBe(DAYS[5]);
    expect(s.got.map((b) => b.time)).toEqual([DAYS[4]]);
    const res = await feed.getBars({ symbol: 'BBB', interval: D1, limit: 100 });
    expect(times(res.bars).at(-1)).toBe(DAYS[4]);
  });

  it('pages forward buffers with the consumer adjusted flag', async () => {
    const inner = dailyFeed();
    const feed = new ReplayFeed(inner, { now: FAR_FUTURE });
    await feed.start({
      symbol: 'AAA',
      interval: D1,
      lastVisible: DAYS[10] as number,
      update: 'bars',
      prepost: false,
      adjusted: true,
    });
    expect(inner.requests.length).toBeGreaterThan(0);
    expect(inner.requests.every((r) => r.adjusted === true)).toBe(true);
    inner.requests.length = 0;
    await feed.getBars({ symbol: 'BBB', interval: D1, limit: 10, adjusted: false });
    expect(inner.requests.every((r) => r.adjusted === false)).toBe(true);
    inner.requests.length = 0;
    const s = feed.subscribe({ symbol: 'BBB', interval: D1, adjusted: false }, null, () => {});
    await flush();
    await feed.step();
    expect(inner.requests.length).toBeGreaterThan(0);
    expect(inner.requests.every((r) => r.adjusted !== true)).toBe(true);
    s();
  });
});

describe('chooseTick', () => {
  const M = (count: number): Interval => ({ unit: 'minute', count });
  const NOW = MON + 5000 * DAY;
  // Mirrors the API lookback table (api/src/investopen_api/intervals.py).
  const lookbackSeconds = (iv: Interval): number | null => {
    const min = intervalSeconds(iv) / 60;
    if (min === 1) return 29 * DAY;
    if (min < 60) return 59 * DAY;
    if (min === 60) return 729 * DAY;
    return null;
  };
  const choose = (chart: string, daysAgo: number, update: 'auto' | 'bars' | Interval = 'auto') => {
    const c = chooseTick(parseIv(chart), {
      update,
      start: NOW - daysAgo * DAY,
      now: NOW,
      lookbackSeconds,
    });
    return { tick: c.tick ? formatInterval(c.tick) : null, warning: c.warning };
  };
  const parseIv = (s: string): Interval => {
    const m = /^(\d+)([mhDWM])$/.exec(s) as RegExpExecArray;
    const unit = { m: 'minute', h: 'hour', D: 'day', W: 'week', M: 'month' }[
      m[2] as 'm'
    ] as Interval['unit'];
    return { unit, count: Number(m[1]) };
  };

  it('lists structurally valid tick intervals', () => {
    expect(tickIntervals(parseIv('1D')).map(formatInterval)).toEqual(['15m', '30m', '1h']);
    expect(tickIntervals(parseIv('4h')).map(formatInterval)).toEqual([
      '2m',
      '5m',
      '15m',
      '30m',
      '1h',
    ]);
    expect(tickIntervals(parseIv('15m')).map(formatInterval)).toEqual(['1m', '5m']);
    expect(tickIntervals(parseIv('1W')).map(formatInterval)).toEqual(['1D']);
    expect(tickIntervals(parseIv('1m'))).toEqual([]);
    expect(tickIntervals(parseIv('12M'))).toEqual([]);
  });

  it.each([
    ['5m', 1, '1m', null],
    ['15m', 1, '1m', null],
    ['15m', 40, '5m', null],
    ['5m', 40, null, 'Intrabar data for 1m only covers the last 29 days; replaying whole bars.'],
    ['1h', 1, '1m', null],
    ['1h', 40, '2m', null],
    ['1h', 100, null, 'Intrabar data for 30m only covers the last 59 days; replaying whole bars.'],
    ['4h', 1, '2m', null],
    ['4h', 100, '1h', null],
    ['1D', 1, '15m', null],
    ['1D', 100, '1h', null],
    ['1D', 1000, null, 'Intrabar data for 1h only covers the last 729 days; replaying whole bars.'],
    ['1W', 1000, '1D', null],
    ['1M', 3000, '1D', null],
    ['12M', 1, null, null],
    ['1m', 1, null, null],
  ])('%s starting %i days ago -> %s', (chart, days, tick, warning) => {
    expect(choose(chart, days)).toEqual({ tick, warning });
  });

  it('honours bars and explicit intervals, and rejects invalid ones', () => {
    expect(choose('1D', 1, 'bars')).toEqual({ tick: null, warning: null });
    expect(choose('1h', 1, M(5))).toEqual({ tick: '5m', warning: null });
    expect(choose('1h', 40, M(1))).toEqual({
      tick: null,
      warning: 'Intrabar data for 1m only covers the last 29 days; replaying whole bars.',
    });
    expect(() => choose('15m', 1, M(2))).toThrow(/not a valid tick interval/);
    expect(() => choose('1h', 1, M(7))).toThrow(/not a valid tick interval/);
    expect(
      chooseTick(parseIv('1D'), {
        update: 'auto',
        start: NOW - DAY,
        now: NOW,
        lookbackSeconds,
      }).candidates.map(formatInterval),
    ).toEqual(['15m', '30m', '1h']);
  });
});

describe('ReplayFeed intrabar', () => {
  const HOURS = evenly(MON, 24 * 10, HOUR);
  const HOURLY = bars(HOURS, 2);
  const DAILY10 = bars(evenly(MON, 10, DAY), 9);
  /** 1D chart replayed from 1h ticks (finer intervals excluded by lookback). */
  async function intrabar(data: Record<string, Bar[]> = {}) {
    const inner = new FakeFeed({ 'AAA|1D': DAILY10, 'AAA|1h': HOURLY, ...data });
    const feed = new ReplayFeed(inner, {
      now: FAR_FUTURE,
      lookbackSeconds: (iv) => (intervalSeconds(iv) < HOUR ? 0 : null),
    });
    const info = await feed.start({
      symbol: 'AAA',
      interval: D1,
      lastVisible: MON + 3 * DAY,
      update: 'auto',
      prepost: false,
    });
    return { inner, feed, info };
  }
  const agg = (time: number, list: Bar[]): Bar => ({
    time,
    open: (list[0] as Bar).open,
    high: Math.max(...list.map((b) => b.high)),
    low: Math.min(...list.map((b) => b.low)),
    close: (list[list.length - 1] as Bar).close,
    volume: list.reduce((v, b) => v + b.volume, 0),
  });

  it('aggregates revealed ticks into the forming chart bar', async () => {
    const { feed, info } = await intrabar();
    expect(info).toEqual({ tick: H1, warning: null });
    const day4 = MON + 4 * DAY;
    expect(feed.clock).toEqual({ last: day4 - HOUR, next: day4 });
    const res = await feed.getBars({ symbol: 'AAA', interval: D1, limit: 100 });
    expect(times(res.bars).at(-1)).toBe(MON + 3 * DAY);
    const s = collect(feed, 'AAA', D1);
    await flush();
    expect(s.got).toEqual([]);
    await feed.step();
    expect(feed.clock).toEqual({ last: day4, next: day4 + HOUR });
    expect(s.got).toEqual([agg(day4, HOURLY.slice(96, 97))]);
    await feed.step();
    await feed.step();
    expect(s.got.at(-1)).toEqual(agg(day4, HOURLY.slice(96, 99)));
    // The forming bar stays out of getBars.
    const again = await feed.getBars({ symbol: 'AAA', interval: D1, limit: 100 });
    expect(times(again.bars).at(-1)).toBe(MON + 3 * DAY);
  });

  it('settles the native bar before the first aggregate of the next bar', async () => {
    const { feed } = await intrabar();
    const s = collect(feed, 'AAA', D1);
    await flush();
    for (let i = 0; i < 25; i++) await feed.step();
    const day5 = MON + 5 * DAY;
    expect(feed.clock.next).toBe(day5 + HOUR);
    const tail = s.got.slice(-3);
    // Revealing the day's last tick moves E to the next bar: it closes and settles.
    expect(tail[0]).toEqual(agg(MON + 4 * DAY, HOURLY.slice(96, 119)));
    expect(tail[1]).toEqual(DAILY10[4]);
    expect(tail[2]).toEqual(agg(day5, HOURLY.slice(120, 121)));
  });

  it('builds rule-A buckets from closed bars plus the forming bar', async () => {
    const { feed } = await intrabar();
    const s = collect(feed, 'AAA', { unit: 'day', count: 2 });
    await flush();
    // 2D buckets are even day numbers from the epoch; MON (2024-01-01) is day 19723.
    const bucket = MON + 3 * DAY;
    expect(s.got).toEqual([agg(bucket, DAILY10.slice(3, 4))]);
    await feed.step();
    expect(s.got.at(-1)).toEqual(agg(bucket, [DAILY10[3] as Bar, ...HOURLY.slice(96, 97)]));
  });

  it('falls back to the next candidate when the first has no data at the start', async () => {
    const inner = new FakeFeed({
      'AAA|1D': DAILY10,
      'AAA|1h': HOURLY,
      'AAA|15m': [],
      'AAA|30m': bars(evenly(MON, 24 * 2, 30 * MIN)), // ends before the start
    });
    const feed = new ReplayFeed(inner, { now: FAR_FUTURE });
    const info = await feed.start({
      symbol: 'AAA',
      interval: D1,
      lastVisible: MON + 3 * DAY,
      update: 'auto',
      prepost: false,
    });
    expect(info).toEqual({ tick: H1, warning: null });
  });

  it('replays whole bars with a warning when no candidate has data', async () => {
    const inner = new FakeFeed({ 'AAA|1D': DAILY10, 'AAA|1h': [], 'AAA|15m': [], 'AAA|30m': [] });
    const feed = new ReplayFeed(inner, {
      now: FAR_FUTURE,
      lookbackSeconds: (iv) => (intervalSeconds(iv) === HOUR ? 729 * DAY : null),
    });
    const warnings: string[] = [];
    feed.on('warning', (w) => warnings.push(w));
    const info = await feed.start({
      symbol: 'AAA',
      interval: D1,
      lastVisible: MON + 3 * DAY,
      update: 'auto',
      prepost: false,
    });
    const text = 'Intrabar data for 1h only covers the last 729 days; replaying whole bars.';
    expect(info).toEqual({ tick: null, warning: text });
    expect(warnings).toEqual([text]);
    expect(await feed.step()).toBe('ok');
    expect(feed.clock.next).toBe(MON + 5 * DAY);
  });

  it('rejects an explicit update interval that does not fit the chart', async () => {
    const { feed } = await intrabar();
    const epoch = feed.epoch;
    await expect(
      feed.start({
        symbol: 'AAA',
        interval: D1,
        lastVisible: MON + 3 * DAY,
        update: { unit: 'minute', count: 7 },
        prepost: false,
      }),
    ).rejects.toThrow(/not a valid tick interval/);
    expect(feed.epoch).toBe(epoch);
    expect(feed.clock.next).toBe(MON + 4 * DAY);
  });
});

describe('ReplayFeed intrabar snapping', () => {
  const N = 3 * 24 * 60;
  function feedFor() {
    const inner = new FakeFeed({
      'AAA|1m': bars(evenly(MON, N, MIN)),
      'AAA|5m': bars(evenly(MON, N / 5, 5 * MIN), 1),
      'AAA|15m': bars(evenly(MON, N / 15, 15 * MIN), 2),
      'AAA|1D': bars(evenly(MON, 3, DAY), 3),
    });
    return new ReplayFeed(inner, { now: FAR_FUTURE });
  }

  it('5m -> 1D snaps E back to the newest 15m tick', async () => {
    const feed = feedFor();
    const info = await feed.start({
      symbol: 'AAA',
      interval: { unit: 'minute', count: 5 },
      lastVisible: MON + 14 * HOUR + 10 * MIN,
      update: 'auto',
      prepost: false,
    });
    expect(info.tick).toEqual({ unit: 'minute', count: 1 });
    expect(feed.clock.next).toBe(MON + 14 * HOUR + 15 * MIN);
    await feed.step();
    await feed.step();
    expect(feed.clock.next).toBe(MON + 14 * HOUR + 17 * MIN);
    const epoch = feed.epoch;
    const next = await feed.setPrimary('AAA', D1);
    expect(next.tick).toEqual({ unit: 'minute', count: 15 });
    expect(feed.clock).toEqual({ last: MON + 14 * HOUR, next: MON + 14 * HOUR + 15 * MIN });
    expect(feed.epoch).toBe(epoch + 1);
  });

  it('1D -> 5m keeps E when it is a 1m tick', async () => {
    const feed = feedFor();
    await feed.start({
      symbol: 'AAA',
      interval: D1,
      lastVisible: MON,
      update: 'auto',
      prepost: false,
    });
    for (let i = 0; i < 3; i++) await feed.step();
    const e = MON + DAY + 45 * MIN;
    expect(feed.clock.next).toBe(e);
    const epoch = feed.epoch;
    const next = await feed.setPrimary('AAA', { unit: 'minute', count: 5 });
    expect(next.tick).toEqual({ unit: 'minute', count: 1 });
    expect(feed.clock.next).toBe(e);
    expect(feed.epoch).toBe(epoch);
    await feed.step();
    expect(feed.clock.next).toBe(e + MIN);
  });
});

describe('ReplayFeed visibility property', () => {
  /** Deterministic PRNG. */
  function rng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 2 ** 32;
    };
  }

  /** Bars whose prices depend on the bar time only, so a close identifies its source bar. */
  function timed(times: number[], seed: number): Bar[] {
    return times.map((time) => {
      const p = 100 + seed + Math.sin(time / 7919) * 5;
      return { time, open: p - 0.25, high: p + 1, low: p - 1, close: p, volume: 1 + (time % 7) };
    });
  }

  it('never returns or emits a bar at or after E, nor prices from ticks at or after E', async () => {
    const data: Record<string, Bar[]> = {};
    const sources = new Map<string, Bar[]>();
    const add = (sym: string, iv: string, list: Bar[]) => {
      data[`${sym}|${iv}`] = list;
      sources.set(sym, [...(sources.get(sym) ?? []), ...list]);
    };
    for (const [sym, seed, off] of [
      ['AAA', 0, 0],
      ['BBB', 20, 30 * MIN],
    ] as const) {
      add(sym, '15m', timed(evenly(MON + (off % (15 * MIN)), 24 * 4 * 50, 15 * MIN), seed));
      add(sym, '1h', timed(evenly(MON + off, 24 * 50, HOUR), seed + 1));
      add(sym, '1D', timed(evenly(MON + (sym === 'BBB' ? 13 * HOUR : 0), 50, DAY), seed + 2));
      add(sym, '1W', timed(evenly(MON, 8, 7 * DAY), seed + 3));
    }
    const ivs = [H1, H4, D1, D2, W1];
    const syms = ['AAA', 'BBB', 'AAA/BBB'];
    // Only 15m and coarser ticks have data.
    const lookbackSeconds = (iv: Interval) => (intervalSeconds(iv) < 15 * MIN ? 0 : null);
    for (let seed = 1; seed <= 10; seed++) {
      const r = rng(seed);
      const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
      const feed = new ReplayFeed(new ExpressionFeed(new ResamplingFeed(new FakeFeed(data))), {
        now: FAR_FUTURE,
        lookbackSeconds,
      });
      const violations: string[] = [];
      const check = (where: string, sym: string, b: Bar) => {
        const e = feed.clock.next;
        if (!(b.time < e)) violations.push(`${where}: ${b.time} >= ${e}`);
        const src = sources.get(sym);
        // The close must come from a source bar (or tick) that opened before E.
        if (src !== undefined && !src.some((x) => x.close === b.close && x.time < e)) {
          violations.push(`${where}: close ${b.close} of ${b.time} not revealed at ${e}`);
        }
      };
      const update = pick(['auto', 'bars'] as const);
      await feed.start({
        symbol: pick(['AAA', 'BBB']),
        interval: pick([H1, H4, D1]),
        lastVisible: MON + Math.floor(r() * 20 * DAY),
        update,
        prepost: false,
      });
      for (let op = 0; op < 60; op++) {
        const x = r();
        if (x < 0.5) {
          await feed.step();
        } else if (x < 0.7) {
          const iv = pick(ivs);
          const sym = pick(syms);
          const req: GetBarsRequest = { symbol: sym, interval: iv, limit: 50 };
          if (r() < 0.3) req.to = feed.clock.next + Math.floor(r() * 5 * DAY);
          const res = await feed.getBars(req);
          for (let i = 0; i < res.bars.time.length; i++) {
            check(`getBars ${sym} ${formatInterval(iv)}`, sym, {
              time: res.bars.time[i] as number,
              open: res.bars.open[i] as number,
              high: res.bars.high[i] as number,
              low: res.bars.low[i] as number,
              close: res.bars.close[i] as number,
              volume: res.bars.volume[i] as number,
            });
          }
        } else if (x < 0.9) {
          const iv = pick(ivs);
          const sym = pick(['AAA', 'BBB']);
          feed.subscribe({ symbol: sym, interval: iv }, null, (b) =>
            check(`subscribe ${sym} ${formatInterval(iv)}`, sym, b),
          );
        } else {
          await feed.setPrimary(pick(['AAA', 'BBB']), pick([H1, H4, D1]));
        }
      }
      await flush();
      expect(violations).toEqual([]);
      if (update === 'auto') expect(feed.clock.next).toBeGreaterThan(MON);
    }
  });
});

// ---------------------------------------------------------------------------
// Chart integration: just enough DOM for the Chart constructor.

class FakeEl {
  className = '';
  id = '';
  innerHTML = '';
  textContent = '';
  tabIndex = 0;
  width = 0;
  height = 0;
  style: Record<string, unknown> = { setProperty: () => undefined };
  children: FakeEl[] = [];
  parent: FakeEl | null = null;
  appendChild(c: FakeEl): FakeEl {
    c.parent = this;
    this.children.push(c);
    return c;
  }
  remove(): void {
    const p = this.parent;
    if (p) p.children.splice(p.children.indexOf(this), 1);
    this.parent = null;
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  getContext(): object {
    return {};
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 800, height: 600 };
  }
}

describe('Chart + ReplayFeed over SyntheticFeed', () => {
  const charts: Chart[] = [];

  beforeAll(() => {
    vi.stubGlobal('document', {
      createElement: () => new FakeEl(),
      getElementById: () => null,
      head: new FakeEl(),
    });
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        disconnect(): void {}
      },
    );
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
  });

  afterEach(() => {
    for (const c of charts.splice(0)) c.destroy();
  });

  it('shows the picked bar last after reload and appends one bar per step', async () => {
    const { Chart } = await import('../chart');
    const end = 1_700_000_000;
    const synthetic = new SyntheticFeed(500, end);
    const feed = new ReplayFeed(synthetic, { now: () => end + DAY });
    const chart = new Chart(new FakeEl() as unknown as HTMLElement, feed);
    charts.push(chart);
    await chart.setSymbolAndInterval('SYN', '1D');
    expect(chart.store.length).toBe(500);

    const picked = end - 99 * DAY;
    await feed.start({
      symbol: 'SYN',
      interval: D1,
      lastVisible: picked,
      update: 'bars',
      prepost: false,
    });
    await chart.reload();
    expect(chart.store.length).toBe(401);
    expect(chart.store.last()?.time).toBe(picked);

    const appended: number[] = [];
    chart.on('seriesChange', (c) => {
      if (c.kind === 'append') appended.push(c.index);
    });
    expect(await feed.step()).toBe('ok');
    expect(chart.store.length).toBe(402);
    expect(chart.store.last()?.time).toBe(picked + DAY);
    expect(appended).toEqual([401]);

    feed.stop();
    await chart.reload();
    expect(chart.store.length).toBe(500);
  });

  it('replays a daily chart intrabar from 15m ticks', async () => {
    const { Chart } = await import('../chart');
    const end = 1_700_000_000;
    const feed = new ReplayFeed(new SyntheticFeed(5000, end), { now: () => end + DAY });
    const chart = new Chart(new FakeEl() as unknown as HTMLElement, feed);
    charts.push(chart);
    chart.applyOptions({ pageSize: 100 });
    await chart.setSymbolAndInterval('SYN', '1D');

    const picked = end - 10 * DAY;
    const info = await feed.start({
      symbol: 'SYN',
      interval: D1,
      lastVisible: picked,
      update: 'auto',
      prepost: false,
    });
    expect(info.tick).toEqual({ unit: 'minute', count: 15 });
    await chart.reload();
    expect(chart.store.last()?.time).toBe(picked);
    const n = chart.store.length;

    await feed.step(); // first 15m tick of the next day: a new forming bar
    expect(chart.store.length).toBe(n + 1);
    expect(chart.store.last()?.time).toBe(picked + DAY);
    await feed.step(); // second tick updates it in place
    expect(chart.store.length).toBe(n + 1);
    for (let i = 0; i < 95; i++) await feed.step();
    // 96 ticks per day: the 97th step starts the bar after.
    expect(chart.store.length).toBe(n + 2);
    expect(chart.store.last()?.time).toBe(picked + 2 * DAY);
  });
});
