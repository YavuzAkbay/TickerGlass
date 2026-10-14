/**
 * Opt-in mock of the live market data a watchlist shows: `/api/quotes`,
 * `/api/quotes/extended`, `/api/performance/{symbol}` and the `/ws` quote
 * stream. Not part of the auto fixture in ./fixtures.ts: only specs that
 * assert on prices call `mockMarket(page)`, before `page.goto`.
 *
 * The socket is fully mocked (no backend behind it). It answers `subscribe`
 * like the real hub (`{type:'subscribed'}`, then status "connected"), and
 * the test pushes frames with `pushTick` or drops the connection with
 * `close()`. After `close()` new connections are refused (so the client
 * stays in its polling fallback) until `reopen()`.
 */
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

const PERIODS = ['1W', '1M', '3M', '6M', 'YTD', '1Y', '5Y'] as const;

export interface MarketOptions {
  /** Answers of `/api/quotes` by symbol; unknown symbols get a flat 100 / 99 quote. */
  quotes?: Record<string, MockQuote>;
  /** Answers of `/api/quotes/extended` by symbol; unknown symbols are left out. */
  extended?: Record<string, Json>;
  /** Answers of `/api/performance/{symbol}`; unknown symbols get +1 % for every period. */
  performance?: Record<string, Json>;
}

export interface MockMarket {
  /** Every `/api/quotes` request, as the decoded `symbols` query. */
  quoteRequests: string[];
  extendedRequests: string[];
  /** Symbols of every `subscribe` frame received (all sockets, in order). */
  subscribed: string[];
  /** Currently open sockets. */
  readonly sockets: number;
  /** Send a frame to every open socket. */
  push(frame: Json): void;
  /** Send a `tick` frame; `extra` overrides fields (e.g. `{marketHours: 2}`). */
  pushTick(symbol: string, price: number, extra?: Json): void;
  /** Close every socket and refuse new ones until `reopen()`. */
  close(): void;
  reopen(): void;
}

export async function mockMarket(page: Page, opts: MarketOptions = {}): Promise<MockMarket> {
  const sockets = new Set<WebSocketRoute>();
  let refuse = false;
  const m: MockMarket = {
    quoteRequests: [],
    extendedRequests: [],
    subscribed: [],
    get sockets() {
      return sockets.size;
    },
    push: (frame) => {
      for (const ws of sockets) ws.send(JSON.stringify(frame));
    },
    pushTick: (symbol, price, extra) => m.push(tick(symbol, price, extra)),
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

  await page.routeWebSocket('**/ws', (ws) => {
    if (refuse) {
      void ws.close();
      return;
    }
    sockets.add(ws);
    ws.onClose(() => sockets.delete(ws));
    ws.onMessage((raw) => {
      let msg: { op?: string; symbols?: string[] };
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.op === 'subscribe') {
        m.subscribed.push(...(msg.symbols ?? []));
        ws.send(JSON.stringify({ type: 'subscribed', symbols: msg.symbols ?? [] }));
        ws.send(JSON.stringify({ type: 'status', upstream: 'connected' }));
      }
    });
    ws.send(JSON.stringify({ type: 'status', upstream: 'connected' }));
  });
  return m;
}
