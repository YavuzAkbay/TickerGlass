/**
 * Opt-in mock of the live market data a watchlist shows: `/api/quotes`,
 * `/api/quotes/extended`, `/api/sparklines`, `/api/performance/{symbol}`, `/api/news/{symbol}`,
 * `/api/events/{symbol}`, `/api/fundamentals/{symbol}` and the `/ws` quote stream. Not part of the auto fixture in ./fixtures.ts: only specs that
 * assert on prices call `mockMarket(page)`, before `page.goto`.
 *
 * The socket is fully mocked (no backend behind it). It answers `subscribe`
 * like the real hub (`{type:'subscribed'}`, then status "connected"), and
 * the test pushes frames with `pushTick` or drops the connection with
 * `close()`. `op: events` is answered like the hub does (topics recorded in
 * `eventTopics`) and `pushAlertFired` sends an `alert.fired` frame. After `close()` new connections are refused (so the client
 * stays in its polling fallback) until `reopen()`.
 */
import { readFileSync } from 'node:fs';
import type { Page, Route, WebSocketRoute } from '@playwright/test';

type Json = Record<string, unknown>;

export interface MockQuote {
  symbol: string;
  last: number | null;
  prevClose: number | null;
  change: number | null;
  changePercent: number | null;
  volume: number | null;
  currency: string | null;
  marketState: string | null;
  time: number | null;
}

/** A `GET /api/quotes` item with change and change% derived from last and prevClose. */
export function quote(symbol: string, last: number, prevClose: number, volume = 1_000_000) {
  return {
    symbol,
    last,
    prevClose,
    change: last - prevClose,
    changePercent: ((last - prevClose) / prevClose) * 100,
    volume,
    currency: 'USD',
    marketState: 'REGULAR',
    time: 1_790_000_000,
  } satisfies MockQuote;
}

/** A `tick` frame of `/ws`. */
export function tick(symbol: string, price: number, extra: Json = {}): Json {
  return {
    type: 'tick',
    symbol,
    price,
    change: null,
    changePercent: null,
    dayVolume: null,
    dayHigh: null,
    dayLow: null,
    time: Date.now(),
    marketHours: 1,
    ...extra,
  };
}

/** A `GET /api/sparklines` entry: daily closes (oldest first) with each bar's open time in unix seconds. */
export interface MockSparkline {
  closes: number[];
  time: number[];
}

/** A gently rising series of `n` daily closes ending at `last`. */
export function sparkline(last = 100, n = 30): MockSparkline {
  const day = 86_400;
  const end = 1_790_000_000;
  return {
    closes: Array.from({ length: n }, (_, i) => +(last - (n - 1 - i) * 0.1).toFixed(2)),
    time: Array.from({ length: n }, (_, i) => end - (n - 1 - i) * day),
  };
}

const PERIODS = ['1W', '1M', '3M', '6M', 'YTD', '1Y', '5Y'] as const;

export interface MarketOptions {
  /** Answers of `/api/quotes` by symbol; unknown symbols get a flat 100 / 99 quote. */
  quotes?: Record<string, MockQuote>;
  /** Answers of `/api/quotes/extended` by symbol; unknown symbols are left out. */
  extended?: Record<string, Json>;
  /** Answers of `/api/sparklines` by symbol (null: unknown); others get a rising 30-day series. */
  sparklines?: Record<string, MockSparkline | null>;
  /** Answers of `/api/performance/{symbol}`; unknown symbols get +1 % for every period. */
  performance?: Record<string, Json>;
  /** Answers of `/api/news/{symbol}`; unknown symbols get two headlines. */
  news?: Record<string, Json[]>;
  /** Answers of `/api/events/{symbol}`; unknown symbols get earnings in 6 days, a dividend and a split. */
  events?: Record<string, Json>;
  /** Answers of `/api/fundamentals/{symbol}`; unknown symbols get a small `info` block. */
  fundamentals?: Record<string, Json>;
  /**
   * `/api/screener/{status,fields,universe,lists,scan,presets,screens,runs}`. Default: the server
   * screener is off (`supported: false`) so the page runs its live-only engine on
   * the class universes served from `fixtures/screener-universe.json` (generated from the API's
   * `screener_data`). See `ScreenerMockOptions`.
   */
  screener?: ScreenerMockOptions;
}

