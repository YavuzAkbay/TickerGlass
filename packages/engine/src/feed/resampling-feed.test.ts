import { describe, expect, it, vi } from 'vitest';
import type {
  Bar,
  BarColumns,
  BarListener,
  DataFeed,
  GetBarsRequest,
  GetBarsResult,
  SymbolInfo,
} from '../types';
import { formatInterval, parseInterval } from './intervals';
import { resample } from './resample';
import { ResamplingFeed } from './resampling-feed';

const MIN = 60;
const HOUR = 3600;
const DAY = 86_400;
const z = (iso: string): number => Date.parse(iso) / 1000;

function cols(times: number[]): BarColumns {
  const n = times.length;
  const c: BarColumns = {
    time: Float64Array.from(times),
    open: new Float64Array(n),
    high: new Float64Array(n),
    low: new Float64Array(n),
    close: new Float64Array(n),
    volume: new Float64Array(n),
  };
  for (let i = 0; i < n; i++) {
    const p = 100 + Math.sin(i / 7) * 5;
    c.open[i] = p;
    c.high[i] = p + 1 + (i % 3);
    c.low[i] = p - 1 - (i % 5);
    c.close[i] = p + 0.5;
    c.volume[i] = 1 + (i % 11);
  }
  return c;
}

function slice(c: BarColumns, a: number, b: number): BarColumns {
  return {
    time: c.time.slice(a, b),
    open: c.open.slice(a, b),
    high: c.high.slice(a, b),
    low: c.low.slice(a, b),
    close: c.close.slice(a, b),
    volume: c.volume.slice(a, b),
  };
}

function info(timezone: string | null, session: string | null): SymbolInfo {
  return {
    symbol: 'TEST',
    name: 'Test',
    exchange: null,
    exchangeName: null,
    type: null,
    currency: null,
    timezone,
    session,
    priceHint: 2,
    minTick: 0.01,
  };
}

/** In-memory feed with API paging semantics: newest `limit` bars with t < to. */
class FakeFeed implements DataFeed {
  readonly requests: GetBarsRequest[] = [];
  listener: BarListener | null = null;
  subscribedInterval: string | null = null;
  subscribedLastBar: Bar | null | undefined = undefined;

  constructor(
    private readonly data: Record<string, BarColumns>,
    private readonly sym: SymbolInfo,
  ) {}

  resolveSymbol = vi.fn(async () => this.sym);
  searchSymbols = vi.fn(async () => []);

  async getBars(req: GetBarsRequest): Promise<GetBarsResult> {
    this.requests.push(req);
    const c = this.data[formatInterval(req.interval)];
    if (c === undefined) throw new Error(`no data for ${formatInterval(req.interval)}`);
    let end = c.time.length;
    if (req.to !== undefined) {
      end = 0;
      while (end < c.time.length && (c.time[end] as number) < req.to) end++;
    }
    const start = Math.max(0, end - req.limit);
    return { bars: slice(c, start, end), hasMore: start > 0 };
  }

  subscribe(
    req: { interval: { unit: string; count: number } },
    lastBar: Bar | null,
    onBar: BarListener,
  ) {
    this.subscribedInterval = formatInterval(req.interval as never);
    this.subscribedLastBar = lastBar;
    this.listener = onBar;
    return () => {
      this.listener = null;
    };
  }
}

