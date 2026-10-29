/**
 * One shared `/ws` client per tab: reference-counted symbol subscriptions,
 * reconnect with backoff, keepalive pings, and snapshot polling (`/quotes`,
 * `/quotes/extended`) for new symbols, periodic refresh, symbols over the
 * socket cap, and while the socket is down.
 */
import { errorMessage, getJson, isUnsupported } from '../api/client';
import { getCapabilities } from '../api/provider';
import type { Quote } from '../api/types';
import { FRESH_EXT_TICK_MS, FRESH_TICK_MS, mergeExtended, mergeSnapshot, mergeTick } from './merge';
import { useQuoteStore } from './store';
import type { ExtendedQuote, LiveQuote, StreamStatus, TickFrame } from './types';

export const RELEASE_GRACE_MS = 2000;
export const IDLE_CLOSE_MS = 10_000;
export const PING_MS = 25_000;
/** A socket open this long resets the reconnect backoff even if no tick arrived. */
export const STABLE_MS = 10_000;
export const POLL_MS = 15_000;
export const REFRESH_MS = 60_000;
/** A snapshot this recent is reused when a symbol is subscribed again. */
export const SNAP_FRESH_MS = 15_000;
/** Symbols with live ticks only refetch a snapshot (prevClose, marketState) this often. */
export const META_REFRESH_MS = 600_000;
/** Quotes of released symbols are kept this long for quick re-subscription. */
export const RETAIN_MS = 300_000;
/** At most this many released symbols are kept (oldest released go first). */
export const MAX_RETAINED = 500;
export const BATCH_MS = 50;
export const BACKOFF_MS = [1000, 2000, 4000, 8000, 16_000, 30_000] as const;
export const MAX_WS_SYMBOLS = 200;
const WS_CHUNK = 50;
const HTTP_CHUNK = 100;
const WS_SYMBOL = /^[A-Z0-9.\-=^]{1,32}$/;

export interface SocketLike {
  send: (data: string) => void;
  close: () => void;
  onopen: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev?: unknown) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
}

export interface QuoteStreamOptions {
  url?: string;
  createSocket?: (url: string) => SocketLike;
  fetchJson?: <T>(path: string) => Promise<T>;
  isVisible?: () => boolean;
  /** Whether the provider has `/quotes/extended` (default: its capabilities). */
  extendedQuotes?: () => boolean;
  now?: () => number;
  random?: () => number;
}