/** One request of the detail pane's slow endpoints. */
export interface InfoRequest {
  kind: 'news' | 'events' | 'fundamentals';
  /** Upper-case symbol. */
  symbol: string;
  /** The `X-TickerGlass-Priority` header sent, if any. */
  priority: string | null;
}

export interface MockMarket {
  /** The screener endpoints' state and request log. */
  screener: ScreenerMock;
  /** Every `/api/quotes` request, as the decoded `symbols` query. */
  quoteRequests: string[];
  extendedRequests: string[];
  /** Every `/api/sparklines` request, as the decoded `symbols` query. */
  sparklineRequests: string[];
  /** Every `/api/news|events|fundamentals/{symbol}` request, in order. */
  infoRequests: InfoRequest[];
  /** Symbols of every `subscribe` frame received (all sockets, in order). */
  subscribed: string[];
  /** Currently open sockets. */
  readonly sockets: number;
  /** Send a frame to every open socket. */
  push(frame: Json): void;
  /** Send a `tick` frame; `extra` overrides fields (e.g. `{marketHours: 2}`). */
  pushTick(symbol: string, price: number, extra?: Json): void;
  /** Topic sets of every `op: events` frame received (all sockets, in order). */
  eventTopics: string[][];
  /** Send an `alert.fired` frame of topic `alerts` (docs/alerts.md section 1.6). */
  pushAlertFired(entry: Json, alert: Json): void;
  /** Close every socket and refuse new ones until `reopen()`. */
  close(): void;
  reopen(): void;
}

const defaultNews = (symbol: string): Json[] => [
  {
    id: `${symbol}-1`,
    title: `${symbol} unveils new product line`,
    publisher: 'Wire Service',
    url: `https://news.example.com/${symbol}/1`,
    time: Math.floor(Date.now() / 1000) - 3 * 3600,
    thumbnail: null,
  },
  {
    id: `${symbol}-2`,
    title: `Analysts weigh in on ${symbol}`,
    publisher: 'Daily Markets',
    url: `https://news.example.com/${symbol}/2`,
    time: Math.floor(Date.now() / 1000) - 26 * 3600,
    thumbnail: null,
  },
];

const defaultEvents = (): Json => {
  const day = 86_400;
  const midnight = Math.floor(Date.now() / 1000 / day) * day;
  return {
    earnings: [
      { t: midnight + 6 * day, epsEstimate: 1.23, epsActual: null, surprisePercent: null },
    ],
    dividends: [{ t: midnight - 30 * day, amount: 0.25 }],
    splits: [{ t: Date.UTC(2020, 7, 31) / 1000, ratio: 4 }],
  };
};

