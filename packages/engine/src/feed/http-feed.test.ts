import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bar } from '../types';
import { FeedError, HttpDataFeed, type LiveStatus } from './http-feed';
import { parseInterval } from './intervals';

const z = (iso: string): number => Date.parse(iso) / 1000;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  readonly sent: unknown[] = [];
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.({} as CloseEvent);
  }

  // -- test controls --
  open(): void {
    this.readyState = 1;
    this.onopen?.({} as Event);
  }

  receive(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) } as MessageEvent);
  }

  drop(): void {
    this.readyState = 3;
    this.onclose?.({} as CloseEvent);
  }

  static last(): FakeWebSocket {
    const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    if (ws === undefined) throw new Error('no socket');
    return ws;
  }
}

function makeFeed(fetchImpl?: typeof fetch): HttpDataFeed {
  return new HttpDataFeed({
    baseUrl: '',
    wsUrl: 'ws://test/ws',
    fetchImpl: fetchImpl ?? (vi.fn() as unknown as typeof fetch),
    WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
  });
}

function tick(symbol: string, iso: string, price: number, dayVolume: number | null = null) {
  return {
    type: 'tick',
    symbol,
    price,
    change: null,
    changePercent: null,
    dayVolume,
    dayHigh: null,
    dayLow: null,
    time: Date.parse(iso),
    marketHours: 1,
  };
}

const NY = { timezone: 'America/New_York', session: '0930-1600' } as const;

describe('HttpDataFeed HTTP', () => {
  it('maps getBars to /api/bars and converts columns', async () => {
    const fetchImpl = vi.fn<(url: string) => Promise<Response>>(async () =>
      jsonResponse({
        symbol: 'AAPL',
        interval: '60m',
        adjusted: false,
        prepost: false,
        t: [100, 200],
        o: [1, 2],
        h: [3, 4],
        l: [0.5, 1.5],
        c: [2, 3],
        v: [10, 20],
        hasMore: true,
      }),
    );
    const feed = makeFeed(fetchImpl as unknown as typeof fetch);
    const res = await feed.getBars({
      symbol: 'AAPL',
      interval: parseInterval('1h'),
      limit: 2,
      to: 300,
      prepost: true,
    });
    const url = new URL(fetchImpl.mock.calls[0]?.[0] ?? '', 'http://x');
    expect(url.pathname).toBe('/api/bars');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      symbol: 'AAPL',
      interval: '60m',
      limit: '2',
      to: '300',
      prepost: 'true',
    });
    expect(res.hasMore).toBe(true);
    expect(res.bars.time).toBeInstanceOf(Float64Array);
    expect([...res.bars.time]).toEqual([100, 200]);
    expect([...res.bars.high]).toEqual([3, 4]);
    expect([...res.bars.volume]).toEqual([10, 20]);
  });

  it('throws FeedError with status and detail on 404', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ detail: 'symbol not found: NOPE' }, 404));
    const feed = makeFeed(fetchImpl as unknown as typeof fetch);
    const p = feed.getBars({ symbol: 'NOPE', interval: parseInterval('1D'), limit: 10 });
    await expect(p).rejects.toBeInstanceOf(FeedError);
    await expect(p).rejects.toMatchObject({ status: 404, message: 'symbol not found: NOPE' });
  });

  it('joins FastAPI validation details', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ detail: [{ loc: ['query', 'limit'], msg: 'bad limit', type: 'x' }] }, 422),
    );
    const feed = makeFeed(fetchImpl as unknown as typeof fetch);
    await expect(
      feed.getBars({ symbol: 'A', interval: parseInterval('1D'), limit: 0 }),
    ).rejects.toMatchObject({ status: 422, message: 'bad limit' });
  });

  it('wraps network failures as FeedError status 0', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const feed = makeFeed(fetchImpl as unknown as typeof fetch);
    await expect(
      feed.getBars({ symbol: 'A', interval: parseInterval('1D'), limit: 1 }),
    ).rejects.toMatchObject({ status: 0, message: 'fetch failed' });
  });

  it('rejects non-native intervals', async () => {
    const feed = makeFeed();
    await expect(
      feed.getBars({ symbol: 'A', interval: parseInterval('4h'), limit: 1 }),
    ).rejects.toThrow(/ResamplingFeed/);
    expect(() =>
      feed.subscribe({ symbol: 'A', interval: parseInterval('3m') }, null, () => {}),
    ).toThrow();
  });

  it('caches resolveSymbol and maps search', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.startsWith('/api/symbols/search')) {
        return jsonResponse([
          { symbol: 'AAPL', name: 'Apple', exchange: 'NMS', type: 'EQUITY', typeDisplay: 'Equity' },
        ]);
      }
      return jsonResponse({
        symbol: 'AAPL',
        name: 'Apple Inc.',
        exchange: 'NMS',
        exchangeName: 'NasdaqGS',
        type: 'equity',
        currency: 'USD',
        timezone: 'America/New_York',
        session: '0930-1600',
        priceHint: 2,
        minTick: 0.01,
        hasIntraday: true,
      });
    });
    const feed = makeFeed(fetchImpl as unknown as typeof fetch);
    const [a, b] = await Promise.all([feed.resolveSymbol('aapl'), feed.resolveSymbol('AAPL')]);
    expect(a).toBe(b);
    expect(a.timezone).toBe('America/New_York');
    expect(a).not.toHaveProperty('hasIntraday');
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const results = await feed.searchSymbols('app', 5);
    expect(fetchImpl.mock.calls[1]?.[0]).toBe('/api/symbols/search?q=app&limit=5');
    expect(results).toEqual([
      { symbol: 'AAPL', name: 'Apple', exchange: 'NMS', type: 'EQUITY', typeDisplay: 'Equity' },
    ]);
  });

  it('does not cache failed symbol lookups', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      return calls === 1
        ? jsonResponse({ detail: 'upstream down' }, 502)
        : jsonResponse({ symbol: 'X', priceHint: 2 });
    });
    const feed = makeFeed(fetchImpl as unknown as typeof fetch);
    await expect(feed.resolveSymbol('X')).rejects.toMatchObject({ status: 502 });
    await expect(feed.resolveSymbol('X')).resolves.toMatchObject({ symbol: 'X' });
  });
});

