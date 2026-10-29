import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import type { Quote } from '../api/types';
import { emptyQuote, mergeExtended, mergeSnapshot, mergeTick } from './merge';
import {
  BACKOFF_MS,
  MAX_RETAINED,
  MAX_WS_SYMBOLS,
  META_REFRESH_MS,
  QuoteStream,
  RETAIN_MS,
  SNAP_FRESH_MS,
  STABLE_MS,
  type SocketLike,
} from './stream';
import { useQuoteStore } from './store';
import type { ExtendedQuote, LiveQuote, TickFrame } from './types';

const tick = (o: Partial<TickFrame> = {}): TickFrame => ({
  type: 'tick',
  symbol: 'AAPL',
  price: 100,
  change: null,
  changePercent: null,
  dayVolume: null,
  dayHigh: null,
  dayLow: null,
  time: 1_000_000,
  marketHours: 1,
  ...o,
});
const snap = (o: Partial<Quote> = {}): Quote => ({
  symbol: 'AAPL',
  last: 90,
  prevClose: 88,
  change: 2,
  changePercent: 2.27,
  volume: 5,
  currency: 'USD',
  marketState: 'REGULAR',
  ...o,
});
const ext = (o: Partial<ExtendedQuote> = {}): ExtendedQuote => ({
  symbol: 'AAPL',
  marketState: 'PRE',
  regularMarketPrice: 100,
  regularMarketTime: 1000,
  preMarketPrice: 101,
  preMarketTime: 2000,
  preMarketChange: 1,
  preMarketChangePercent: 1,
  postMarketPrice: null,
  postMarketTime: null,
  postMarketChange: null,
  postMarketChangePercent: null,
  ...o,
});

describe('mergeTick', () => {
  it('regular tick sets last, derives change from prevClose, flashes on change', () => {
    const a = mergeSnapshot(undefined, snap(), 0);
    const b = mergeTick(a, tick({ price: 91 }));
    expect(b).toMatchObject({ last: 91, change: 3, lastTickMs: 1_000_000 });
    expect(b.changePercent).toBeCloseTo((3 / 88) * 100);
    expect(b.flash).toEqual({ dir: 1, seq: 1, target: 'last' }); // 90 -> 91
  });

  it('flash dir and seq follow price changes only', () => {
    let q: LiveQuote | undefined = mergeTick(undefined, tick({ price: 100 }));
    expect(q.flash).toBeNull(); // first price: nothing to compare
    q = mergeTick(q, tick({ price: 101 }));
    expect(q.flash).toEqual({ dir: 1, seq: 1, target: 'last' });
    q = mergeTick(q, tick({ price: 101 }));
    expect(q.flash).toEqual({ dir: 1, seq: 1, target: 'last' });
    q = mergeTick(q, tick({ price: 100.5 }));
    expect(q.flash).toEqual({ dir: -1, seq: 2, target: 'last' });
  });

  it('uses tick change values when present and keeps volume/high/low otherwise', () => {
    const a = mergeTick(
      undefined,
      tick({ change: 1, changePercent: 1.5, dayVolume: 10, dayHigh: 5 }),
    );
    const b = mergeTick(a, tick({ price: 101, change: 2, changePercent: 2, dayVolume: null }));
    expect(b).toMatchObject({ change: 2, volume: 10, dayHigh: 5 });
  });

  it('pre/post ticks set ext and leave last untouched', () => {
    const a = mergeTick(undefined, tick({ price: 100 }));
    const b = mergeTick(a, tick({ price: 102, marketHours: 0, time: 5 }));
    expect(b.last).toBe(100);
    expect(b.lastTickMs).toBe(1_000_000);
    expect(b.ext).toEqual({
      session: 'pre',
      price: 102,
      change: 2,
      changePercent: 2,
      timeMs: 5,
      source: 'tick',
    });
    const c = mergeTick(b, tick({ price: 103, marketHours: 3 }));
    expect(c.ext?.session).toBe('post');
    expect(c.flash).toEqual({ dir: 1, seq: 1, target: 'ext' });
    expect(mergeTick(c, tick({ price: 104, marketHours: 1 })).ext).toBeNull();
  });

  it('a regular tick that clears ext flashes Last, not Ext', () => {
    let q = mergeTick(undefined, tick({ price: 100 }));
    q = mergeTick(q, tick({ price: 102, marketHours: 2 }));
    q = mergeTick(q, tick({ price: 101, marketHours: 1 }));
    expect(q.ext).toBeNull();
    expect(q.flash).toMatchObject({ dir: 1, target: 'last' });
  });
});

