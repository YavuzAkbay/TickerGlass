import { describe, expect, it, vi } from 'vitest';
import type {
  Bar,
  BarColumns,
  BarListener,
  DataFeed,
  GetBarsRequest,
  GetBarsResult,
  SubscribeRequest,
  SymbolInfo,
} from '../types';
import { ExpressionFeed } from './expression-feed';
import { FeedError } from './http-feed';
import { SyntheticFeed } from './synthetic-feed';

const DAY = 86_400;
const HOUR = 3600;
const D1 = { unit: 'day', count: 1 } as const;
const H1 = { unit: 'hour', count: 1 } as const;

interface Series {
  time: number[];
  open: number[];
  high: number[];
  low: number[];
  close: number[];
}

/** Bars from closes: open = close - 1, high = close + 2, low = close - 2. */
function fromCloses(time: number[], close: number[]): Series {
  return {
    time: [...time],
    open: close.map((c) => c - 1),
    high: close.map((c) => c + 2),
    low: close.map((c) => c - 2),
    close: [...close],
  };
}

function info(symbol: string, over: Partial<SymbolInfo> = {}): SymbolInfo {
  return {
    symbol,
    name: symbol,
    exchange: null,
    exchangeName: null,
    type: 'equity',
    currency: 'USD',
    timezone: 'America/New_York',
    session: '0930-1600',
    priceHint: 2,
    minTick: 0.01,
    ...over,
  };
}

interface Sub {
  req: SubscribeRequest;
  lastBar: Bar | null;
  listener: BarListener | null;
}

/** In-memory feed with API paging semantics: newest `limit` bars with t < to. */
class FakeFeed implements DataFeed {
  readonly requests: GetBarsRequest[] = [];
  readonly subs: Sub[] = [];
  /** Symbols reporting hasMore = true regardless of the data. */
  readonly forceHasMore = new Set<string>();

  constructor(
    readonly data: Record<string, Series>,
    readonly infos: Record<string, SymbolInfo>,
  ) {}

  resolveSymbol = vi.fn(async (symbol: string): Promise<SymbolInfo> => {
    const i = this.infos[symbol];
    if (i === undefined) throw new FeedError(`Unknown symbol ${symbol}`, 404);
    return i;
  });

  searchSymbols = vi.fn(async () => []);

  getBars = vi.fn(async (req: GetBarsRequest): Promise<GetBarsResult> => {
    this.requests.push(req);
    const s = this.data[req.symbol];
    if (s === undefined) throw new FeedError(`Unknown symbol ${req.symbol}`, 404);
    let end = s.time.length;
    if (req.to !== undefined) {
      end = 0;
      while (end < s.time.length && (s.time[end] as number) < req.to) end++;
    }
    const start = Math.max(0, end - req.limit);
    const f = (a: number[]) => Float64Array.from(a.slice(start, end));
    return {
      bars: {
        time: f(s.time),
        open: f(s.open),
        high: f(s.high),
        low: f(s.low),
        close: f(s.close),
        volume: new Float64Array(end - start).fill(1000),
      },
      hasMore: start > 0 || this.forceHasMore.has(req.symbol),
    };
  });

  subscribe = vi.fn((req: SubscribeRequest, lastBar: Bar | null, onBar: BarListener) => {
    const sub: Sub = { req, lastBar, listener: onBar };
    this.subs.push(sub);
    return () => {
      sub.listener = null;
    };
  });

  /** Push a live bar for `symbol` and record it in the data (as a reload would see it). */
  push(symbol: string, bar: Omit<Bar, 'volume'>): void {
    const s = this.data[symbol] as Series;
    const i = s.time.indexOf(bar.time);
    if (i >= 0) {
      s.open[i] = bar.open;
      s.high[i] = bar.high;
      s.low[i] = bar.low;
      s.close[i] = bar.close;
    } else {
      s.time.push(bar.time);
      s.open.push(bar.open);
      s.high.push(bar.high);
      s.low.push(bar.low);
      s.close.push(bar.close);
    }
    for (const sub of this.subs) {
      if (sub.req.symbol === symbol) sub.listener?.({ ...bar, volume: 1 });
    }
  }
}

// Jan 2, 3, 4, 5, 8 2024 at New York midnight.
const AAPL_T = [1704171600, 1704258000, 1704344400, 1704430800, 1704690000];
const AAPL_C = [185, 184, 182, 181, 185];
// Jan 1..8 2024 at UTC midnight.
const BTC_T = Array.from({ length: 8 }, (_, k) => 1704067200 + k * DAY);
const BTC_C = Array.from({ length: 8 }, (_, k) => 100 + k);