export async function mockMarket(page: Page, opts: MarketOptions = {}): Promise<MockMarket> {
  const sockets = new Set<WebSocketRoute>();
  let refuse = false;
  const screener = newScreenerMock(opts.screener);
  const m: MockMarket = {
    screener,
    quoteRequests: [],
    extendedRequests: [],
    sparklineRequests: [],
    infoRequests: [],
    subscribed: [],
    eventTopics: [],
    get sockets() {
      return sockets.size;
    },
    push: (frame) => {
      for (const ws of sockets) ws.send(JSON.stringify(frame));
    },
    pushTick: (symbol, price, extra) => m.push(tick(symbol, price, extra)),
    pushAlertFired: (entry, alert) =>
      m.push({ type: 'alert.fired', topic: 'alerts', entry, alert }),
    close: () => {
      refuse = true;
      for (const ws of [...sockets]) void ws.close();
      sockets.clear();
    },
    reopen: () => {
      refuse = false;
    },
  };
  const symbolsOf = (url: URL) =>
    (url.searchParams.get('symbols') ?? '').split(',').filter(Boolean);

  await page.route(
    (url) => url.pathname === '/api/quotes',
    async (route: Route) => {
      const url = new URL(route.request().url());
      m.quoteRequests.push(url.searchParams.get('symbols') ?? '');
      const out = symbolsOf(url).map(
        (s) => opts.quotes?.[s.toUpperCase()] ?? quote(s.toUpperCase(), 100, 99),
      );
      await route.fulfill({ json: out });
    },
  );
  await page.route(
    (url) => url.pathname === '/api/quotes/extended',
    async (route: Route) => {
      const url = new URL(route.request().url());
      m.extendedRequests.push(url.searchParams.get('symbols') ?? '');
      const out = symbolsOf(url).flatMap((s) => {
        const e = opts.extended?.[s.toUpperCase()];
        return e ? [e] : [];
      });
      await route.fulfill({ json: out });
    },
  );
  await page.route(
    (url) => url.pathname === '/api/sparklines',
    async (route: Route) => {
      const url = new URL(route.request().url());
      m.sparklineRequests.push(url.searchParams.get('symbols') ?? '');
      const n = Number(url.searchParams.get('limit')) || 30;
      const out: Record<string, MockSparkline | null> = {};
      for (const s of symbolsOf(url).map((x) => x.trim().toUpperCase())) {
        out[s] = s in (opts.sparklines ?? {}) ? opts.sparklines![s]! : sparkline(100, n);
      }
      await route.fulfill({ json: out });
    },
  );
  await page.route(
    (url) => url.pathname.startsWith('/api/performance/'),
    async (route: Route) => {
      const symbol = decodeURIComponent(new URL(route.request().url()).pathname.split('/').pop()!)
        .trim()
        .toUpperCase();
      await route.fulfill({
        json: opts.performance?.[symbol] ?? {
          symbol,
          timezone: 'America/New_York',
          asOf: 1_790_000_000,
          last: 100,
          periods: PERIODS.map((key) => ({
            key,
            baseTime: 1_780_000_000,
            baseClose: 99,
            changePercent: 1.01,
          })),
        },
      });
    },
  );

  const infoRoute = (kind: InfoRequest['kind'], answer: (symbol: string) => unknown) =>
    page.route(
      (url) => url.pathname.startsWith(`/api/${kind}/`),
      async (route: Route) => {
        const req = route.request();
        const symbol = decodeURIComponent(new URL(req.url()).pathname.split('/').pop()!)
          .trim()
          .toUpperCase();
        m.infoRequests.push({
          kind,
          symbol,
          priority: (await req.allHeaders())['x-tickerglass-priority'] ?? null,
        });
        await route.fulfill({ json: answer(symbol) });
      },
    );
  await infoRoute('news', (symbol) => opts.news?.[symbol] ?? defaultNews(symbol));
  await infoRoute('events', (symbol) => opts.events?.[symbol] ?? defaultEvents());
  await infoRoute(
    'fundamentals',
    (symbol) =>
      opts.fundamentals?.[symbol] ?? {
        info: {
          trailingPE: 28.5,
          forwardPE: 25.1,
          beta: 1.2,
          dividendYield: 0.5,
          sector: 'Technology',
          industry: 'Consumer Electronics',
        },
        financials: {},
      },
  );

  await page.routeWebSocket('**/ws', (ws) => {
    if (refuse) {
      void ws.close();
      return;
    }
    sockets.add(ws);
    ws.onClose(() => sockets.delete(ws));
    ws.onMessage((raw) => {
      let msg: { op?: string; symbols?: string[]; topics?: string[] };
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.op === 'subscribe') {
        m.subscribed.push(...(msg.symbols ?? []));
        ws.send(JSON.stringify({ type: 'subscribed', symbols: msg.symbols ?? [] }));
        ws.send(JSON.stringify({ type: 'status', upstream: 'connected' }));
      } else if (msg.op === 'events') {
        const topics = msg.topics ?? [];
        m.eventTopics.push(topics);
        ws.send(JSON.stringify({ type: 'events', topics }));
      }
    });
    ws.send(JSON.stringify({ type: 'status', upstream: 'connected' }));
  });
  await routeScreener(page, screener);
  return m;
}

// ---------------------------------------------------------------------------
// GET /api/screener/snapshot (server screener nightly snapshot rows; WP6 watchlist columns)

