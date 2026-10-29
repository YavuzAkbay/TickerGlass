/** Test harness: fake API (node:http), stub feed, fake clock and control. */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Alert, AlertSpec, FireIn } from '@tickerglass/alerts';
import { DEFAULT_NOTIFY } from '@tickerglass/alerts';
import {
  ExpressionFeed,
  FeedError,
  type Bar,
  type BarListener,
  type DataFeed,
  type GetBarsRequest,
  type GetBarsResult,
  type LiveStatus,
  type SubscribeRequest,
  type SymbolInfo,
  type Unsubscribe,
} from '@tickerglass/engine/node';
import { ApiClient, type StateRow, type StoredDrawing } from './api';
import type { Clock } from './clock';
import { loadConfig, type Config } from './config';
import type { ControlLike } from './control';
import { createLogger } from './log';
import { createService, type Service } from './service';

// ----------------------------------------------------------------- clock

export class FakeClock implements Clock {
  private t: number;
  private seq = 0;
  private timers = new Map<number, { at: number; fn: () => void; every: number | null }>();
  constructor(start: number) {
    this.t = start;
  }
  now(): number {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number): () => void {
    const id = ++this.seq;
    this.timers.set(id, { at: this.t + ms, fn, every: null });
    return () => void this.timers.delete(id);
  }
  setInterval(fn: () => void, ms: number): () => void {
    const id = ++this.seq;
    this.timers.set(id, { at: this.t + ms, fn, every: ms });
    return () => void this.timers.delete(id);
  }
  /** Advance time, firing due timers in order, letting async work settle between steps. */
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      let nextId = -1;
      let nextAt = Infinity;
      for (const [id, tm] of this.timers)
        if (tm.at <= end && tm.at < nextAt) [nextId, nextAt] = [id, tm.at];
      if (nextId < 0) break;
      const tm = this.timers.get(nextId)!;
      this.t = Math.max(this.t, nextAt);
      if (tm.every === null) this.timers.delete(nextId);
      else tm.at += tm.every;
      tm.fn();
      await settle();
    }
    this.t = end;
    await settle();
  }
}

/** Let promise chains and local socket I/O make progress. */
export async function settle(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((r) => setImmediate(r));
}

export async function until(cond: () => boolean, what = 'condition', ms = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise<void>((r) => setTimeout(r, 5));
  }
}

// --------------------------------------------------------------- control

export class FakeControl implements ControlLike {
  connected = true;
  started = false;
  private a: ((ids: string[], deleted: string[]) => void)[] = [];
  private d: ((ids: string[], deleted: string[]) => void)[] = [];
  private c: ((up: boolean) => void)[] = [];
  private p: (() => void)[] = [];
  start(): void {
    this.started = true;
  }
  stop(): void {
    this.started = false;
  }
  onAlertsChanged(fn: (ids: string[], deleted: string[]) => void): void {
    this.a.push(fn);
  }
  onDrawingsChanged(fn: (ids: string[], deleted: string[]) => void): void {
    this.d.push(fn);
  }
  onConnection(fn: (up: boolean) => void): void {
    this.c.push(fn);
  }
  onProviderChanged(fn: () => void): void {
    this.p.push(fn);
  }
  providerChanged(): void {
    for (const f of this.p) f();
  }
  connection(up: boolean): void {
    this.connected = up;
    for (const f of this.c) f(up);
  }
  alertsChanged(ids: string[], deleted: string[] = []): void {
    for (const f of this.a) f(ids, deleted);
  }
  drawingsChanged(ids: string[], deleted: string[] = []): void {
    for (const f of this.d) f(ids, deleted);
  }
}

// ------------------------------------------------------------------ feed

export const INFO: SymbolInfo = {
  symbol: 'TEST',
  name: 'Test',
  exchange: 'TST',
  exchangeName: 'Test',
  type: 'equity',
  currency: 'USD',
  timezone: 'UTC',
  session: null,
  priceHint: 2,
  minTick: 0.01,
};

export class StubFeed implements DataFeed {
  bars = new Map<string, Bar[]>();
  infos = new Map<string, SymbolInfo>();
  getBarsCalls: GetBarsRequest[] = [];
  failBars: FeedError | null = null;
  failResolve: FeedError | null = null;
  /** When set, getBars waits for it (after recording the call). */
  barsGate: Promise<void> | null = null;
  private subs = new Map<string, Set<BarListener>>();
  private liveListeners = new Set<(s: LiveStatus) => void>();

  setBars(symbol: string, interval: string, bars: Bar[]): void {
    this.bars.set(`${symbol}|${interval}`, bars);
  }