function dailyFeed(): FakeFeed {
  return new FakeFeed(
    {
      AAPL: fromCloses(AAPL_T, AAPL_C),
      'BTC-USD': fromCloses(BTC_T, BTC_C),
    },
    {
      AAPL: info('AAPL'),
      'BTC-USD': info('BTC-USD', { timezone: 'UTC', session: null, type: 'crypto' }),
    },
  );
}

function expectCloses(bars: BarColumns, expected: number[]): void {
  expect(bars.close.length).toBe(expected.length);
  expected.forEach((v, i) => expect(bars.close[i]).toBeCloseTo(v, 12));
}

async function pageAll(feed: DataFeed, req: GetBarsRequest): Promise<BarColumns[]> {
  const pages: BarColumns[] = [];
  let to: number | undefined;
  for (let i = 0; i < 1000; i++) {
    const r: GetBarsRequest = { ...req };
    if (to !== undefined) r.to = to;
    const res = await feed.getBars(r);
    pages.unshift(res.bars);
    if (!res.hasMore || res.bars.time.length === 0) break;
    to = res.bars.time[0];
  }
  return pages;
}

function concat(pages: BarColumns[], field: keyof BarColumns): number[] {
  return pages.flatMap((p) => [...p[field]]);
}

/** Seeded LCG in [0, 1). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** Random walk with distinct O/H/L/C at the given times. */
function walk(time: number[], seed: number, start: number): Series {
  const rand = lcg(seed);
  const s: Series = { time: [...time], open: [], high: [], low: [], close: [] };
  let p = start;
  for (let i = 0; i < time.length; i++) {
    const o = p * (1 + (rand() - 0.5) * 0.01);
    const c = o * (1 + (rand() - 0.5) * 0.04);
    s.open.push(o);
    s.close.push(c);
    s.high.push(Math.max(o, c) * (1 + rand() * 0.02));
    s.low.push(Math.min(o, c) * (1 - rand() * 0.02));
    p = c;
  }
  return s;
}

/** Local-midnight daily stamps for weekdays, skipping days where `skip` is true. */
function weekdayStamps(firstMidnightUtc: number, days: number, skip: (d: number) => boolean) {
  const out: number[] = [];
  for (let d = 0; d < days; d++) {
    const t = firstMidnightUtc + d * DAY;
    // Weekday of the local date (the stamp is local midnight of that date).
    const dow = new Date((t + 12 * HOUR) * 1000).getUTCDay();
    if (dow === 0 || dow === 6 || skip(d)) continue;
    out.push(t);
  }
  return out;
}

