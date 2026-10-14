import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Quote } from '../api/types';
import { emptyQuote, mergeExtended, mergeSnapshot, mergeTick } from './merge';
import { BACKOFF_MS, MAX_WS_SYMBOLS, QuoteStream, type SocketLike } from './stream';
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
    last().push({ type: 'status', upstream: 'connected' }); // first frame resets the backoff
    last().drop();
    const n = FakeSocket.all.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeSocket.all).toHaveLength(n + 1); // back to 1 s
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

  it('evicts quotes of released symbols once the stream goes idle', async () => {
    const r = stream.subscribe(['AAPL']);
    last().open();
    last().push(tick({ symbol: 'AAPL', price: 7 }));
    expect(useQuoteStore.getState().quotes.AAPL).toBeDefined();
    r();
    await vi.advanceTimersByTimeAsync(2000 + 10_000 + 10);
    expect(useQuoteStore.getState().quotes).toEqual({});
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
});