  async resolveSymbol(symbol: string): Promise<SymbolInfo> {
    if (this.failResolve) throw this.failResolve;
    return this.infos.get(symbol) ?? { ...INFO, symbol };
  }
  async searchSymbols(): Promise<[]> {
    return [];
  }
  async getBars(req: GetBarsRequest): Promise<GetBarsResult> {
    this.getBarsCalls.push(req);
    if (this.barsGate) await this.barsGate;
    if (this.failBars) throw this.failBars;
    const key = `${req.symbol}|${req.interval.count}${{ minute: 'm', hour: 'h', day: 'D', week: 'W', month: 'M' }[req.interval.unit]}`;
    const all = (this.bars.get(key) ?? []).filter((b) => req.to === undefined || b.time < req.to);
    const out = all.slice(Math.max(0, all.length - req.limit));
    const col = (f: keyof Bar) => Float64Array.from(out.map((b) => b[f]));
    return {
      bars: {
        time: col('time'),
        open: col('open'),
        high: col('high'),
        low: col('low'),
        close: col('close'),
        volume: col('volume'),
      },
      hasMore: out.length < all.length,
    };
  }
  subscribe(req: SubscribeRequest, _last: Bar | null, onBar: BarListener): Unsubscribe {
    const key = `${req.symbol}|${req.interval.count}`;
    const set = this.subs.get(key) ?? new Set();
    set.add(onBar);
    this.subs.set(key, set);
    return () => void set.delete(onBar);
  }
  get subscriptions(): number {
    let n = 0;
    for (const s of this.subs.values()) n += s.size;
    return n;
  }
  emit(symbol: string, intervalCount: number, bar: Bar): void {
    for (const f of this.subs.get(`${symbol}|${intervalCount}`) ?? []) f(bar);
  }
  onStatus(fn: (s: LiveStatus) => void): Unsubscribe {
    this.liveListeners.add(fn);
    return () => void this.liveListeners.delete(fn);
  }
  setLive(connection: LiveStatus['connection']): void {
    for (const f of this.liveListeners) f({ connection, upstream: null, lastError: null });
  }
}

export function bar(time: number, close: number, o = close, h = close, l = close, v = 100): Bar {
  return {
    time,
    open: o,
    high: Math.max(h, close, o),
    low: Math.min(l, close, o),
    close,
    volume: v,
  };
}

/** n 1m bars ending at `lastTime`, closes from `closes` (oldest first). */
export function minuteBars(lastTime: number, closes: number[]): Bar[] {
  return closes.map((c, i) => bar(lastTime - (closes.length - 1 - i) * 60, c));
}

// --------------------------------------------------------------- fake API

export interface FireResponse {
  status: number;
  /** Destroy the socket instead of answering. */
  drop?: boolean;
  body?: unknown;
}

export class FakeApi {
  alerts: Alert[] = [];
  states: StateRow[] = [];
  drawings: StoredDrawing[] = [];
  fires: { id: string; body: FireIn }[] = [];
  statuses: { id: string; body: { revision: number; status: string; reason: string } }[] = [];
  heartbeats: unknown[] = [];
  putStates: StateRow[][] = [];
  /** Responses consumed (in order) by the next fire requests; default 200. */
  fireScript: FireResponse[] = [];
  healthFails = 0;
  /** `active` of GET /api/providers; undefined = the route is missing (404). */
  activeProvider: string | null | undefined = 'yahoo';
  server!: Server;
  url = '';