describe('mergeSnapshot', () => {
  it('does not override a fresh tick but takes prevClose/currency', () => {
    const a = mergeTick(undefined, tick({ price: 120, time: 1000 }));
    const b = mergeSnapshot(a, snap({ last: 90 }), 1000 + 59_999);
    expect(b).toMatchObject({ last: 120, prevClose: 88, currency: 'USD', marketState: 'REGULAR' });
    const c = mergeSnapshot(a, snap({ last: 90 }), 1000 + 60_000);
    expect(c.last).toBe(90);
    expect(c.flash).toEqual(a.flash);
  });
});

describe('mergeExtended', () => {
  const base = { ...emptyQuote('AAPL'), last: 100 };
  it('pre session', () => {
    expect(mergeExtended(base, ext(), 0).ext).toEqual({
      session: 'pre',
      price: 101,
      change: 1,
      changePercent: 1,
      timeMs: 2_000_000,
      source: 'snapshot',
    });
  });
  it('post session only when newer than the regular time', () => {
    const post = ext({
      marketState: 'POST',
      postMarketPrice: 99,
      postMarketTime: 3000,
      postMarketChange: -1,
      postMarketChangePercent: -1,
    });
    expect(mergeExtended(base, post, 0).ext?.session).toBe('post');
    expect(mergeExtended(base, { ...post, postMarketTime: 900 }, 0).ext).toBeNull();
  });
  it('REGULAR clears; a fresh ext tick is kept', () => {
    const withExt = mergeTick(base, tick({ price: 105, marketHours: 0, time: 1_000 }));
    expect(mergeExtended(withExt, ext({ marketState: 'REGULAR' }), 0).ext).toBeNull();
    expect(mergeExtended(withExt, ext(), 1_000 + 119_000).ext?.price).toBe(105);
    expect(mergeExtended(withExt, ext(), 1_000 + 121_000).ext?.price).toBe(101);
    expect(mergeExtended(undefined, ext(), 0).marketState).toBe('PRE');
  });
  it('a snapshot-sourced ext is replaced by a newer snapshot', () => {
    const a = mergeExtended(base, ext(), 5_000);
    expect(a.ext?.source).toBe('snapshot');
    const b = mergeExtended(a, ext({ preMarketPrice: 102, preMarketTime: 2001 }), 5_001);
    expect(b.ext?.price).toBe(102);
  });
});

// ------------------------------------------------------------ stream

class FakeSocket implements SocketLike {
  static all: FakeSocket[] = [];
  sent: { op: string; symbols?: string[] }[] = [];
  closed = false;
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;
  constructor(public url: string) {
    FakeSocket.all.push(this);
  }
  send(d: string) {
    this.sent.push(JSON.parse(d));
  }
  close() {
    this.closed = true;
  }
  open() {
    this.onopen?.();
  }
  drop() {
    this.onclose?.();
  }
  push(frame: object) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  subs(op = 'subscribe') {
    return this.sent.filter((m) => m.op === op).flatMap((m) => m.symbols ?? []);
  }
}