describe('ExpressionFeed getBars', () => {
  it('aligns a daily crypto leg onto equity bars (AAPL/BTC-USD)', async () => {
    const feed = new ExpressionFeed(dailyFeed());
    const res = await feed.getBars({ symbol: 'aapl/btc-usd', interval: D1, limit: 100 });
    expect([...res.bars.time]).toEqual(AAPL_T);
    expectCloses(res.bars, [185 / 101, 184 / 102, 182 / 103, 181 / 104, 185 / 107]);
    expect([...res.bars.volume]).toEqual([0, 0, 0, 0, 0]);
    expect(res.hasMore).toBe(false);
  });

  it('forward-fills the equity leg on a crypto time axis (BTC-USD/AAPL)', async () => {
    const feed = new ExpressionFeed(dailyFeed());
    const res = await feed.getBars({ symbol: 'BTC-USD/AAPL', interval: D1, limit: 100 });
    // Jan 1 has no AAPL value yet and is dropped.
    expect([...res.bars.time]).toEqual(BTC_T.slice(1));
    expectCloses(res.bars, [
      101 / 185,
      102 / 184,
      103 / 182,
      104 / 181,
      105 / 181,
      106 / 181,
      107 / 185,
    ]);
    // Jan 6 uses AAPL Jan 5 forward-filled: O = H = L = C = 181 for that leg.
    // BTC Jan 6: O 104, H 107, L 103, C 105 -> O 104/181, envelope of 104/181..107/181.
    expect(res.bars.open[4]).toBeCloseTo(104 / 181, 12);
    expect(res.bars.high[4]).toBeCloseTo(107 / 181, 12);
    expect(res.bars.low[4]).toBeCloseTo(103 / 181, 12);
  });

  it('two pages via `to` equal one big fetch (daily, three legs, holidays)', async () => {
    // NY midnight Jan 2 2023 (EST) and Tokyo midnight Jan 2 2023 (15:00Z Jan 1).
    const nyStart = 1672635600;
    const tkStart = 1672585200;
    const aaplT = weekdayStamps(nyStart, 420, (d) => d % 29 === 3);
    // Tokyo starts later (Feb 2023) and has its own holidays, so rows forward-fill.
    const tkT = weekdayStamps(tkStart + 30 * DAY, 390, (d) => d % 7 === 2 || d % 11 === 0);
    const btcT = Array.from({ length: 450 }, (_, k) => 1672531200 - 10 * DAY + k * DAY);
    const inner = new FakeFeed(
      { AAPL: walk(aaplT, 1, 150), '7203.T': walk(tkT, 2, 2500), 'BTC-USD': walk(btcT, 3, 20000) },
      {
        AAPL: info('AAPL'),
        '7203.T': info('7203.T', { timezone: 'Asia/Tokyo', session: '0900-1500', currency: 'JPY' }),
        'BTC-USD': info('BTC-USD', { timezone: 'UTC', session: null }),
      },
    );
    const feed = new ExpressionFeed(inner);
    const symbol = 'AAPL*100/"7203.T" + BTC-USD/1000';
    const big = await feed.getBars({ symbol, interval: D1, limit: 100_000 });
    expect(big.hasMore).toBe(false);
    expect(big.bars.time.length).toBeGreaterThan(200);

    for (const limit of [7, 37]) {
      const pages = await pageAll(feed, { symbol, interval: D1, limit });
      expect(pages.length).toBeGreaterThan(2);
      const times = concat(pages, 'time');
      for (let i = 1; i < times.length; i++)
        expect(times[i]).toBeGreaterThan(times[i - 1] as number);
      expect(times).toEqual([...big.bars.time]);
      expect(concat(pages, 'open')).toEqual([...big.bars.open]);
      expect(concat(pages, 'high')).toEqual([...big.bars.high]);
      expect(concat(pages, 'low')).toEqual([...big.bars.low]);
      expect(concat(pages, 'close')).toEqual([...big.bars.close]);
    }
    // Some rows really are forward-filled (envelope collapses for the stale leg).
    expect(big.bars.time.length).toBeLessThan(aaplT.length);
  });

  it('two pages via `to` equal one big fetch (hourly, gappy second leg)', async () => {
    const t0 = 1704200400; // 2024-01-02 13:00Z
    const aT = Array.from({ length: 900 }, (_, k) => t0 + k * HOUR);
    const bT = aT.filter((_, k) => k % 5 !== 1 && k % 13 !== 4).map((t) => t - 1800);
    const inner = new FakeFeed(
      { A: walk(aT, 7, 100), B: walk(bT, 8, 50) },
      { A: info('A', { timezone: 'UTC' }), B: info('B', { timezone: 'UTC' }) },
    );
    const feed = new ExpressionFeed(inner);
    const big = await feed.getBars({ symbol: 'A - 2*B', interval: H1, limit: 100_000 });
    const pages = await pageAll(feed, { symbol: 'A - 2*B', interval: H1, limit: 50 });
    expect(pages.length).toBeGreaterThan(2);
    for (const f of ['time', 'open', 'high', 'low', 'close'] as const) {
      expect(concat(pages, f)).toEqual([...big.bars[f]]);
    }
  });

  it('cuts rows before a still-paging leg starts and reports hasMore', async () => {
    const inner = dailyFeed();
    // BTC only returns Jan 4..8 but claims more history.
    const btc = inner.data['BTC-USD'] as Series;
    inner.data['BTC-USD'] = fromCloses(btc.time.slice(3), btc.close.slice(3));
    inner.forceHasMore.add('BTC-USD');
    const feed = new ExpressionFeed(inner);
    const res = await feed.getBars({ symbol: 'AAPL/BTC-USD', interval: D1, limit: 100 });
    expect([...res.bars.time]).toEqual(AAPL_T.slice(2));
    expectCloses(res.bars, [182 / 103, 181 / 104, 185 / 107]);
    expect(res.hasMore).toBe(true);
  });

  it('requests other legs over the primary span plus staleness, extended for calendar keys', async () => {
    const inner = dailyFeed();
    const feed = new ExpressionFeed(inner);
    const to = 1704700000;
    await feed.getBars({ symbol: 'AAPL/BTC-USD', interval: D1, limit: 3, to });
    const legReq = inner.requests.find((r) => r.symbol === 'BTC-USD') as GetBarsRequest;
    expect(legReq.to).toBe(to + 2 * DAY);
    const primReq = inner.requests.find((r) => r.symbol === 'AAPL') as GetBarsRequest;
    expect(primReq.limit).toBe(4);
    // Primary first bar Jan 3 (lead-in row), 10 d stale, 2 d pad.
    const span = to + 2 * DAY - (AAPL_T[1] as number) + 12 * DAY;
    expect(legReq.limit).toBe(Math.ceil(span / DAY) + 2);
  });

  it('omits rows where a divisor leg is 0', async () => {
    const inner = dailyFeed();
    (inner.data['BTC-USD'] as Series).close[3] = 0; // Jan 4
    const feed = new ExpressionFeed(inner);
    const res = await feed.getBars({ symbol: 'AAPL/BTC-USD', interval: D1, limit: 100 });
    expect([...res.bars.time]).toEqual([AAPL_T[0], AAPL_T[1], AAPL_T[3], AAPL_T[4]]);
  });

  it('passes plain symbols straight through', async () => {
    const inner = dailyFeed();
    const feed = new ExpressionFeed(inner);
    const res = await feed.getBars({ symbol: 'aapl', interval: D1, limit: 2 });
    expect(inner.getBars).toHaveBeenCalledTimes(1);
    expect(inner.getBars).toHaveBeenCalledWith({ symbol: 'AAPL', interval: D1, limit: 2 });
    expect([...res.bars.time]).toEqual(AAPL_T.slice(3));
    expect(res.bars.volume[0]).toBe(1000);
    await feed.resolveSymbol('BTC-USD');
    expect(inner.resolveSymbol).toHaveBeenCalledWith('BTC-USD');
    const onBar = vi.fn();
    feed.subscribe({ symbol: 'aapl', interval: D1 }, null, onBar);
    expect(inner.subscribe).toHaveBeenCalledWith({ symbol: 'AAPL', interval: D1 }, null, onBar);
  });

  it('rejects invalid expressions with a FeedError', async () => {
    const feed = new ExpressionFeed(dailyFeed());
    await expect(feed.getBars({ symbol: 'AAPL/', interval: D1, limit: 5 })).rejects.toThrow(
      FeedError,
    );
    const small = new ExpressionFeed(dailyFeed(), { maxLegs: 1 });
    await expect(small.resolveSymbol('AAPL/BTC-USD')).rejects.toThrow('Too many symbols (max 1)');
  });
});