/** Snapshot rows by upper-case symbol; symbols not listed are omitted (untracked). */
export interface SnapshotMockOptions {
  rows?: Record<string, Json>;
  asOf?: string;
  /** Answer with this status instead (e.g. 404 = endpoint absent). */
  status?: number;
}

export interface SnapshotMock {
  /** Every request, as the decoded `symbols` query. */
  requests: string[];
}

export async function mockSnapshots(
  page: Page,
  opts: SnapshotMockOptions = {},
): Promise<SnapshotMock> {
  const mock: SnapshotMock = { requests: [] };
  await page.route(
    (url) => url.pathname === '/api/screener/snapshot',
    async (route: Route) => {
      const url = new URL(route.request().url());
      const symbols = (url.searchParams.get('symbols') ?? '').split(',').filter(Boolean);
      mock.requests.push(symbols.join(','));
      if (opts.status) {
        await route.fulfill({ status: opts.status, json: { detail: 'not available' } });
        return;
      }
      const rows: Record<string, Json> = {};
      for (const s of symbols) {
        const r = opts.rows?.[s.toUpperCase()];
        if (r) rows[s.toUpperCase()] = r;
      }
      await route.fulfill({ json: { asOf: opts.asOf ?? '2026-11-05', rows } });
    },
  );
  return mock;
}

// ---------------------------------------------------------------------------
// /api/screener/* (server-side screener, docs/design/server-screener.md section 4)

type ScreenerPreset = 'off' | 'server' | 'first_run';

export interface ScreenerMockOptions {
  /**
   * `off` (default): `supported: false`, client mode. `server`: a finished snapshot.
   * `first_run`: supported, no snapshot yet, a run in progress.
   */
  mode?: ScreenerPreset;
  /** Snapshot rows the scan serves (default: `SCREENER_ROWS`). */
  rows?: Json[];
  /** `/screener/universe?cls=` answers by class; other classes get the fixture universe. */
  universe?: Record<string, Json>;
  /** Fail every `/screener/universe` request with this status (the API-unreachable state). */
  universeStatus?: number;
  /** Fail every scan with this status. */
  scanStatus?: number;
}

export interface ScreenerMock {
  readonly options: ScreenerMockOptions;
  /** Live status body; change it with `setStatus`. */
  status: Json;
  setStatus(patch: Json): void;
  /** Bodies of every `POST /screener/scan`, in order. */
  scanRequests: Json[];
  /** Bodies of every `POST /screener/runs`. */
  runRequests: Json[];
  /** Saved screens by id. */
  screens: Map<string, Json>;
  /** `METHOD /path` of every screens request. */
  screenRequests: string[];
  /** Number of `GET /screener/status` requests. */
  statusRequests: number;
}

/** The class universes of `GET /api/screener/universe`, in the API's `Universe` JSON shape. */
export const SCREENER_UNIVERSE: Record<string, Json> = JSON.parse(
  readFileSync(new URL('./fixtures/screener-universe.json', import.meta.url), 'utf8'),
) as Record<string, Json>;

const field = (id: string, over: Json = {}): Json => ({
  id,
  category: 'technical',
  type: 'number',
  unit: null,
  dimension: id,
  ops: ['>', '<', '>=', '<=', 'between'],
  crossable: false,
  available: true,
  enumValues: null,
  ...over,
});

/** A small field catalog in the shape of the frozen `/screener/fields` contract. */
export const SCREENER_FIELDS: Json[] = [
  field('last', {
    category: 'price',
    type: 'number',
    dimension: 'price',
    ops: ['>', '<', '>=', '<=', 'between', 'crossesAbove', 'crossesBelow', 'abovePct', 'belowPct'],
    crossable: true,
  }),
  field('sma200', {
    category: 'price',
    dimension: 'price',
    ops: ['>', '<', 'crossesAbove', 'crossesBelow'],
    crossable: true,
  }),
  field('chg1d', { category: 'price', type: 'percent', unit: '%', dimension: 'percent' }),
  field('perf1m', { category: 'performance', type: 'percent', unit: '%', dimension: 'percent' }),
  field('rsi14', {
    dimension: 'oscillator',
    ops: ['>', '<', '>=', '<=', 'between', 'crossesAbove', 'crossesBelow'],
    crossable: true,
  }),
  field('relVol', { category: 'volume' }),
  field('volume', { category: 'volume', type: 'int', dimension: 'volume' }),
  field('mcap', { category: 'fundamental', type: 'money', unit: 'USD', dimension: 'money' }),
  field('pe', { category: 'fundamental', available: false }),
  field('newHi52', { type: 'bool', ops: ['='] }),
  field('smaCross', { type: 'enum', ops: ['=', 'in'], enumValues: ['golden', 'death'] }),
  field('sector', {
    category: 'fundamental',
    type: 'enum',
    ops: ['=', 'in'],
    enumValues: ['Technology', 'Energy', 'Utilities'],
  }),
];

