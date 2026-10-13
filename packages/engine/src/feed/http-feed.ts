import type {
  Bar,
  BarListener,
  DataFeed,
  GetBarsRequest,
  GetBarsResult,
  Interval,
  SubscribeRequest,
  SymbolInfo,
  SymbolSearchResult,
  Unsubscribe,
} from '../types';
import { formatInterval, intervalSeconds, isIntraday, toApiInterval } from './intervals';
import {
  bucketStart,
  createBucketContext,
  localDay,
  localMonthIndex,
  monthIndexStart,
  sessionState,
  type BucketContext,
} from './resample';

/** HTTP/API failure. `status` is the HTTP status, or 0 for network/protocol errors. */
export class FeedError extends Error {
  readonly status: number;

  constructor(message: string, status: number, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'FeedError';
    this.status = status;
  }
}

export type UpstreamStatus = 'connected' | 'reconnecting' | 'polling';
export type ConnectionState = 'idle' | 'connecting' | 'open' | 'reconnecting';

/** Live connection state for the UI. */
export interface LiveStatus {
  /** Our WebSocket to the API. */
  connection: ConnectionState;
  /** The API's own upstream feed, from server `status` frames (null until known). */
  upstream: UpstreamStatus | null;
  /** Message of the most recent server `error` frame, if any. */
  lastError: string | null;
}

export type LiveStatusListener = (status: LiveStatus) => void;

export interface HttpDataFeedOptions {
  /** Prefix for `/api/...` requests. Default '' (same origin). */
  baseUrl?: string;
  /** WebSocket URL. Default: derived from `baseUrl` if absolute, else `location` + `/ws`. */
  wsUrl?: string;
  fetchImpl?: typeof fetch;
  WebSocketImpl?: typeof WebSocket;
}

/** Wire shape of a server tick frame (optional fields may be null). */
interface TickFrame {
  symbol: string;
  price: number;
  dayVolume: number | null;
  time: number;
}

const WS_OPEN = 1;
const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 30_000;
const PING_MS = 25_000;
/** Keep an unused socket around briefly so symbol switches do not reconnect. */
const IDLE_CLOSE_MS = 10_000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function toColumn(v: unknown, name: string): Float64Array {
  if (!Array.isArray(v)) throw new FeedError(`malformed bars response: '${name}' missing`, 0);
  const out = new Float64Array(v.length);
  for (let i = 0; i < v.length; i++) {
    const x: unknown = v[i];
    out[i] = typeof x === 'number' ? x : NaN;
  }
  return out;
}

/** Live bar state of one subscription. */
interface LiveSub {
  symbol: string;
  interval: Interval;
  sec: number;
  intraday: boolean;
  prepost: boolean;
  ctx: BucketContext;
  cur: Bar | null;
  prevDayVolume: number | null;
  prevDayVolumeDay: number;
  onBar: BarListener;
}

/**
 * DataFeed over the InvestOpen API. Only serves native API intervals; wrap it in
 * `ResamplingFeed` for the rest.
 */
export class HttpDataFeed implements DataFeed {
  private readonly baseUrl: string;
  private readonly wsUrlOpt: string | undefined;
  private readonly fetchOpt: typeof fetch | undefined;
  private readonly wsImplOpt: typeof WebSocket | undefined;
  private readonly symbolCache = new Map<string, Promise<SymbolInfo>>();

  private ws: WebSocket | null = null;
  private readonly subsBySymbol = new Map<string, Set<LiveSub>>();
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private status: LiveStatus = { connection: 'idle', upstream: null, lastError: null };
  private readonly statusListeners = new Set<LiveStatusListener>();