describe('ExpressionFeed resolveSymbol', () => {
  const infos = {
    AAPL: info('AAPL'),
    MSFT: info('MSFT', { priceHint: 3 }),
    '7203.T': info('7203.T', { timezone: 'Asia/Tokyo', session: '0900-1500', currency: 'JPY' }),
  };
  const feed = new ExpressionFeed(new FakeFeed({}, infos));

  it('describes a ratio', async () => {
    const r = await feed.resolveSymbol('aapl/msft');
    expect(r).toEqual({
      symbol: 'AAPL/MSFT',
      name: 'AAPL/MSFT',
      exchange: null,
      exchangeName: 'Expression',
      type: 'expression',
      currency: null, // not linear
      timezone: 'America/New_York',
      session: '0930-1600',
      priceHint: 4,
      minTick: 1e-4,
    });
  });

  it('keeps currency for linear expressions in one currency', async () => {
    const r = await feed.resolveSymbol('(AAPL+MSFT)/2');
    expect(r.currency).toBe('USD');
    expect(r.priceHint).toBe(3);
    expect(r.minTick).toBeCloseTo(0.001, 15);
  });

  it('drops currency and session across exchanges; timezone is the primary leg', async () => {
    const r = await feed.resolveSymbol('7203.T - AAPL');
    expect(r.currency).toBeNull();
    expect(r.session).toBeNull();
    expect(r.timezone).toBe('Asia/Tokyo');
  });

  it('names an unknown leg, with a spread hint for hyphenated symbols', async () => {
    await expect(feed.resolveSymbol('AAPL/FOO')).rejects.toThrow(
      /^Unknown symbol in expression: FOO$/,
    );
    const err = await feed.resolveSymbol('AAPL-MSFT*2').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FeedError);
    expect((err as FeedError).status).toBe(404);
    expect((err as FeedError).message).toBe(
      'Unknown symbol in expression: AAPL-MSFT — for a spread put spaces around the minus: A - B',
    );
  });
});