const srow = (symbol: string, name: string, values: Json): Json => ({
  symbol,
  name,
  cls: 'stocks',
  group: 'Technology',
  exchange: 'NASDAQ',
  stale: false,
  values,
});

/** Snapshot rows of the default scan fixture. */
export const SCREENER_ROWS: Json[] = [
  srow('NVDA', 'NVIDIA', {
    last: 100,
    chg1d: 1,
    volume: 2_000_000,
    rsi14: 28,
    mcap: 3e12,
    perf1m: 4.5,
    relVol: 1.2,
    sector: 'Technology',
  }),
  srow('MSFT', 'Microsoft', {
    last: 400,
    chg1d: -0.5,
    volume: 1_500_000,
    rsi14: 25,
    mcap: 2.9e12,
    perf1m: -2,
    relVol: 0.9,
    sector: 'Technology',
  }),
  srow('AAPL', 'Apple', {
    last: 200,
    chg1d: 0.2,
    volume: 3_000_000,
    rsi14: 55,
    mcap: 3.1e12,
    perf1m: 1.1,
    relVol: 1,
    sector: 'Technology',
  }),
  srow('TSLA', 'Tesla', {
    last: 250,
    chg1d: 3,
    volume: 5_000_000,
    rsi14: 71,
    mcap: 8e11,
    perf1m: 12,
    relVol: 2.4,
    sector: 'Technology',
  }),
];

const SCREENER_PRESETS: Json[] = [
  {
    id: 'oversold-large-caps',
    name: 'Oversold large caps',
    spec: {
      schemaVersion: 1,
      universe: { kind: 'class', cls: 'stocks' },
      filter: {
        op: 'and',
        rules: [
          { field: 'rsi14', op: '<', value: 30 },
          { field: 'mcap', op: '>', value: 1e10 },
        ],
      },
      sort: { field: 'rsi14', dir: 'asc' },
    },
  },
];

const SCREENER_LISTS: Json[] = [
  { id: 'sp500', name: 'S&P 500', kind: 'index', asOf: '2026-01', source: 'bundled', count: 500 },
  {
    id: 'ndx100',
    name: 'Nasdaq-100',
    kind: 'index',
    asOf: '2026-01',
    source: 'bundled',
    count: 100,
  },
];

/** A `/screener/status` body for a preset. */
export function screenerStatus(mode: ScreenerPreset): Json {
  const base = {
    enabled: true,
    supported: true,
    reason: null as string | null,
    provider: 'yahoo',
    asOf: '2026-11-05' as string | null,
    computedAt: new Date(Date.now() - 3 * 3600_000).toISOString() as string | null,
    fundamentalsAsOf: '2026-11-05',
    coverage: { tracked: 4, fresh: 4, stale: 0, failed: 0, tombstoned: 0 },
    running: null as Json | null,
    nextRunAt: null,
    budget: { ratePerMin: 24, tokensLastRun: 4 },
    barsRows: 1000,
  };
  if (mode === 'off')
    return {
      ...base,
      enabled: false,
      supported: false,
      reason: 'disabled',
      asOf: null,
      computedAt: null,
      fundamentalsAsOf: null,
    };
  if (mode === 'first_run')
    return {
      ...base,
      reason: 'first_run',
      asOf: null,
      computedAt: null,
      fundamentalsAsOf: null,
      coverage: { tracked: 4, fresh: 0, stale: 0, failed: 0, tombstoned: 0 },
      running: {
        runId: 1,
        kind: 'snapshot',
        done: 2,
        total: 4,
        startedAt: new Date().toISOString(),
        etaS: 120,
      },
    };
  return base;
}