const defaultUrl = (): string =>
  `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;

function chunks<T>(list: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

/** A frame of a `/ws` event topic (docs/alerts.md §1.6). */
export interface EventFrame {
  type: string;
  topic: string;
  [key: string]: unknown;
}

export interface EventSubscription {
  /** Called for every frame of the subscribed topics. */
  onFrame: (frame: EventFrame) => void;
  /** The socket opened; `reconnected` when it had been down since the last open. */
  onOpen?: (reconnected: boolean) => void;
}

/** `/ws` frame sent to every client when the API switched its data provider. */
export interface ProviderChangedFrame {
  type: 'provider.changed';
  /** Id of the new provider. */
  id?: string;
  /** Id of the provider before the switch (null for a custom one). */
  previous?: string | null;
}

export class QuoteStream {
  private readonly opts: QuoteStreamOptions;
  private refs = new Map<string, number>();
  private extRefs = new Map<string, number>();
  /** Recency of subscription (higher = newer) for the socket cap. */
  private recency = new Map<string, number>();
  private seq = 0;
  private socket: SocketLike | null = null;
  private open = false;
  /** Symbols the server has been told about on the current socket. */
  private sent = new Set<string>();
  private attempt = 0;
  /** The socket dropped since the last open: snapshots are refreshed on reconnect. */
  private wasDown = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private batchTimer: ReturnType<typeof setTimeout> | null = null;
  private stableTimer: ReturnType<typeof setTimeout> | null = null;
  private timers: ReturnType<typeof setInterval>[] = [];
  private pendingSnap = new Set<string>();
  private pendingExt = new Set<string>();
  /** When each symbol's last `/quotes` / `/quotes/extended` snapshot arrived (ms). */
  private snapAt = new Map<string, number>();
  private extAt = new Map<string, number>();
  /** When the last regular / extended tick arrived over the socket (ms, local clock). */
  private tickAt = new Map<string, number>();
  private extTickAt = new Map<string, number>();
  /** When a symbol lost its last subscriber; drives retention. */
  private releasedAt = new Map<string, number>();
  private running = false;
  /** `/quotes/extended` answered 501: the provider has no pre/post-market quotes. */
  private extUnsupported = false;
  private onVisibility: (() => void) | null = null;
  private eventSubs = new Set<{ topics: string[]; sub: EventSubscription }>();
  private providerFns = new Set<(frame: ProviderChangedFrame) => void>();
  /** Topic set the server has on the current socket (sorted, joined); null = none sent yet. */
  private sentTopics: string | null = null;

  constructor(opts: QuoteStreamOptions = {}) {
    this.opts = opts;
  }

  /** Subscribe; the returned function releases after a short grace period. */
  subscribe(symbols: string[], opts: { ext?: boolean } = {}): () => void {
    const syms = [...new Set(symbols.map((s) => s.trim().toUpperCase()).filter(Boolean))];
    if (syms.length) this.prune(); // retention is enforced before reuse
    const now = this.now();
    for (const s of syms) {
      const n = this.refs.get(s) ?? 0;
      this.refs.set(s, n + 1);
      this.recency.set(s, ++this.seq);
      this.releasedAt.delete(s);
      if (n === 0 && this.needsSnapshot(s, now)) this.pendingSnap.add(s);
      if (opts.ext) {
        const e = this.extRefs.get(s) ?? 0;
        this.extRefs.set(s, e + 1);
        if (e === 0 && this.needsExtended(s, now)) this.pendingExt.add(s);
      }
    }
    if (!syms.length) return () => undefined;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.ensureRunning();
    this.syncSocket();
    this.scheduleBatch();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      setTimeout(() => this.release(syms, !!opts.ext), RELEASE_GRACE_MS);
    };
  }

  /**
   * Subscribe to `/ws` event topics. Keeps the socket open like a symbol ref,
   * is re-sent on every (re)connect, and is released immediately.
   */
  subscribeEvents(topics: string[], sub: EventSubscription): () => void {
    const entry = { topics: [...new Set(topics)], sub };
    this.eventSubs.add(entry);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.ensureRunning();
    this.syncEvents();
    return () => {
      if (!this.eventSubs.delete(entry)) return;
      this.syncEvents();
      this.scheduleIdle();
    };
  }

  /**
   * Call `fn` when the API switched its data provider (quotes and bars then come from another
   * source). Needs no subscription of its own: the frame goes to every open socket.
   */
  onProviderChanged(fn: (frame: ProviderChangedFrame) => void): () => void {
    this.providerFns.add(fn);
    return () => void this.providerFns.delete(fn);
  }

  /** Stop everything (tests / teardown). */
  dispose(): void {
    this.stop();
    this.providerFns.clear();
    this.refs.clear();
    this.extRefs.clear();
    this.eventSubs.clear();
    for (const m of [this.snapAt, this.extAt, this.tickAt, this.extTickAt, this.releasedAt])
      m.clear();
  }

  // ------------------------------------------------------------ internals

  private get visible(): boolean {
    return this.opts.isVisible
      ? this.opts.isVisible()
      : typeof document === 'undefined' || document.visibilityState === 'visible';
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  private setStatus(status: StreamStatus): void {
    if (useQuoteStore.getState().status !== status) useQuoteStore.setState({ status });
  }

  private release(syms: string[], ext: boolean): void {
    for (const s of syms) {
      const n = (this.refs.get(s) ?? 0) - 1;
      if (n > 0) this.refs.set(s, n);
      else {
        this.refs.delete(s);
        this.recency.delete(s);
        this.releasedAt.set(s, this.now());
      }
      if (ext) {
        const e = (this.extRefs.get(s) ?? 0) - 1;
        if (e > 0) this.extRefs.set(s, e);
        else this.extRefs.delete(s);
      }
    }
    this.syncSocket();
    this.scheduleIdle();
  }

  private scheduleIdle(): void {
    if (!this.refs.size && !this.eventSubs.size && !this.idleTimer && this.running)
      this.idleTimer = setTimeout(() => {
        this.idleTimer = null;
        if (!this.refs.size && !this.eventSubs.size) this.stop();
      }, IDLE_CLOSE_MS);
  }

  private ensureRunning(): void {
    if (this.running) return;
    this.running = true;
    this.timers = [
      setInterval(() => this.ping(), PING_MS),
      setInterval(() => this.poll(), POLL_MS),
      setInterval(() => this.refresh(), REFRESH_MS),
    ];
    if (typeof document !== 'undefined') {
      this.onVisibility = () => {
        if (this.visible) this.refresh();
      };
      document.addEventListener('visibilitychange', this.onVisibility);
    }
    this.connect();
  }

  private stop(): void {
    this.running = false;
    this.timers.forEach((t) => clearInterval(t));
    this.timers = [];
    for (const t of [this.reconnectTimer, this.idleTimer, this.batchTimer, this.stableTimer])
      if (t) clearTimeout(t);
    this.reconnectTimer = this.idleTimer = this.batchTimer = this.stableTimer = null;
    if (this.onVisibility && typeof document !== 'undefined')
      document.removeEventListener('visibilitychange', this.onVisibility);
    this.onVisibility = null;
    const ws = this.socket;
    this.socket = null;
    this.open = false;
    this.sent.clear();
    this.sentTopics = null;
    this.attempt = 0;
    this.pendingSnap.clear();
    this.pendingExt.clear();
    ws?.close();
    this.prune(); // quotes stay for quick re-subscription; only the retention bounds apply
    this.setStatus('idle');
  }

  // ------------------------------------------------------------ socket

  private connect(): void {
    if (this.socket || !this.running) return;
    this.setStatus('connecting');
    let ws: SocketLike;
    try {
      ws = this.opts.createSocket
        ? this.opts.createSocket(this.opts.url ?? defaultUrl())
        : (new WebSocket(this.opts.url ?? defaultUrl()) as unknown as SocketLike);
    } catch (err) {
      console.warn('quote stream: socket could not be created', err);
      this.setStatus('fallback-polling');
      this.scheduleReconnect();
      return;
    }
    this.socket = ws;
    ws.onopen = () => {
      if (this.socket !== ws) return;
      this.open = true;
      // A socket that stays open long enough counts as healthy even without ticks.
      if (this.stableTimer) clearTimeout(this.stableTimer);
      this.stableTimer = setTimeout(() => {
        this.stableTimer = null;
        if (this.socket === ws) this.attempt = 0;
      }, STABLE_MS);
      this.sent.clear();
      this.sentTopics = null;
      this.syncSocket();
      this.syncEvents();
      const reconnected = this.wasDown;
      if (reconnected) this.refresh(); // catch up on what was missed
      this.wasDown = false;
      for (const { sub } of [...this.eventSubs]) sub.onOpen?.(reconnected);
    };
    ws.onmessage = (ev) => {
      if (this.socket === ws) this.onMessage(ev.data);
    };
    const down = () => {
      if (this.socket !== ws) return;
      this.socket = null;
      this.open = false;
      if (this.stableTimer) clearTimeout(this.stableTimer);
      this.stableTimer = null;
      this.sent.clear();
      this.sentTopics = null;
      try {
        ws.close(); // onerror does not imply close: avoid an orphan socket
      } catch {
        /* already closed */
      }
      if (!this.running) return;
      this.wasDown = true;
      this.setStatus('fallback-polling');
      this.scheduleReconnect();
    };
    ws.onclose = down;
    ws.onerror = down;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || !this.running) return;
    const base = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)]!;
    this.attempt++;
    const rnd = this.opts.random ? this.opts.random() : Math.random();
    const delay = Math.round(base * (0.8 + rnd * 0.4));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private onMessage(data: unknown): void {
    let msg: unknown;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (typeof msg !== 'object' || msg === null) return;
    const frame = msg as { type?: string } & Record<string, unknown>;
    if (frame.type === 'tick') {
      this.attempt = 0; // data is flowing: genuinely healthy (status/error frames are not proof)
      const t = frame as unknown as TickFrame;
      if (typeof t.symbol !== 'string' || typeof t.price !== 'number') return;
      const sym = t.symbol.toUpperCase();
      const extTick = t.marketHours === 0 || t.marketHours === 2 || t.marketHours === 3;
      (extTick ? this.extTickAt : this.tickAt).set(sym, this.now());
      useQuoteStore.setState((s) => ({
        quotes: { ...s.quotes, [sym]: mergeTick(s.quotes[sym], { ...t, symbol: sym }) },
        ...(s.status === 'connecting' || s.status === 'fallback-polling'
          ? { status: 'live' as const }
          : {}),
      }));
    } else if (frame.type === 'status') {
      if (frame.upstream === 'connected') this.setStatus('live');
      else if (frame.upstream === 'polling') this.setStatus('upstream-polling');
      // 'reconnecting' keeps the previous status.
    } else if (frame.type === 'provider.changed') {
      for (const fn of [...this.providerFns]) {
        try {
          fn(frame as unknown as ProviderChangedFrame);
        } catch (err) {
          console.warn('quote stream: provider change handler failed', err);
        }
      }
    } else if (typeof frame.topic === 'string') {
      const f = frame as EventFrame;
      for (const { topics, sub } of [...this.eventSubs])
        if (topics.includes(f.topic)) {
          try {
            sub.onFrame(f);
          } catch (err) {
            console.warn('quote stream: event handler failed', err);
          }
        }
    } else if (frame.type === 'error') {
      console.warn('quote stream error', frame);
    }
  }

  private send(msg: object): void {
    try {
      this.socket?.send(JSON.stringify(msg));
    } catch (err) {
      console.warn('quote stream: send failed', err);
    }
  }

  private ping(): void {
    if (this.open) this.send({ op: 'ping' });
  }

  /** Symbols that go over the socket: valid, most recently subscribed first, capped. */
  private wsSet(): Set<string> {
    const list = [...this.refs.keys()]
      .filter((s) => WS_SYMBOL.test(s))
      .sort((a, b) => (this.recency.get(b) ?? 0) - (this.recency.get(a) ?? 0))
      .slice(0, MAX_WS_SYMBOLS);
    return new Set(list);
  }

  /** Send the union of event topics when it changed since the last send on this socket. */
  private syncEvents(): void {
    if (!this.open) return;
    const topics = [...new Set([...this.eventSubs].flatMap((e) => e.topics))].sort();
    const key = topics.join(',');
    if (this.sentTopics === null && !topics.length) return; // nothing to say yet
    if (this.sentTopics === key) return;
    this.sentTopics = key;
    this.send({ op: 'events', topics });
  }

  private syncSocket(): void {
    if (!this.open) return;
    const want = this.wsSet();
    const add = [...want].filter((s) => !this.sent.has(s));
    const drop = [...this.sent].filter((s) => !want.has(s));
    for (const c of chunks(drop, WS_CHUNK)) this.send({ op: 'unsubscribe', symbols: c });
    for (const c of chunks(add, WS_CHUNK)) this.send({ op: 'subscribe', symbols: c });
    this.sent = want;
  }

  // ------------------------------------------------------------ snapshots

  private scheduleBatch(): void {
    if (this.batchTimer || (!this.pendingSnap.size && !this.pendingExt.size)) return;
    this.batchTimer = setTimeout(() => {
      this.batchTimer = null;
      const snap = [...this.pendingSnap];
      const ext = [...this.pendingExt];
      this.pendingSnap.clear();
      this.pendingExt.clear();
      void this.fetchQuotes(snap);
      void this.fetchExtended(ext);
    }, BATCH_MS);
  }

  /** Every 15 s: all symbols while the socket is down, otherwise only those over the cap. */
  private poll(): void {
    if (!this.visible) return;
    const targets = this.open
      ? [...this.refs.keys()].filter((s) => !this.sent.has(s))
      : [...this.refs.keys()];
    void this.fetchQuotes(targets);
  }

  /**
   * Every 60 s (and on reconnect / when the page becomes visible): symbols
   * without a fresh tick, plus ticking ones whose snapshot is over 10 min old.
   */
  private refresh(): void {
    this.prune();
    if (!this.visible) return;
    const now = this.now();
    const due =
      (at: Map<string, number>, ticks: Map<string, number>, fresh: number) => (s: string) => {
        const t = ticks.get(s);
        if (t === undefined || now - t >= fresh) return true;
        return now - (at.get(s) ?? -Infinity) > META_REFRESH_MS;
      };
    void this.fetchQuotes(
      [...this.refs.keys()].filter(due(this.snapAt, this.tickAt, FRESH_TICK_MS)),
    );
    void this.fetchExtended(
      [...this.extRefs.keys()].filter(due(this.extAt, this.extTickAt, FRESH_EXT_TICK_MS)),
    );
  }

  /** A re-subscribed symbol needs a snapshot unless a recent one or a live tick covers it. */
  private needsSnapshot(s: string, now: number): boolean {
    if (!useQuoteStore.getState().quotes[s]) return true;
    return (
      now - (this.snapAt.get(s) ?? -Infinity) > SNAP_FRESH_MS &&
      now - (this.tickAt.get(s) ?? -Infinity) >= FRESH_TICK_MS
    );
  }

  private needsExtended(s: string, now: number): boolean {
    return (
      now - (this.extAt.get(s) ?? -Infinity) > SNAP_FRESH_MS &&
      now - (this.extTickAt.get(s) ?? -Infinity) >= FRESH_EXT_TICK_MS
    );
  }

  /** Drop released symbols after RETAIN_MS, and the oldest released beyond MAX_RETAINED. */
  private prune(): void {
    const now = this.now();
    const drop = new Set<string>();
    const kept: [string, number][] = [];
    for (const [s, at] of this.releasedAt) {
      if (this.refs.has(s)) continue;
      if (now - at >= RETAIN_MS) drop.add(s);
      else kept.push([s, at]);
    }
    if (kept.length > MAX_RETAINED) {
      kept.sort((a, b) => a[1] - b[1]);
      for (const [s] of kept.slice(0, kept.length - MAX_RETAINED)) drop.add(s);
    }
    if (!drop.size) return;
    for (const s of drop) {
      for (const m of [this.snapAt, this.extAt, this.tickAt, this.extTickAt, this.releasedAt])
        m.delete(s);
    }
    useQuoteStore.setState((st) => {
      const quotes = { ...st.quotes };
      const missing = { ...st.missing };
      for (const s of drop) {
        delete quotes[s];
        delete missing[s];
      }
      return { quotes, missing };
    });
  }

  private async get<T>(path: string): Promise<T> {
    return this.opts.fetchJson ? this.opts.fetchJson<T>(path) : getJson<T>(path);
  }

  private async fetchQuotes(symbols: string[]): Promise<void> {
    await Promise.all(
      chunks(symbols, HTTP_CHUNK).map(async (c) => {
        try {
          const list = await this.get<Quote[]>(
            `/quotes?symbols=${encodeURIComponent(c.join(','))}`,
          );
          const now = this.now();
          useQuoteStore.setState((s) => {
            const quotes = { ...s.quotes };
            const missing = { ...s.missing };
            for (const q of list) {
              const sym = q.symbol.toUpperCase();
              quotes[sym] = mergeSnapshot(quotes[sym], { ...q, symbol: sym }, now);
              this.snapAt.set(sym, now);
              delete missing[sym];
            }
            const got = new Set(list.map((q) => q.symbol.toUpperCase()));
            for (const c0 of c) if (!got.has(c0) && !quotes[c0]) missing[c0] = true;
            return { quotes, missing, error: null };
          });
        } catch (err) {
          useQuoteStore.setState({ error: errorMessage(err) });
        }
      }),
    );
  }

  /** Pre/post-market snapshots exist unless the provider says (or answers 501) otherwise. */
  private get extendedSupported(): boolean {
    if (this.extUnsupported) return false;
    return this.opts.extendedQuotes ? this.opts.extendedQuotes() : getCapabilities().extendedQuotes;
  }

  private async fetchExtended(symbols: string[]): Promise<void> {
    if (!symbols.length || !this.extendedSupported) return;
    await Promise.all(
      chunks(symbols, HTTP_CHUNK).map(async (c) => {
        try {
          const list = await this.get<ExtendedQuote[]>(
            `/quotes/extended?symbols=${encodeURIComponent(c.join(','))}`,
          );
          const now = this.now();
          useQuoteStore.setState((s) => {
            const quotes: Record<string, LiveQuote> = { ...s.quotes };
            for (const e of list) {
              const sym = e.symbol.toUpperCase();
              quotes[sym] = mergeExtended(quotes[sym], { ...e, symbol: sym }, now);
              this.extAt.set(sym, now);
            }
            return { quotes, error: null };
          });
        } catch (err) {
          // 501: no pre/post-market data from this provider. Not an error; stop asking.
          if (isUnsupported(err)) this.extUnsupported = true;
          else useQuoteStore.setState({ error: errorMessage(err) });
        }
      }),
    );
  }
}

let singleton: QuoteStream | null = null;

/** The tab's shared stream. */
export function getQuoteStream(): QuoteStream {
  singleton ??= new QuoteStream();
  return singleton;
}