describe('ExpressionFeed subscribe', () => {
  const T = [0, 1, 2, 3].map((k) => 1704200400 + k * HOUR);

  function hourlyFeed(): FakeFeed {
    return new FakeFeed(
      {
        A: fromCloses(T, [100, 102, 104, 106]),
        B: fromCloses(T.slice(0, 3), [10, 20, 40]),
      },
      {
        A: info('A'),
        B: info('B', { timezone: 'Europe/London', session: '0800-1630' }),
      },
    );
  }

  async function setup() {
    const inner = hourlyFeed();
    const feed = new ExpressionFeed(inner);
    const req = { symbol: 'A/B', interval: H1 };
    // As the chart does: resolve first (legs become known), then load, then stream.
    await feed.resolveSymbol(req.symbol);
    const res = await feed.getBars({ ...req, limit: 100 });
    const n = res.bars.time.length;
    const last: Bar = {
      time: res.bars.time[n - 1] as number,
      open: res.bars.open[n - 1] as number,
      high: res.bars.high[n - 1] as number,
      low: res.bars.low[n - 1] as number,
      close: res.bars.close[n - 1] as number,
      volume: 0,
    };
    const bars: Bar[] = [];
    const unsub = feed.subscribe(
      { ...req, timezone: 'America/New_York', session: '0930-1600' },
      last,
      (b) => bars.push(b),
    );
    // Reload of the same data, for comparing live output with history.
    const reload = async (): Promise<Bar> => {
      const r = await new ExpressionFeed(inner).getBars({ ...req, limit: 100 });
      const k = r.bars.time.length - 1;
      return {
        time: r.bars.time[k] as number,
        open: r.bars.open[k] as number,
        high: r.bars.high[k] as number,
        low: r.bars.low[k] as number,
        close: r.bars.close[k] as number,
        volume: 0,
      };
    };
    return { inner, feed, res, bars, unsub, reload };
  }

  it('subscribes every leg with its own timezone and last bar', async () => {
    const { inner, res } = await setup();
    // Last row: A 106 at T3 over stale B 40.
    expect([...res.bars.close]).toEqual([10, 5.1, 2.6, 106 / 40]);
    expect(inner.subs.map((s) => s.req)).toEqual([
      { symbol: 'A', interval: H1, timezone: 'America/New_York', session: '0930-1600' },
      { symbol: 'B', interval: H1, timezone: 'Europe/London', session: '0800-1630' },
    ]);
    expect(inner.subs[0]?.lastBar?.close).toBe(106);
    expect(inner.subs[1]?.lastBar?.close).toBe(40);
  });

  it('emits on primary update and append, matching a reload', async () => {
    const { inner, bars, reload } = await setup();
    inner.push('A', { time: T[3] as number, open: 105, high: 110, low: 104, close: 108 });
    expect(bars).toHaveLength(1);
    expect(bars[0]).toEqual({
      time: T[3],
      open: 105 / 40,
      high: 110 / 40,
      low: 104 / 40,
      close: 108 / 40,
      volume: 0,
    });
    expect(bars[0]).toEqual(await reload());

    const t4 = (T[3] as number) + HOUR;
    inner.push('A', { time: t4, open: 108, high: 109, low: 100, close: 101 });
    expect(bars).toHaveLength(2);
    expect(bars[1]).toEqual({
      time: t4,
      open: 108 / 40,
      high: 109 / 40,
      low: 100 / 40,
      close: 101 / 40,
      volume: 0,
    });
    expect(bars[1]).toEqual(await reload());
  });

  it('updates the last row on a non-primary tick', async () => {
    const { inner, bars, reload } = await setup();
    // B's bar at T3 arrives: the row at T3 is no longer forward-filled.
    inner.push('B', { time: T[3] as number, open: 50, high: 53, low: 49, close: 53 });
    expect(bars).toHaveLength(1);
    const row = bars[0] as Bar;
    expect(row.time).toBe(T[3]);
    expect(row.open).toBeCloseTo(105 / 50, 12);
    expect(row.close).toBeCloseTo(106 / 53, 12);
    // f(H) = 108/53, f(L) = 104/49: H = max(O, C, f(H), f(L)), L = min(...).
    expect(row.high).toBeCloseTo(104 / 49, 12);
    expect(row.low).toBeCloseTo(106 / 53, 12);
    expect(row).toEqual(await reload());
  });

  it('holds a non-primary bar newer than the current row until the primary appends', async () => {
    const { inner, bars, reload } = await setup();
    const t4 = (T[3] as number) + HOUR;
    inner.push('B', { time: t4, open: 40, high: 41, low: 39, close: 41 });
    expect(bars).toHaveLength(0);
    inner.push('A', { time: t4, open: 106, high: 107, low: 105, close: 107 });
    expect(bars).toHaveLength(1);
    expect(bars[0]?.time).toBe(t4);
    expect(bars[0]?.open).toBeCloseTo(106 / 40, 12);
    expect(bars[0]?.close).toBeCloseTo(107 / 41, 12);
    expect(bars[0]).toEqual(await reload());
  });

  it('emits nothing for an older primary bar or a non-finite row', async () => {
    const { inner, bars } = await setup();
    inner.push('A', { time: T[1] as number, open: 1, high: 1, low: 1, close: 1 });
    expect(bars).toHaveLength(0);
    inner.push('B', { time: T[3] as number, open: 0, high: 0, low: 0, close: 0 });
    expect(bars).toHaveLength(0);
  });

  it('releases all legs on unsubscribe', async () => {
    const { inner, unsub } = await setup();
    expect(inner.subs.every((s) => s.listener !== null)).toBe(true);
    unsub();
    expect(inner.subs.every((s) => s.listener === null)).toBe(true);
  });

  it('resolves legs first when subscribing without history', async () => {
    const inner = hourlyFeed();
    const feed = new ExpressionFeed(inner);
    const bars: Bar[] = [];
    feed.subscribe({ symbol: 'A/B', interval: H1 }, null, (b) => bars.push(b));
    expect(inner.subs).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 0));
    expect(inner.subs.map((s) => s.req.timezone)).toEqual(['America/New_York', 'Europe/London']);
    expect(inner.subs.map((s) => s.lastBar)).toEqual([null, null]);
    inner.push('B', { time: T[0] as number, open: 4, high: 4, low: 4, close: 4 });
    expect(bars).toHaveLength(0);
    inner.push('A', { time: T[0] as number, open: 8, high: 8, low: 8, close: 8 });
    expect(bars).toEqual([{ time: T[0], open: 2, high: 2, low: 2, close: 2, volume: 0 }]);
  });
});