export function newScreenerMock(opts: ScreenerMockOptions = {}): ScreenerMock {
  const mock: ScreenerMock = {
    options: opts,
    status: screenerStatus(opts.mode ?? 'off'),
    setStatus: (patch) => {
      mock.status = { ...mock.status, ...patch };
    },
    scanRequests: [],
    runRequests: [],
    screens: new Map(),
    screenRequests: [],
    statusRequests: 0,
  };
  return mock;
}

type Rule = { field: string; op: string; value: unknown };
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);

/** Tiny evaluator for the scan fixture: numeric comparisons and AND/OR groups. */
function matches(row: Json, node: Json): boolean {
  if (Array.isArray(node.rules)) {
    const results = (node.rules as Json[]).map((n) => matches(row, n));
    return node.op === 'or' ? results.some(Boolean) : results.every(Boolean);
  }
  const r = node as unknown as Rule;
  const v = (row.values as Json)[r.field];
  if (r.op === '=') return v === r.value;
  if (r.op === 'between' && Array.isArray(r.value))
    return (
      num(v) !== null && num(v)! >= (r.value[0] as number) && num(v)! <= (r.value[1] as number)
    );
  const a = num(v);
  const b = num(r.value);
  if (a === null || b === null) return false;
  switch (r.op) {
    case '>':
      return a > b;
    case '<':
      return a < b;
    case '>=':
      return a >= b;
    case '<=':
      return a <= b;
    default:
      return true;
  }
}

async function routeScreener(page: Page, mock: ScreenerMock): Promise<void> {
  const base = (id: string) => `/api/screener/${id}`;
  await page.route(
    (url) => url.pathname.startsWith('/api/screener/') && url.pathname !== '/api/screener/snapshot',
    async (route: Route) => {
      const req = route.request();
      const url = new URL(req.url());
      const method = req.method();
      const path = url.pathname;
      let body: Json = {};
      try {
        body = req.postData() ? (JSON.parse(req.postData()!) as Json) : {};
      } catch {
        body = {};
      }
      if (path === base('status')) {
        mock.statusRequests++;
        return route.fulfill({ json: mock.status });
      }
      if (path === base('fields'))
        return route.fulfill({ json: { version: 1, fields: SCREENER_FIELDS } });
      if (path === base('presets')) return route.fulfill({ json: SCREENER_PRESETS });
      if (path === base('lists')) return route.fulfill({ json: SCREENER_LISTS });
      if (path === base('universe')) {
        if (mock.options.universeStatus)
          return route.fulfill({
            status: mock.options.universeStatus,
            json: { detail: 'e2e: universe unavailable' },
          });
        const cls = url.searchParams.get('cls') ?? '';
        const u = mock.options.universe?.[cls] ?? SCREENER_UNIVERSE[cls];
        return u
          ? route.fulfill({ json: u })
          : route.fulfill({ status: 422, json: { detail: 'e2e: unknown class' } });
      }
      if (path === base('runs') && method === 'POST') {
        mock.runRequests.push(body);
        if (mock.status.running)
          return route.fulfill({ status: 409, json: { detail: 'a run is already in progress' } });
        return route.fulfill({ status: 202, json: { runId: 2 } });
      }
      if (path === base('scan') && method === 'POST') {
        mock.scanRequests.push(body);
        const fail = mock.options.scanStatus;
        if (fail)
          return route.fulfill({
            status: fail,
            json: { detail: { code: 'bad_value', message: 'e2e scan failure', path: 'rules[0]' } },
          });
        let rows = mock.options.rows ?? SCREENER_ROWS;
        if (body.filter) rows = rows.filter((r) => matches(r, body.filter as Json));
        const sort = body.sort as { field: string; dir: string } | undefined;
        if (sort) {
          const k = (r: Json) => num((r.values as Json)[sort.field]);
          rows = [...rows].sort((x, y) => {
            const a = k(x);
            const b = k(y);
            if (a === null) return b === null ? 0 : 1;
            if (b === null) return -1;
            return sort.dir === 'asc' ? a - b : b - a;
          });
        }
        const offset = (body.offset as number) ?? 0;
        const limit = (body.limit as number) ?? 100;
        return route.fulfill({
          json: {
            asOf: '2026-11-05',
            computedAt: new Date().toISOString(),
            provider: 'yahoo',
            total: rows.length,
            offset,
            limit,
            coverage: { universe: 4, withSnapshot: 4 },
            rows: rows.slice(offset, offset + limit),
          },
        });
      }
      if (path === base('screens') || path.startsWith(base('screens') + '/')) {
        mock.screenRequests.push(`${method} ${path.slice('/api'.length)}`);
        const id = decodeURIComponent(path.slice(base('screens').length + 1));
        const now = new Date().toISOString();
        if (!id) {
          if (method === 'GET') return route.fulfill({ json: [...mock.screens.values()] });
          if (method === 'POST') {
            const sid = String(body.id);
            if (mock.screens.has(sid))
              return route.fulfill({
                status: 409,
                json: { detail: { message: 'exists', current: mock.screens.get(sid) } },
              });
            const screen = {
              id: sid,
              name: body.name,
              spec: body.spec,
              alert: body.alert ?? null,
              revision: 1,
              createdAt: now,
              updatedAt: now,
            };
            mock.screens.set(sid, screen);
            return route.fulfill({ status: 201, json: screen });
          }
        } else {
          const cur = mock.screens.get(id);
          if (!cur) return route.fulfill({ status: 404, json: { detail: 'not found' } });
          if (method === 'GET') return route.fulfill({ json: cur });
          if (method === 'DELETE') {
            mock.screens.delete(id);
            return route.fulfill({ status: 204 });
          }
          if (method === 'PUT' || method === 'PATCH') {
            if (body.revision !== undefined && body.revision !== cur.revision)
              return route.fulfill({
                status: 409,
                json: { detail: { message: 'conflict', current: cur } },
              });
            const next = {
              ...cur,
              ...body,
              id,
              revision: (cur.revision as number) + 1,
              updatedAt: now,
            };
            mock.screens.set(id, next);
            return route.fulfill({ json: next });
          }
        }
      }
      return route.fulfill({ status: 501, json: { detail: `e2e: unexpected ${method} ${path}` } });
    },
  );
}