  constructor(opts: HttpDataFeedOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? '').replace(/\/+$/, '');
    this.wsUrlOpt = opts.wsUrl;
    this.fetchOpt = opts.fetchImpl;
    this.wsImplOpt = opts.WebSocketImpl;
  }

  // -- HTTP -----------------------------------------------------------------

  private async request(path: string): Promise<unknown> {
    const f = this.fetchOpt ?? globalThis.fetch;
    if (typeof f !== 'function') throw new FeedError('fetch is not available', 0);
    let res: Response;
    try {
      res = await f(`${this.baseUrl}${path}`, { headers: { Accept: 'application/json' } });
    } catch (err) {
      throw new FeedError(err instanceof Error ? err.message : 'network error', 0, { cause: err });
    }
    let body: unknown = null;
    let parseError: unknown = null;
    try {
      body = await res.json();
    } catch (err) {
      parseError = err;
    }
    if (!res.ok) {
      throw new FeedError(errorDetail(body) ?? `HTTP ${res.status} ${res.statusText}`, res.status);
    }
    if (parseError !== null) {
      throw new FeedError('invalid JSON response', 0, { cause: parseError });
    }
    return body;
  }

  async getBars(req: GetBarsRequest): Promise<GetBarsResult> {
    const api = toApiInterval(req.interval);
    if (api === null) {
      throw new RangeError(
        `HttpDataFeed: interval ${formatInterval(req.interval)} is not served by the API; use ResamplingFeed`,
      );
    }
    const q = new URLSearchParams({ symbol: req.symbol, interval: api, limit: String(req.limit) });
    if (req.to !== undefined) q.set('to', String(Math.floor(req.to)));
    if (req.adjusted !== undefined) q.set('adjusted', String(req.adjusted));
    if (req.prepost !== undefined) q.set('prepost', String(req.prepost));
    const body = await this.request(`/api/bars?${q.toString()}`);
    if (!isRecord(body)) throw new FeedError('malformed bars response', 0);
    const time = toColumn(body.t, 't');
    const bars = {
      time,
      open: toColumn(body.o, 'o'),
      high: toColumn(body.h, 'h'),
      low: toColumn(body.l, 'l'),
      close: toColumn(body.c, 'c'),
      volume: toColumn(body.v, 'v'),
    };
    const n = time.length;
    if (
      bars.open.length !== n ||
      bars.high.length !== n ||
      bars.low.length !== n ||
      bars.close.length !== n ||
      bars.volume.length !== n
    ) {
      throw new FeedError('malformed bars response: column lengths differ', 0);
    }
    return { bars, hasMore: body.hasMore === true };
  }

  resolveSymbol(symbol: string): Promise<SymbolInfo> {
    const key = symbol.trim().toUpperCase();
    let p = this.symbolCache.get(key);
    if (p === undefined) {
      p = this.request(`/api/symbols/${encodeURIComponent(key)}`).then(parseSymbolInfo);
      this.symbolCache.set(key, p);
      // Do not cache failures; a later call retries.
      p.catch(() => {
        if (this.symbolCache.get(key) === p) this.symbolCache.delete(key);
      });
    }
    return p;
  }

  async searchSymbols(query: string, limit?: number): Promise<SymbolSearchResult[]> {
    const q = query.trim();
    if (q === '') return [];
    const params = new URLSearchParams({ q });
    if (limit !== undefined) params.set('limit', String(limit));
    const body = await this.request(`/api/symbols/search?${params.toString()}`);
    if (!Array.isArray(body)) throw new FeedError('malformed search response', 0);
    const out: SymbolSearchResult[] = [];
    for (const r of body) {
      if (!isRecord(r)) continue;
      const sym = str(r.symbol);
      if (sym === null) continue;
      out.push({
        symbol: sym,
        name: str(r.name) ?? sym,
        exchange: str(r.exchange),
        type: str(r.type),
        typeDisplay: str(r.typeDisplay),
      });
    }
    return out;
  }

  // -- Live -----------------------------------------------------------------

  subscribe(req: SubscribeRequest, lastBar: Bar | null, onBar: BarListener): Unsubscribe {
    if (toApiInterval(req.interval) === null) {
      throw new RangeError(
        `HttpDataFeed: interval ${formatInterval(req.interval)} is not served by the API; use ResamplingFeed`,
      );
    }
    const symbol = req.symbol.trim().toUpperCase();
    const sub: LiveSub = {
      symbol,
      interval: { unit: req.interval.unit, count: req.interval.count },
      sec: intervalSeconds(req.interval),
      intraday: isIntraday(req.interval),
      prepost: req.prepost === true,
      ctx: createBucketContext({ timezone: req.timezone ?? null, session: req.session ?? null }),
      cur: lastBar ? { ...lastBar } : null,
      prevDayVolume: null,
      prevDayVolumeDay: NaN,
      onBar,
    };
    if (req.timezone === undefined || req.session === undefined) {
      // Fill in what the caller did not provide; ticks before this lands use UTC/no session.
      this.resolveSymbol(symbol).then(
        (info) => {
          sub.ctx = createBucketContext({
            timezone: req.timezone !== undefined ? req.timezone : info.timezone,
            session: req.session !== undefined ? req.session : info.session,
          });
        },
        () => {
          // Symbol lookup failed: keep bucketing in UTC without a session. The
          // chart's own resolveSymbol call surfaces the error to the user.
        },
      );
    }

    let set = this.subsBySymbol.get(symbol);
    const first = set === undefined;
    if (set === undefined) {
      set = new Set();
      this.subsBySymbol.set(symbol, set);
    }
    set.add(sub);
    this.clearIdleTimer();
    if (first) this.sendIfOpen({ op: 'subscribe', symbols: [symbol] });
    try {
      this.ensureSocket();
    } catch (err) {
      // No WebSocket / URL available: roll back so state stays consistent.
      set.delete(sub);
      if (set.size === 0) this.subsBySymbol.delete(symbol);
      throw err;
    }

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const s = this.subsBySymbol.get(symbol);
      if (s === undefined) return;
      s.delete(sub);
      if (s.size === 0) {
        this.subsBySymbol.delete(symbol);
        this.sendIfOpen({ op: 'unsubscribe', symbols: [symbol] });
      }
      if (this.subsBySymbol.size === 0) this.scheduleIdleClose();
    };
  }

  /** Listen for connection/upstream status changes. Called immediately with the current state. */
  onStatus(listener: LiveStatusListener): Unsubscribe {
    this.statusListeners.add(listener);
    listener({ ...this.status });
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  /** Current live status snapshot. */
  getStatus(): LiveStatus {
    return { ...this.status };
  }

  /** Close the socket and drop all subscriptions and timers. */
  dispose(): void {
    this.subsBySymbol.clear();
    this.clearIdleTimer();
    this.closeSocket();
    this.setStatus({ connection: 'idle' });
  }

  private setStatus(patch: Partial<LiveStatus>): void {
    const next = { ...this.status, ...patch };
    if (
      next.connection === this.status.connection &&
      next.upstream === this.status.upstream &&
      next.lastError === this.status.lastError
    ) {
      return;
    }
    this.status = next;
    for (const l of [...this.statusListeners]) l({ ...next });
  }

  private resolveWsUrl(): string {
    if (this.wsUrlOpt !== undefined) return this.wsUrlOpt;
    if (/^https?:\/\//i.test(this.baseUrl)) {
      return `${this.baseUrl.replace(/^http/i, 'ws')}/ws`;
    }
    const loc = (globalThis as { location?: Location }).location;
    if (loc === undefined) {
      throw new FeedError('cannot derive WebSocket URL without location; pass wsUrl', 0);
    }
    return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}${this.baseUrl}/ws`;
  }

  private ensureSocket(): void {
    if (this.ws !== null || this.reconnectTimer !== null || this.subsBySymbol.size === 0) return;
    this.connect();
  }

  private connect(): void {
    const Impl = this.wsImplOpt ?? globalThis.WebSocket;
    if (typeof Impl !== 'function') throw new FeedError('WebSocket is not available', 0);
    const ws = new Impl(this.resolveWsUrl());
    this.ws = ws;
    this.setStatus({ connection: this.reconnectAttempt > 0 ? 'reconnecting' : 'connecting' });

    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.reconnectAttempt = 0;
      this.setStatus({ connection: 'open' });
      const symbols = [...this.subsBySymbol.keys()];
      if (symbols.length > 0) this.send({ op: 'subscribe', symbols });
      this.pingTimer = setInterval(() => this.sendIfOpen({ op: 'ping' }), PING_MS);
    };
    ws.onmessage = (ev: MessageEvent) => {
      if (this.ws !== ws) return;
      this.handleFrame(ev.data);
    };
    ws.onerror = () => {
      // A close event always follows; reconnect is handled there.
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.clearPing();
      if (this.subsBySymbol.size === 0) {
        this.setStatus({ connection: 'idle' });
        return;
      }
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** this.reconnectAttempt);
    this.reconnectAttempt++;
    this.setStatus({ connection: 'reconnecting' });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.subsBySymbol.size > 0) this.connect();
      else this.setStatus({ connection: 'idle' });
    }, delay);
  }

  private scheduleIdleClose(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.subsBySymbol.size === 0) {
        this.closeSocket();
        this.setStatus({ connection: 'idle' });
      }
    }, IDLE_CLOSE_MS);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private clearPing(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private closeSocket(): void {
    this.clearPing();
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempt = 0;
    const ws = this.ws;
    this.ws = null;
    if (ws !== null) ws.close();
  }

  private send(msg: unknown): void {
    this.ws?.send(JSON.stringify(msg));
  }

  private sendIfOpen(msg: unknown): void {
    if (this.ws !== null && this.ws.readyState === WS_OPEN) this.send(msg);
  }

  private handleFrame(data: unknown): void {
    if (typeof data !== 'string') return;
    let msg: unknown;
    try {
      msg = JSON.parse(data);
    } catch {
      // Not ours to crash on: the server only sends JSON; ignore garbage frames.
      return;
    }
    if (!isRecord(msg)) return;
    switch (msg.type) {
      case 'tick': {
        const symbol = str(msg.symbol);
        const price = num(msg.price);
        const time = num(msg.time);
        if (symbol === null || price === null || time === null) return;
        this.dispatchTick({ symbol, price, time, dayVolume: num(msg.dayVolume) });
        return;
      }
      case 'status': {
        const up = msg.upstream;
        if (up === 'connected' || up === 'reconnecting' || up === 'polling') {
          this.setStatus({ upstream: up });
        }
        return;
      }
      case 'error':
        this.setStatus({ lastError: str(msg.message) ?? 'unknown server error' });
        return;
      default:
        // 'subscribed' / 'pong' need no handling.
        return;
    }
  }

  private dispatchTick(tick: TickFrame): void {
    const set = this.subsBySymbol.get(tick.symbol.toUpperCase());
    if (set === undefined) return;
    for (const sub of [...set]) {
      const bar = applyTick(sub, tick);
      if (bar !== null) sub.onBar(bar);
    }
  }
}

/** Fold a tick into a subscription's current bar. Returns a copy to emit, or null to ignore. */
function applyTick(sub: LiveSub, tick: TickFrame): Bar | null {
  const t = Math.floor(tick.time / 1000);
  const price = tick.price;
  const state = sessionState(t, sub.ctx);
  // Regular-session bars must not move on pre/post-market prices. Daily and longer
  // bars are always regular-session; intraday ones unless `prepost` was requested.
  if (state === 'out' && (!sub.intraday || !sub.prepost)) return null;

  const cur = sub.cur;
  const bucket = tickBucket(sub, t, state);
  if (cur !== null && bucket < cur.time) return null; // older than the current bar

  // Volume from dayVolume deltas; positive deltas only, and never across a local
  // day change (dayVolume resets, and a gap could otherwise look like a big jump).
  let delta = 0;
  if (tick.dayVolume !== null) {
    const day = localDay(t, sub.ctx);
    if (
      sub.prevDayVolume !== null &&
      sub.prevDayVolumeDay === day &&
      tick.dayVolume > sub.prevDayVolume
    ) {
      delta = tick.dayVolume - sub.prevDayVolume;
    }
    sub.prevDayVolume = tick.dayVolume;
    sub.prevDayVolumeDay = day;
  }

  if (cur !== null && bucket === cur.time) {
    if (price > cur.high) cur.high = price;
    if (price < cur.low) cur.low = price;
    cur.close = price;
    cur.volume += delta;
    return { ...cur };
  }
  const next: Bar = {
    time: bucket,
    open: price,
    high: price,
    low: price,
    close: price,
    volume: delta,
  };
  sub.cur = next;
  return { ...next };
}

/**
 * Bucket of a tick for a native interval.
 *
 * Intraday: continue the current bar's grid (`cur.time + k*sec`). In-session ticks
 * with a known session use the session-anchored bucket instead; within a day that
 * equals the grid, but it stays on 09:30 across DST changes and for 90m. Without a
 * current bar, out-of-session ticks use the epoch-aligned grid (what the API uses).
 *
 * Daily/weekly: calendar bucket in the exchange timezone. Monthly: continue the
 * current bar's N-month grid (so 3M follows whatever quarter alignment the API uses).
 */
function tickBucket(sub: LiveSub, t: number, state: 'in' | 'out' | 'unknown'): number {
  const cur = sub.cur;
  if (cur !== null && t < cur.time) return -Infinity;
  if (sub.intraday) {
    if (state === 'in' && sub.ctx.sess !== null && !sub.ctx.sess.allDay) {
      return bucketStart(t, sub.interval, sub.ctx);
    }
    const epoch = t - (((t % sub.sec) + sub.sec) % sub.sec);
    if (cur === null) return epoch;
    // Leaving the regular session: post-market bars sit on the epoch grid.
    if (state === 'out' && sessionState(cur.time, sub.ctx) === 'in' && epoch > cur.time) {
      return epoch;
    }
    return cur.time + Math.floor((t - cur.time) / sub.sec) * sub.sec;
  }
  if (sub.interval.unit === 'month' && cur !== null) {
    const n = sub.interval.count;
    const cm = localMonthIndex(cur.time, sub.ctx);
    const tm = localMonthIndex(t, sub.ctx);
    return monthIndexStart(cm + Math.floor((tm - cm) / n) * n, sub.ctx);
  }
  const b = bucketStart(t, sub.interval, sub.ctx);
  if (cur !== null && b < cur.time && bucketStart(cur.time, sub.interval, sub.ctx) === b) {
    // The current bar's timestamp is inside this bucket but not at its start
    // (e.g. a provider stamping daily bars at the session open): same bar.
    return cur.time;
  }
  return b;
}

function errorDetail(body: unknown): string | null {
  if (!isRecord(body)) return null;
  const d = body.detail;
  if (typeof d === 'string') return d;
  if (Array.isArray(d)) {
    // FastAPI validation errors: [{loc, msg, type}, ...]
    const msgs = d
      .map((e) => (isRecord(e) ? str(e.msg) : null))
      .filter((m): m is string => m !== null);
    if (msgs.length > 0) return msgs.join('; ');
  }
  return null;
}

function parseSymbolInfo(body: unknown): SymbolInfo {
  if (!isRecord(body)) throw new FeedError('malformed symbol response', 0);
  const symbol = str(body.symbol);
  if (symbol === null) throw new FeedError('malformed symbol response: symbol missing', 0);
  const priceHint = num(body.priceHint) ?? 2;
  return {
    symbol,
    name: str(body.name) ?? symbol,
    exchange: str(body.exchange),
    exchangeName: str(body.exchangeName),
    type: str(body.type),
    currency: str(body.currency),
    timezone: str(body.timezone),
    session: str(body.session),
    priceHint,
    minTick: num(body.minTick) ?? 10 ** -priceHint,
  };
}