describe('SyntheticFeed perSymbol', () => {
  it('gives different series per symbol', async () => {
    const feed = new SyntheticFeed(500, undefined, 42, { perSymbol: true });
    const a = await feed.getBars({ symbol: 'AAPL', interval: D1, limit: 50 });
    const m = await feed.getBars({ symbol: 'MSFT', interval: D1, limit: 50 });
    expect([...a.bars.time]).toEqual([...m.bars.time]);
    expect([...a.bars.close]).not.toEqual([...m.bars.close]);
    const again = await feed.getBars({ symbol: 'aapl', interval: D1, limit: 50 });
    expect([...again.bars.close]).toEqual([...a.bars.close]);
  });

  it('keeps the default series byte-identical', async () => {
    const n = 300;
    const end = 1_790_000_000;
    const feed = new SyntheticFeed(n, end, 42);
    const a = await feed.getBars({ symbol: 'AAPL', interval: D1, limit: n });
    const m = await feed.getBars({ symbol: 'MSFT', interval: D1, limit: n });
    // Reference: the original generator.
    const rand = lcg(42);
    let price = 100;
    for (let i = 0; i < n; i++) {
      const open = price;
      const close = Math.max(1, open * (1 + (rand() - 0.5) * 0.04));
      const high = Math.max(open, close) * (1 + rand() * 0.01);
      const low = Math.min(open, close) * (1 - rand() * 0.01);
      const volume = Math.round(1e5 + rand() * 1e6);
      for (const r of [a, m]) {
        expect(r.bars.time[i]).toBe(end - (n - 1 - i) * DAY);
        expect(r.bars.open[i]).toBe(open);
        expect(r.bars.high[i]).toBe(high);
        expect(r.bars.low[i]).toBe(low);
        expect(r.bars.close[i]).toBe(close);
        expect(r.bars.volume[i]).toBe(volume);
      }
      price = close;
    }
  });
});