// ---------------------------------------------------------------------------
// GET /api/screener/hotlists (Hotlists sidebar panel; docs/screener.md)

export interface HotlistsMockOptions {
  /** Rows per kind; kinds without an entry answer an empty ranking. */
  rows?: Partial<Record<string, Json[]>>;
  /** `asOf` of every answer; null = no snapshot yet. Default `2026-11-05`. */
  asOf?: string | null;
}

export interface HotlistsMock {
  /** Query of every `GET /screener/hotlists`, in order. */
  requests: { kind: string; universe: string; limit: string }[];
}

/** A hotlist row. */
export const hotlistRow = (
  symbol: string,
  value: number | null,
  last: number | null,
  chg1d: number | null,
): Json => ({ symbol, name: `${symbol} Inc`, value, last, chg1d });

/**
 * Answers `/api/screener/hotlists`. Call after `mockMarket` (the later route wins over its
 * `/api/screener/*` catch-all), before `page.goto`.
 */
export async function mockHotlists(
  page: Page,
  opts: HotlistsMockOptions = {},
): Promise<HotlistsMock> {
  const mock: HotlistsMock = { requests: [] };
  await page.route(
    (url) => url.pathname === '/api/screener/hotlists',
    (route: Route) => {
      const q = new URL(route.request().url()).searchParams;
      const kind = q.get('kind') ?? '';
      const universe = q.get('universe') ?? '';
      mock.requests.push({ kind, universe, limit: q.get('limit') ?? '' });
      const asOf = opts.asOf === undefined ? '2026-11-05' : opts.asOf;
      return route.fulfill({
        json: { kind, asOf, universe, rows: asOf === null ? [] : (opts.rows?.[kind] ?? []) },
      });
    },
  );
  return mock;
}