describe('QuoteStream', () => {
  let visible = true;
  let fetches: string[] = [];
  let stream: QuoteStream;
  const mk = () =>
    new QuoteStream({
      url: 'ws://test/ws',
      createSocket: (u) => new FakeSocket(u),
      fetchJson: async <T>(path: string) => {
        fetches.push(path);
        return [] as unknown as T;
      },
      isVisible: () => visible,
      random: () => 0.5, // no jitter
      now: () => Date.now(),
    });
  const last = () => FakeSocket.all[FakeSocket.all.length - 1]!;

  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.all = [];
    fetches = [];
    visible = true;
    useQuoteStore.setState({ quotes: {}, missing: {}, status: 'idle', error: null });
    stream = mk();
  });
  afterEach(() => {
    stream.dispose();
    vi.useRealTimers();
  });

  it('opens lazily, reference counts, and releases after the grace period', async () => {
    expect(FakeSocket.all).toHaveLength(0);
    const r1 = stream.subscribe(['aapl']);
    const r2 = stream.subscribe(['AAPL', 'msft']);
    expect(FakeSocket.all).toHaveLength(1);
    last().open();
    expect(last().subs().sort()).toEqual(['AAPL', 'MSFT']);
    r1();
    r1(); // idempotent
    await vi.advanceTimersByTimeAsync(2500);
    expect(last().subs('unsubscribe')).toEqual([]); // r2 still holds AAPL
    r2();
    await vi.advanceTimersByTimeAsync(1999);
    expect(last().subs('unsubscribe')).toEqual([]);
    await vi.advanceTimersByTimeAsync(2);
    expect(last().subs('unsubscribe').sort()).toEqual(['AAPL', 'MSFT']);
    // Socket closes 10 s after the last release.
    await vi.advanceTimersByTimeAsync(9_900);
    expect(last().closed).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(last().closed).toBe(true);
    expect(useQuoteStore.getState().status).toBe('idle');
  });

  it('re-subscribing within the grace period keeps the subscription', async () => {
    const r = stream.subscribe(['AAPL']);
    last().open();
    r();
    stream.subscribe(['AAPL']);
    await vi.advanceTimersByTimeAsync(3000);
    expect(last().subs('unsubscribe')).toEqual([]);
    expect(last().subs()).toEqual(['AAPL']);
  });

  it('applies tick and status frames', () => {
    stream.subscribe(['AAPL']);
    last().open();
    last().push({ type: 'status', upstream: 'polling' });
    expect(useQuoteStore.getState().status).toBe('upstream-polling');
    last().push({ type: 'status', upstream: 'reconnecting' });
    expect(useQuoteStore.getState().status).toBe('upstream-polling');
    last().push({ type: 'status', upstream: 'connected' });
    expect(useQuoteStore.getState().status).toBe('live');
    last().push(tick({ symbol: 'aapl', price: 7 }));
    expect(useQuoteStore.getState().quotes.AAPL?.last).toBe(7);
  });

  it('reconnects with backoff, re-subscribes, and resets the backoff on open', async () => {
    stream.subscribe(['AAPL', 'MSFT']);
    last().open();
    for (let i = 0; i < BACKOFF_MS.length + 1; i++) {
      last().drop();
      expect(useQuoteStore.getState().status).toBe('fallback-polling');
      const wait = BACKOFF_MS[Math.min(i, BACKOFF_MS.length - 1)]!;
      const before = FakeSocket.all.length;
      await vi.advanceTimersByTimeAsync(wait - 1);
      expect(FakeSocket.all).toHaveLength(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(FakeSocket.all).toHaveLength(before + 1);
    }
    last().open();
    expect(last().subs().sort()).toEqual(['AAPL', 'MSFT']);
    last().push(tick({ symbol: 'AAPL', price: 1 })); // a tick resets the backoff
    last().drop();
    const n = FakeSocket.all.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeSocket.all).toHaveLength(n + 1); // back to 1 s
  });

  it('status and error frames do not reset the backoff; a tick or a stable socket does', async () => {
    stream.subscribe(['AAPL']);
    last().open();
    last().drop(); // attempt 0 -> 1 s
    await vi.advanceTimersByTimeAsync(1000);
    last().open();
    last().push({ type: 'status', upstream: 'connected' }); // server greets on connect
    last().push({ type: 'error', message: 'x' });
    last().drop();
    let n = FakeSocket.all.length;
    await vi.advanceTimersByTimeAsync(1999);
    expect(FakeSocket.all).toHaveLength(n); // still backing off (2 s)
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeSocket.all).toHaveLength(n + 1);
    // Staying open for STABLE_MS resets it.
    last().open();
    await vi.advanceTimersByTimeAsync(STABLE_MS);
    last().drop();
    n = FakeSocket.all.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeSocket.all).toHaveLength(n + 1);
  });

  it('keeps backing off when the socket opens but closes before any frame', async () => {
    stream.subscribe(['AAPL']);
    last().open();
    last().drop();
    await vi.advanceTimersByTimeAsync(1000);
    last().open();
    last().drop();
    const n = FakeSocket.all.length;
    await vi.advanceTimersByTimeAsync(1999);
    expect(FakeSocket.all).toHaveLength(n);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeSocket.all).toHaveLength(n + 1);
  });

  it('closes the socket on error', () => {
    stream.subscribe(['AAPL']);
    const ws = last();
    ws.open();
    ws.onerror?.();
    expect(ws.closed).toBe(true);
  });

  it('keeps recent quotes after idle and evicts them after the retention period', async () => {
    const r = stream.subscribe(['AAPL']);
    last().open();
    last().push(tick({ symbol: 'AAPL', price: 7 }));
    expect(useQuoteStore.getState().quotes.AAPL).toBeDefined();
    r();
    await vi.advanceTimersByTimeAsync(2000 + 10_000 + 10);
    expect(useQuoteStore.getState().status).toBe('idle');
    expect(useQuoteStore.getState().quotes.AAPL?.last).toBe(7); // kept across idle
    await vi.advanceTimersByTimeAsync(RETAIN_MS);
    expect(useQuoteStore.getState().quotes.AAPL).toBeDefined(); // nothing running to prune
    stream.subscribe(['MSFT']); // the next subscription enforces retention
    expect(useQuoteStore.getState().quotes.AAPL).toBeUndefined();
  });

  it('marks symbols the snapshot omitted as missing', async () => {
    const s = new QuoteStream({
      createSocket: (u) => new FakeSocket(u),
      fetchJson: async <T>() => [snap({ symbol: 'AAPL' })] as unknown as T,
      isVisible: () => true,
    });
    s.subscribe(['AAPL', 'ZZZZ']);
    await vi.advanceTimersByTimeAsync(100);
    expect(useQuoteStore.getState().missing).toEqual({ ZZZZ: true });
    s.dispose();
  });

  it('polls /quotes only while the socket is down and the page is visible', async () => {
    stream.subscribe(['AAPL']);
    await vi.advanceTimersByTimeAsync(60); // initial batch
    expect(fetches).toEqual(['/quotes?symbols=AAPL']);
    last().open();
    fetches = [];
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fetches).toEqual([]); // socket open: no 15 s poll
    last().drop();
    await vi.advanceTimersByTimeAsync(15_000 - 1);
    fetches = [];
    visible = false;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetches).toEqual([]); // hidden
    visible = true;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fetches.filter((f) => f.startsWith('/quotes?')).length).toBeGreaterThan(0);
  });

  it('refreshes snapshots every 60 s while visible', async () => {
    stream.subscribe(['AAPL']);
    last().open();
    await vi.advanceTimersByTimeAsync(60);
    fetches = [];
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetches).toEqual(['/quotes?symbols=AAPL']);
  });

  it('polls extended quotes only for ext subscribers', async () => {
    stream.subscribe(['AAPL']);
    stream.subscribe(['MSFT'], { ext: true });
    await vi.advanceTimersByTimeAsync(60);
    expect(fetches).toContain('/quotes/extended?symbols=MSFT');
    expect(fetches.filter((f) => f.startsWith('/quotes/extended'))).toHaveLength(1);
  });

  it('skips /quotes/extended when the provider has no extended quotes', async () => {
    stream.dispose();
    stream = new QuoteStream({
      url: 'ws://test/ws',
      createSocket: (u) => new FakeSocket(u),
      fetchJson: async <T>(path: string) => {
        fetches.push(path);
        return [] as unknown as T;
      },
      isVisible: () => visible,
      extendedQuotes: () => false,
    });
    stream.subscribe(['MSFT'], { ext: true });
    await vi.advanceTimersByTimeAsync(60);
    expect(fetches).toContain('/quotes?symbols=MSFT');
    expect(fetches.filter((f) => f.startsWith('/quotes/extended'))).toEqual([]);
  });

  it('stops asking for extended quotes after a 501, without raising an error', async () => {
    stream.dispose();
    let calls = 0;
    stream = new QuoteStream({
      url: 'ws://test/ws',
      createSocket: (u) => new FakeSocket(u),
      fetchJson: async <T>(path: string) => {
        if (path.startsWith('/quotes/extended')) {
          calls++;
          throw new ApiError('not supported', 501, { code: 'unsupported', feature: 'extended' });
        }
        return [] as unknown as T;
      },
      isVisible: () => visible,
    });
    stream.subscribe(['MSFT'], { ext: true });
    await vi.advanceTimersByTimeAsync(60);
    expect(calls).toBe(1);
    expect(useQuoteStore.getState().error).toBeNull();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(calls).toBe(1);
  });

  it('caps the socket at 200 symbols (newest first) and polls the rest', async () => {
    const many = Array.from({ length: 205 }, (_, i) => `S${i}`);
    stream.subscribe(many.slice(0, 100));
    stream.subscribe(many.slice(100));
    stream.subscribe(['BAD SYMBOL!']);
    last().open();
    const sent = last().subs();
    expect(sent).toHaveLength(MAX_WS_SYMBOLS);
    expect(sent).not.toContain('S0');
    expect(sent).toContain('S204');
    expect(last().sent.every((m) => (m.symbols?.length ?? 0) <= 50)).toBe(true);
    await vi.advanceTimersByTimeAsync(60);
    fetches = [];
    await vi.advanceTimersByTimeAsync(15_000);
    const polled = decodeURIComponent(fetches[0]!.split('=')[1]!).split(',');
    expect(polled).toHaveLength(6);
    expect(polled).toContain('BAD SYMBOL!');
    expect(polled).toContain('S0');
  });

  it('keeps the status and records the fetch error', async () => {
    const bad = new QuoteStream({
      url: 'ws://test/ws',
      createSocket: (u) => new FakeSocket(u),
      fetchJson: async () => {
        throw new Error('boom');
      },
      isVisible: () => true,
    });
    bad.subscribe(['AAPL']);
    await vi.advanceTimersByTimeAsync(60);
    expect(useQuoteStore.getState().error).toBe('boom');
    expect(useQuoteStore.getState().status).toBe('connecting');
    bad.dispose();
  });

  it('pings every 25 s while open', async () => {
    stream.subscribe(['AAPL']);
    last().open();
    await vi.advanceTimersByTimeAsync(25_000);
    expect(last().sent.filter((m) => m.op === 'ping')).toHaveLength(1);
  });

  describe('onProviderChanged', () => {
    it('calls listeners for the provider.changed frame, without an event subscription', () => {
      const seen: unknown[] = [];
      const other: unknown[] = [];
      const off = stream.onProviderChanged((f) => seen.push(f));
      stream.onProviderChanged((f) => other.push(f));
      stream.subscribe(['AAPL']);
      last().open();
      last().push({ type: 'provider.changed', id: 'demo', previous: 'yahoo' });
      expect(seen).toEqual([{ type: 'provider.changed', id: 'demo', previous: 'yahoo' }]);
      expect(other).toHaveLength(1);
      // Ticks and other frames do not reach it; the socket and its subscriptions stay.
      last().push(tick());
      last().push({ type: 'alerts.changed', topic: 'alerts', ids: [], deleted: [] });
      expect(seen).toHaveLength(1);
      expect(last().closed).toBe(false);
      off();
      last().push({ type: 'provider.changed', id: 'x' });
      expect(seen).toHaveLength(1);
      expect(other).toHaveLength(2);
    });

    it('a throwing listener does not stop the others or the stream', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const seen: unknown[] = [];
      stream.onProviderChanged(() => {
        throw new Error('boom');
      });
      stream.onProviderChanged((f) => seen.push(f));
      stream.subscribe(['AAPL']);
      last().open();
      last().push({ type: 'provider.changed', id: 'demo' });
      expect(seen).toHaveLength(1);
      last().push(tick({ price: 123 }));
      expect(useQuoteStore.getState().quotes.AAPL?.last).toBe(123);
      warn.mockRestore();
    });
  });

  describe('subscribeEvents', () => {
    const topicsSent = () =>
      (last().sent as { op: string; topics?: string[] }[])
        .filter((m) => m.op === 'events')
        .map((m) => m.topics);

    it('sends the topics on open, again on reconnect, and dispatches frames by topic', async () => {
      const frames: object[] = [];
      const opens: boolean[] = [];
      stream.subscribeEvents(['alerts'], {
        onFrame: (f) => frames.push(f),
        onOpen: (re) => opens.push(re),
      });
      expect(FakeSocket.all).toHaveLength(1);
      expect(topicsSent()).toEqual([]); // not open yet
      last().open();
      expect(topicsSent()).toEqual([['alerts']]);
      expect(opens).toEqual([false]);

      last().push({ type: 'alerts.changed', topic: 'alerts', ids: ['a'], deleted: [] });
      last().push({ type: 'drawings.changed', topic: 'drawings', ids: [], deleted: [] });
      expect(frames).toHaveLength(1);

      last().drop();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(FakeSocket.all).toHaveLength(2);
      last().open();
      expect(topicsSent()).toEqual([['alerts']]);
      expect(opens).toEqual([false, true]);
    });

    it('keeps the socket open without symbols, and closes after the last release', async () => {
      const off = stream.subscribeEvents(['alerts'], { onFrame: () => undefined });
      last().open();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(last().closed).toBe(false);
      off();
      expect(topicsSent()).toEqual([['alerts'], []]);
      await vi.advanceTimersByTimeAsync(10_001);
      expect(FakeSocket.all[0]!.closed).toBe(true);
    });

    it('a symbol release does not close the socket while events are subscribed', async () => {
      stream.subscribeEvents(['alerts'], { onFrame: () => undefined });
      const r = stream.subscribe(['AAPL']);
      last().open();
      r();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(last().closed).toBe(false);
    });
  });
});