  async listen(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  private async body(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const text = Buffer.concat(chunks).toString();
    return text ? JSON.parse(text) : undefined;
  }

  private async handle(
    req: IncomingMessage,
    res: import('node:http').ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname;
    const send = (status: number, body?: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(body === undefined ? '' : JSON.stringify(body));
    };
    const body = await this.body(req);
    const m = req.method ?? 'GET';
    if (path === '/api/health') {
      if (this.healthFails > 0) {
        this.healthFails--;
        return send(503, { detail: 'starting' });
      }
      return send(200, { status: 'ok' });
    }
    if (path === '/api/providers' && m === 'GET') {
      if (this.activeProvider === undefined) return send(404, { detail: 'not found' });
      return send(200, { active: this.activeProvider, providers: [] });
    }
    if (path === '/api/drawings') return send(200, { drawings: this.drawings });
    if (path === '/api/alerts/states' && m === 'GET') return send(200, this.states);
    if (path === '/api/alerts/states' && m === 'PUT') {
      const rows = (body as { states: StateRow[] }).states;
      this.putStates.push(rows);
      for (const row of rows) {
        const a = this.alerts.find((x) => x.id === row.alertId);
        if (!a || a.revision !== row.revision) continue;
        this.states = this.states.filter((s) => s.alertId !== row.alertId).concat(row);
      }
      return send(200, { written: rows.map((r) => r.alertId), ignored: [] });
    }
    if (path === '/api/alerts/service/heartbeat') {
      this.heartbeats.push(body);
      return send(204);
    }
    if (path === '/api/alerts' && m === 'GET') return send(200, this.alerts);
    const mm = /^\/api\/alerts\/([^/]+)(?:\/(fire|status))?$/.exec(path);
    if (mm) {
      const id = decodeURIComponent(mm[1]!);
      const alert = this.alerts.find((a) => a.id === id);
      if (!alert) return send(404, { detail: `alert not found: ${id}` });
      if (!mm[2] && m === 'GET') return send(200, alert);
      if (mm[2] === 'status') {
        const b = body as { revision: number; status: string; reason: string };
        this.statuses.push({ id, body: b });
        if (alert.revision !== b.revision || alert.status !== 'active')
          return send(409, { detail: { message: 'changed', current: alert } });
        alert.status = b.status as Alert['status'];
        alert.statusReason = b.reason;
        alert.revision++;
        return send(200, alert);
      }
      if (mm[2] === 'fire') {
        const b = body as FireIn;
        const step = this.fireScript.shift();
        if (step?.drop) {
          req.socket.destroy();
          return;
        }
        if (step && step.status !== 200)
          return send(step.status, step.body ?? { detail: 'scripted' });
        if (!this.fires.some((f) => f.body.fireId === b.fireId)) this.fires.push({ id, body: b });
        if (b.final) {
          alert.status = 'triggered';
          alert.revision++;
        }
        if (b.state) {
          this.states = this.states
            .filter((s) => s.alertId !== id)
            .concat({ alertId: id, revision: alert.revision - (b.final ? 1 : 0), state: b.state });
        }
        alert.fireCount++;
        return send(200, { id: this.fires.length, alertId: id, message: b.message });
      }
    }
    send(404, { detail: 'no route' });
  }
}

export function makeAlert(over: Partial<Alert> & { spec?: AlertSpec } = {}): Alert {
  return {
    id: 'a1',
    name: 'test alert',
    symbol: 'TEST',
    interval: '1m',
    prepost: false,
    spec: {
      schemaVersion: 1,
      left: { kind: 'price', field: 'close' },
      condition: { op: 'crossingUp', right: { kind: 'value', value: 100 } },
      trigger: 'everyTime',
    },
    message: '',
    notify: { ...DEFAULT_NOTIFY },
    expiresAt: null,
    status: 'active',
    statusReason: null,
    drawingId: null,
    revision: 1,
    fireCount: 0,
    lastFiredAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...over,
  };
}

export interface Harness {
  api: FakeApi;
  feed: StubFeed;
  clock: FakeClock;
  control: FakeControl;
  cfg: Config;
  service: Service;
  /** Times the service asked the feeds to forget resolved symbols. */
  symbolCacheClears: number;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** A second service over the same fake API (restart). */
  restart(): Promise<void>;
}

/** Interval-aligned "now" used by tests: 2026-10-15T14:30:30Z. */
export const NOW_S = 1_792_074_600 + 30;
export const BAR_T = 1_792_074_600; // open of the forming 1m bar (14:30:00Z)

export async function harness(
  opts: { env?: Record<string, string>; now?: number; silent?: boolean } = {},
): Promise<Harness> {
  const api = new FakeApi();
  await api.listen();
  const feed = new StubFeed();
  const clock = new FakeClock(opts.now ?? NOW_S * 1000);
  const control = new FakeControl();
  const cfg = loadConfig({
    API_URL: api.url,
    ALERTS_MIN_REFIRE_S: '0',
    ALERTS_STATE_FLUSH_MS: '1000',
    ...opts.env,
  });
  const log = createLogger(
    opts.silent === false ? 'debug' : 'error',
    opts.silent === false ? (l) => process.stderr.write(l + '\n') : () => {},
  );
  const make = (): Service =>
    createService({
      api: new ApiClient({ baseUrl: api.url, attempts: 1, sleep: async () => {} }),
      control,
      feed: new ExpressionFeed(feed),
      clock,
      config: cfg,
      log,
      live: feed,
      clearSymbolCache: () => void h.symbolCacheClears++,
    });
  const h: Harness = {
    api,
    feed,
    clock,
    control,
    cfg,
    service: make(),
    symbolCacheClears: 0,
    async start() {
      await h.service.start();
      await h.service.whenIdle();
      await settle();
      await h.service.whenIdle();
    },
    async stop() {
      await h.service.stop();
    },
    async restart() {
      await h.service.stop();
      h.service = make();
      await h.start();
    },
  };
  return h;
}