describe('HttpDataFeed live', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('ref-counts symbols over one shared socket', () => {
    const feed = makeFeed();
    const i1 = parseInterval('1m');
    const u1 = feed.subscribe({ symbol: 'aapl', interval: i1, ...NY }, null, () => {});
    const u2 = feed.subscribe(
      { symbol: 'AAPL', interval: parseInterval('5m'), ...NY },
      null,
      () => {},
    );
    expect(FakeWebSocket.instances).toHaveLength(1);
    const ws = FakeWebSocket.last();
    ws.open();
    expect(ws.sent).toEqual([{ op: 'subscribe', symbols: ['AAPL'] }]);

    const u3 = feed.subscribe({ symbol: 'MSFT', interval: i1, ...NY }, null, () => {});
    expect(ws.sent.at(-1)).toEqual({ op: 'subscribe', symbols: ['MSFT'] });

    u1();
    expect(ws.sent).toHaveLength(2); // AAPL still referenced
    u2();
    u2(); // idempotent
    expect(ws.sent.at(-1)).toEqual({ op: 'unsubscribe', symbols: ['AAPL'] });
    expect(ws.sent).toHaveLength(3);
    u3();
    expect(ws.sent.at(-1)).toEqual({ op: 'unsubscribe', symbols: ['MSFT'] });
    expect(FakeWebSocket.instances).toHaveLength(1);

    // Idle socket closes after a while.
    vi.advanceTimersByTime(10_000);
    expect(ws.readyState).toBe(3);
    feed.dispose();
  });

  it('pings every 25s', () => {
    const feed = makeFeed();
    feed.subscribe({ symbol: 'AAPL', interval: parseInterval('1m'), ...NY }, null, () => {});
    const ws = FakeWebSocket.last();
    ws.open();
    vi.advanceTimersByTime(25_000);
    expect(ws.sent.at(-1)).toEqual({ op: 'ping' });
    vi.advanceTimersByTime(25_000);
    expect(ws.sent.filter((m) => (m as { op: string }).op === 'ping')).toHaveLength(2);
    feed.dispose();
  });

  it('reconnects with backoff and re-subscribes', () => {
    const feed = makeFeed();
    const statuses: LiveStatus[] = [];
    feed.onStatus((s) => statuses.push(s));
    feed.subscribe({ symbol: 'AAPL', interval: parseInterval('1m'), ...NY }, null, () => {});
    feed.subscribe({ symbol: 'MSFT', interval: parseInterval('1m'), ...NY }, null, () => {});
    const ws1 = FakeWebSocket.last();
    ws1.open();
    ws1.receive({ type: 'status', upstream: 'polling' });
    expect(feed.getStatus()).toMatchObject({ connection: 'open', upstream: 'polling' });

    ws1.drop();
    expect(feed.getStatus().connection).toBe('reconnecting');
    vi.advanceTimersByTime(499);
    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(2);

    // Fails again before opening: next delay doubles to 1000ms.
    FakeWebSocket.last().drop();
    vi.advanceTimersByTime(999);
    expect(FakeWebSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(3);

    const ws3 = FakeWebSocket.last();
    ws3.open();
    expect(ws3.sent).toEqual([{ op: 'subscribe', symbols: ['AAPL', 'MSFT'] }]);
    expect(statuses.map((s) => s.connection)).toContain('reconnecting');
    expect(feed.getStatus().connection).toBe('open');

    // Backoff resets after a successful open.
    ws3.drop();
    vi.advanceTimersByTime(500);
    expect(FakeWebSocket.instances).toHaveLength(4);
    feed.dispose();
  });

  it('caps backoff at 30s', () => {
    const feed = makeFeed();
    feed.subscribe({ symbol: 'AAPL', interval: parseInterval('1m'), ...NY }, null, () => {});
    for (let i = 0; i < 10; i++) {
      FakeWebSocket.last().drop();
      vi.advanceTimersByTime(30_000);
    }
    const n = FakeWebSocket.instances.length;
    FakeWebSocket.last().drop();
    vi.advanceTimersByTime(29_999);
    expect(FakeWebSocket.instances).toHaveLength(n);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(n + 1);
    feed.dispose();
  });

  it('updates the current bar within its bucket and opens a new one in the next', () => {
    const feed = makeFeed();
    const bars: Bar[] = [];
    const last: Bar = {
      time: z('2024-01-02T14:30:00Z'),
      open: 10,
      high: 11,
      low: 9,
      close: 10.5,
      volume: 100,
    };
    feed.subscribe({ symbol: 'AAPL', interval: parseInterval('5m'), ...NY }, last, (b) =>
      bars.push(b),
    );
    const ws = FakeWebSocket.last();
    ws.open();

    ws.receive(tick('AAPL', '2024-01-02T14:32:00Z', 11.5));
    ws.receive(tick('AAPL', '2024-01-02T14:33:00Z', 8.5));
    ws.receive(tick('AAPL', '2024-01-02T14:29:59Z', 50)); // older than current bar: ignored
    expect(bars).toEqual([
      { time: last.time, open: 10, high: 11.5, low: 9, close: 11.5, volume: 100 },
      { time: last.time, open: 10, high: 11.5, low: 8.5, close: 8.5, volume: 100 },
    ]);
    expect(last.high).toBe(11); // caller's bar is not mutated

    ws.receive(tick('AAPL', '2024-01-02T14:41:10Z', 9));
    expect(bars.at(-1)).toEqual({
      time: z('2024-01-02T14:40:00Z'),
      open: 9,
      high: 9,
      low: 9,
      close: 9,
      volume: 0,
    });
    // Emitted bars are copies.
    (bars.at(-1) as Bar).close = 0;
    ws.receive(tick('AAPL', '2024-01-02T14:42:00Z', 9.5));
    expect(bars.at(-1)?.close).toBe(9.5);
    expect(bars.at(-1)?.open).toBe(9);
    feed.dispose();
  });

  it('rolls daily bars over in the exchange timezone', () => {
    const feed = makeFeed();
    const bars: Bar[] = [];
    const mar7 = z('2024-03-07T05:00:00Z'); // NY midnight
    const last: Bar = { time: mar7, open: 10, high: 10, low: 10, close: 10, volume: 0 };
    feed.subscribe(
      {
        symbol: 'AAPL',
        interval: parseInterval('1D'),
        timezone: 'America/New_York',
        session: null,
      },
      last,
      (b) => bars.push(b),
    );
    const ws = FakeWebSocket.last();
    ws.open();
    // 22:00 NY on Mar 7 is already Mar 8 in UTC, but still the Mar 7 bar.
    ws.receive(tick('AAPL', '2024-03-08T03:00:00Z', 11));
    expect(bars.at(-1)).toMatchObject({ time: mar7, close: 11, high: 11 });
    ws.receive(tick('AAPL', '2024-03-08T14:31:00Z', 12));
    expect(bars.at(-1)).toMatchObject({ time: z('2024-03-08T05:00:00Z'), open: 12, close: 12 });
    feed.dispose();
  });

  it('ignores after-hours ticks for daily bars when the session is known', () => {
    const feed = makeFeed();
    const bars: Bar[] = [];
    const mar7 = z('2024-03-07T05:00:00Z');
    feed.subscribe(
      { symbol: 'AAPL', interval: parseInterval('1D'), ...NY },
      { time: mar7, open: 10, high: 10, low: 10, close: 10, volume: 0 },
      (b) => bars.push(b),
    );
    const ws = FakeWebSocket.last();
    ws.open();
    ws.receive(tick('AAPL', '2024-03-07T22:30:00Z', 13)); // 17:30 NY post-market
    expect(bars).toHaveLength(0);
    ws.receive(tick('AAPL', '2024-03-07T20:59:00Z', 11)); // 15:59 NY
    expect(bars.at(-1)).toMatchObject({ time: mar7, close: 11 });
    feed.dispose();
  });

  it('adds positive dayVolume deltas only', () => {
    const feed = makeFeed();
    const bars: Bar[] = [];
    const t0 = z('2024-01-02T15:00:00Z');
    feed.subscribe(
      { symbol: 'AAPL', interval: parseInterval('5m'), ...NY },
      { time: t0, open: 1, high: 1, low: 1, close: 1, volume: 50 },
      (b) => bars.push(b),
    );
    const ws = FakeWebSocket.last();
    ws.open();
    ws.receive(tick('AAPL', '2024-01-02T15:00:10Z', 1, 1000)); // baseline, no delta
    ws.receive(tick('AAPL', '2024-01-02T15:00:20Z', 1, 1500)); // +500
    ws.receive(tick('AAPL', '2024-01-02T15:00:30Z', 1, 1400)); // decrease ignored
    ws.receive(tick('AAPL', '2024-01-02T15:00:40Z', 1, 1600)); // +200
    ws.receive(tick('AAPL', '2024-01-02T15:00:50Z', 1, null)); // no volume info
    expect(bars.map((b) => b.volume)).toEqual([50, 550, 550, 750, 750]);
    ws.receive(tick('AAPL', '2024-01-02T15:05:00Z', 2, 1700)); // new bar starts with delta
    expect(bars.at(-1)).toMatchObject({ time: z('2024-01-02T15:05:00Z'), volume: 100 });
    feed.dispose();
  });

  it('fans one tick out to every subscription of the symbol', () => {
    const feed = makeFeed();
    const a: Bar[] = [];
    const b: Bar[] = [];
    feed.subscribe({ symbol: 'AAPL', interval: parseInterval('1m'), ...NY }, null, (x) =>
      a.push(x),
    );
    feed.subscribe({ symbol: 'AAPL', interval: parseInterval('1h'), ...NY }, null, (x) =>
      b.push(x),
    );
    const ws = FakeWebSocket.last();
    ws.open();
    ws.receive(tick('AAPL', '2024-01-02T15:47:30Z', 5));
    expect(a[0]?.time).toBe(z('2024-01-02T15:47:00Z'));
    expect(b[0]?.time).toBe(z('2024-01-02T15:30:00Z')); // 10:30 NY, session-anchored
    feed.dispose();
  });

  it('reports server errors via onStatus', () => {
    const feed = makeFeed();
    feed.subscribe({ symbol: 'AAPL', interval: parseInterval('1m'), ...NY }, null, () => {});
    const ws = FakeWebSocket.last();
    ws.open();
    ws.receive({ type: 'error', message: 'invalid symbol(s)' });
    expect(feed.getStatus().lastError).toBe('invalid symbol(s)');
    feed.dispose();
  });
});