/** Weekday regular-session bars every `step` seconds. */
function equityTimes(firstOpenUtc: number, days: number, step: number): number[] {
  const out: number[] = [];
  for (let d = 0; d < days; d++) {
    const open = firstOpenUtc + d * DAY;
    const dow = new Date(open * 1000).getUTCDay();
    if (dow === 0 || dow === 6) continue;
    for (let t = open; t < open + 390 * MIN; t += step) out.push(t);
  }
  return out;
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

function concatTimes(pages: BarColumns[]): number[] {
  return pages.flatMap((p) => [...p.time]);
}

describe('ResamplingFeed getBars', () => {
  it('passes native intervals straight through', async () => {
    const inner = new FakeFeed({ '5m': cols([0, 300]) }, info('UTC', null));
    const feed = new ResamplingFeed(inner);
    const res = await feed.getBars({ symbol: 'TEST', interval: parseInterval('5m'), limit: 10 });
    expect(res.bars.time.length).toBe(2);
    expect(inner.resolveSymbol).not.toHaveBeenCalled();
  });

  it('requests limit*factor base bars and returns at most limit buckets', async () => {
    // January 2024, NY winter time: 09:30 = 14:30Z.
    const base = cols(equityTimes(z('2024-01-02T14:30:00Z'), 10, HOUR));
    const inner = new FakeFeed({ '1h': base }, info('America/New_York', '0930-1600'));
    const feed = new ResamplingFeed(inner);
    const res = await feed.getBars({ symbol: 'TEST', interval: parseInterval('4h'), limit: 5 });
    expect(res.bars.time.length).toBe(5);
    expect(res.hasMore).toBe(true);
    expect(inner.requests[0]?.limit).toBeGreaterThanOrEqual(20);
    expect(formatInterval(inner.requests[0]?.interval ?? parseInterval('1m'))).toBe('1h');
  });

  it.each([
    ['3m', '1m', 'America/New_York', '0930-1600', MIN, 37],
    ['45m', '15m', 'America/New_York', '0930-1600', 15 * MIN, 11],
    ['4h', '1h', 'America/New_York', '0930-1600', HOUR, 7],
    ['4h', '1h', 'America/New_York', null, HOUR, 3],
  ] as const)(
    '%s from %s pages backwards contiguously (tz %s, session %s)',
    async (target, baseName, tz, session, step, limit) => {
      const all = cols(equityTimes(z('2024-03-04T14:30:00Z'), 12, step));
      const inner = new FakeFeed({ [baseName]: all }, info(tz, session));
      const feed = new ResamplingFeed(inner);
      const pages = await pageAll(feed, { symbol: 'TEST', interval: parseInterval(target), limit });
      expect(pages.length).toBeGreaterThan(2);
      for (const p of pages.slice(1)) expect(p.time.length).toBeLessThanOrEqual(limit);

      const times = concatTimes(pages);
      for (let i = 1; i < times.length; i++)
        expect(times[i]).toBeGreaterThan(times[i - 1] as number);

      // Stitched pages equal one resample over the whole history.
      const full = resample(all, parseInterval(target), { timezone: tz, session });
      expect(times).toEqual([...full.time]);
      const vol = pages.flatMap((p) => [...p.volume]);
      expect(vol).toEqual([...full.volume]);
      const opens = pages.flatMap((p) => [...p.open]);
      expect(opens).toEqual([...full.open]);
    },
  );

  it('pages 24h data with data-anchored days (session null)', async () => {
    // Crypto-like hourly data starting mid-day.
    const start = z('2024-01-01T07:00:00Z');
    const all = cols(Array.from({ length: 24 * 15 }, (_, i) => start + i * HOUR));
    const inner = new FakeFeed({ '1h': all }, info('UTC', null));
    const feed = new ResamplingFeed(inner);
    const pages = await pageAll(feed, { symbol: 'TEST', interval: parseInterval('4h'), limit: 4 });
    const full = resample(all, parseInterval('4h'), { timezone: 'UTC', session: null });
    expect(concatTimes(pages)).toEqual([...full.time]);
    // Everything after the first (partial) day sits on the midnight grid.
    expect(
      concatTimes(pages)
        .filter((t) => t >= z('2024-01-02T00:00:00Z'))
        .every((t) => t % (4 * HOUR) === 0),
    ).toBe(true);
  });

  it('pages 2D and 6M', async () => {
    const days: number[] = [];
    for (let t = z('2022-01-03T05:00:00Z'); t < z('2023-01-01T05:00:00Z'); t += DAY) {
      const dow = new Date(t * 1000).getUTCDay();
      if (dow !== 0 && dow !== 6) days.push(t);
    }
    const daily = cols(days);
    const inner = new FakeFeed({ '1D': daily }, info('UTC', null));
    const feed = new ResamplingFeed(inner);
    const pages = await pageAll(feed, { symbol: 'TEST', interval: parseInterval('2D'), limit: 20 });
    const full = resample(daily, parseInterval('2D'), { timezone: 'UTC', session: null });
    expect(concatTimes(pages)).toEqual([...full.time]);

    const months = Array.from({ length: 36 }, (_, i) => Date.UTC(2020, i, 1) / 1000);
    const inner2 = new FakeFeed({ '1M': cols(months) }, info('UTC', null));
    const pages2 = await pageAll(new ResamplingFeed(inner2), {
      symbol: 'TEST',
      interval: parseInterval('6M'),
      limit: 2,
    });
    const t = concatTimes(pages2);
    expect(t).toHaveLength(6);
    expect(t.every((x) => [0, 6].includes(new Date(x * 1000).getUTCMonth()))).toBe(true);
  });

  it('returns hasMore=false and keeps the oldest bucket at the start of history', async () => {
    const all = cols(equityTimes(z('2024-01-02T14:30:00Z'), 1, MIN).slice(0, 10));
    const inner = new FakeFeed({ '1m': all }, info('America/New_York', '0930-1600'));
    const res = await new ResamplingFeed(inner).getBars({
      symbol: 'TEST',
      interval: parseInterval('3m'),
      limit: 100,
    });
    expect(res.hasMore).toBe(false);
    expect(res.bars.time.length).toBe(4);
  });
});

describe('ResamplingFeed subscribe', () => {
  it('folds live 1m bars into the current 3m bar', async () => {
    const inner = new FakeFeed({}, info('America/New_York', '0930-1600'));
    const feed = new ResamplingFeed(inner);
    const out: Bar[] = [];
    const t0 = z('2024-01-02T14:30:00Z');
    const last: Bar = { time: t0, open: 10, high: 11, low: 9, close: 10.5, volume: 100 };
    const unsub = feed.subscribe(
      {
        symbol: 'TEST',
        interval: parseInterval('3m'),
        timezone: 'America/New_York',
        session: '0930-1600',
      },
      last,
      (b) => out.push(b),
    );
    expect(inner.subscribedInterval).toBe('1m');
    expect(inner.subscribedLastBar).toBeNull();
    const emit = (b: Bar) => inner.listener?.(b);

    emit({ time: t0 + MIN, open: 10.5, high: 12, low: 10.4, close: 11.8, volume: 5 });
    expect(out.at(-1)).toEqual({ time: t0, open: 10, high: 12, low: 9, close: 11.8, volume: 105 });

    // Same base bar updates: recomputed, not double-counted.
    emit({ time: t0 + MIN, open: 10.5, high: 12.5, low: 10.4, close: 12.2, volume: 8 });
    expect(out.at(-1)).toEqual({
      time: t0,
      open: 10,
      high: 12.5,
      low: 9,
      close: 12.2,
      volume: 108,
    });

    emit({ time: t0 + 2 * MIN, open: 12.2, high: 12.3, low: 8, close: 8.5, volume: 2 });
    expect(out.at(-1)).toEqual({ time: t0, open: 10, high: 12.5, low: 8, close: 8.5, volume: 110 });

    // Next 3m bucket starts from base bars only.
    emit({ time: t0 + 3 * MIN, open: 8.6, high: 9, low: 8.4, close: 8.8, volume: 3 });
    expect(out.at(-1)).toEqual({
      time: t0 + 3 * MIN,
      open: 8.6,
      high: 9,
      low: 8.4,
      close: 8.8,
      volume: 3,
    });

    // Late base bar from an older bucket is ignored.
    const n = out.length;
    emit({ time: t0 + 2 * MIN, open: 1, high: 1, low: 1, close: 1, volume: 1 });
    expect(out).toHaveLength(n);

    unsub();
    expect(inner.listener).toBeNull();
  });

  it('resolves the timezone itself when not given', async () => {
    const inner = new FakeFeed({}, info('America/New_York', '0930-1600'));
    const feed = new ResamplingFeed(inner);
    const out: Bar[] = [];
    feed.subscribe({ symbol: 'TEST', interval: parseInterval('2D') }, null, (b) => out.push(b));
    await Promise.resolve();
    await Promise.resolve();
    // 2024-01-03 22:00 NY == 2024-01-04 03:00Z; local day 19725 -> group starts 19724 (Jan 2).
    inner.listener?.({
      time: z('2024-01-04T03:00:00Z'),
      open: 1,
      high: 1,
      low: 1,
      close: 1,
      volume: 1,
    });
    expect(out.at(-1)?.time).toBe(z('2024-01-02T05:00:00Z'));
  });
});