describe('QuoteStream freshness', () => {
  let fetches: string[] = [];
  let stream: QuoteStream;
  const symbolsOf = (path: string) => decodeURIComponent(path.split('=')[1]!).split(',');
  const mk = () =>
    new QuoteStream({
      url: 'ws://test/ws',
      createSocket: (u) => new FakeSocket(u),
      fetchJson: async <T>(path: string) => {
        fetches.push(path);
        const list = path.startsWith('/quotes?')
          ? symbolsOf(path).map((symbol) => snap({ symbol }))
          : [];
        return list as unknown as T;
      },
      isVisible: () => true,
      random: () => 0.5,
      now: () => Date.now(),
    });
  const quoteFetches = () => fetches.filter((f) => f.startsWith('/quotes?'));
  const last = () => FakeSocket.all[FakeSocket.all.length - 1]!;

  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.all = [];
    fetches = [];
    useQuoteStore.setState({ quotes: {}, missing: {}, status: 'idle', error: null });
    stream = mk();
  });
  afterEach(() => {
    stream.dispose();
    vi.useRealTimers();
  });

  it('re-subscribing within the freshness window makes no fetch', async () => {
    const r = stream.subscribe(['AAPL']);
    await vi.advanceTimersByTimeAsync(60);
    expect(quoteFetches()).toEqual(['/quotes?symbols=AAPL']);
    r();
    await vi.advanceTimersByTimeAsync(2100); // released
    stream.subscribe(['AAPL']);
    await vi.advanceTimersByTimeAsync(100);
    expect(quoteFetches()).toHaveLength(1);
  });

  it('re-subscribing after the snapshot went stale fetches again', async () => {
    const r = stream.subscribe(['AAPL']);
    await vi.advanceTimersByTimeAsync(60);
    r();
    await vi.advanceTimersByTimeAsync(2000 + SNAP_FRESH_MS);
    expect(useQuoteStore.getState().quotes.AAPL).toBeDefined();
    stream.subscribe(['AAPL']);
    await vi.advanceTimersByTimeAsync(100);
    expect(quoteFetches()).toHaveLength(2);
  });

  it('re-subscribing a stale snapshot makes no fetch while a recent tick covers it', async () => {
    stream.subscribe(['MSFT']); // keeps the stream running
    const r = stream.subscribe(['AAPL']);
    last().open();
    await vi.advanceTimersByTimeAsync(60);
    r();
    await vi.advanceTimersByTimeAsync(2000 + SNAP_FRESH_MS); // released, snapshot stale
    last().push(tick({ symbol: 'AAPL', price: 5 })); // a late frame still counts
    fetches = [];
    stream.subscribe(['AAPL']);
    await vi.advanceTimersByTimeAsync(100);
    expect(quoteFetches()).toEqual([]);
  });

  it('refresh skips symbols that are ticking', async () => {
    stream.subscribe(['AAPL', 'MSFT']);
    last().open();
    await vi.advanceTimersByTimeAsync(60);
    fetches = [];
    await vi.advanceTimersByTimeAsync(59_000);
    last().push(tick({ symbol: 'AAPL', price: 5 }));
    await vi.advanceTimersByTimeAsync(1000); // 60 s refresh
    expect(quoteFetches()).toEqual(['/quotes?symbols=MSFT']);
  });

  it('refreshes a ticking symbol once its snapshot is older than the meta interval', async () => {
    stream.subscribe(['AAPL']);
    last().open();
    await vi.advanceTimersByTimeAsync(60);
    fetches = [];
    const end = META_REFRESH_MS + 60_000;
    for (let t = 0; t < end; t += 10_000) {
      last().push(tick({ symbol: 'AAPL', price: 5 + t }));
      await vi.advanceTimersByTimeAsync(10_000);
      if (fetches.length) break;
    }
    expect(quoteFetches()).toEqual(['/quotes?symbols=AAPL']);
  });

  it('prunes released symbols beyond the retention count, oldest first', async () => {
    const total = MAX_RETAINED + 5;
    for (let i = 0; i < total; i++) {
      stream.subscribe([`S${i}`])();
      await vi.advanceTimersByTimeAsync(1); // distinct release times
    }
    await vi.advanceTimersByTimeAsync(2000 + 10_000 + 100); // all released, idle stop prunes
    const keys = Object.keys(useQuoteStore.getState().quotes);
    expect(keys).toHaveLength(MAX_RETAINED);
    for (let i = 0; i < 5; i++) expect(keys).not.toContain(`S${i}`);
    expect(keys).toContain('S5');
    expect(keys).toContain(`S${total - 1}`);
  });
});
