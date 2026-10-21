/** Pure watchlist helpers: rows, sorting, active list and `.txt` import/export. */
import type { LiveQuote } from '../quotes/types';
import {
  FLAG_COLORS,
  type FlagColor,
  type ListRef,
  type Row,
  type SortKey,
  type SortSpec,
  type WatchlistEntry,
  type WatchlistItem,
} from './types';

export const MAX_WATCHLIST_ITEMS = 1000;
export const MAX_SECTION_TITLE = 100;
export const SYMBOL_RE = /^[A-Z0-9.\-=^/&_]{1,32}$/;

type Quotes = Record<string, LiveQuote | undefined>;

// ------------------------------------------------------------ rows

function sortValue(sym: string, q: LiveQuote | undefined, key: SortKey): number | string | null {
  switch (key) {
    case 'symbol':
      return sym;
    case 'last':
      return q?.last ?? null;
    case 'change':
      return q?.change ?? null;
    case 'changePercent':
      return q?.changePercent ?? null;
    case 'volume':
      return q?.volume ?? null;
    case 'extPrice':
      return q?.ext?.price ?? null;
    case 'extChangePercent':
      return q?.ext?.changePercent ?? null;
  }
}

function compare(a: number | string | null, b: number | string | null, dir: 'asc' | 'desc') {
  if (a === null && b === null) return 0;
  if (a === null) return 1; // nulls last in both directions
  if (b === null) return -1;
  const c =
    typeof a === 'string' || typeof b === 'string'
      ? String(a).localeCompare(String(b))
      : a - (b as number);
  return dir === 'asc' ? c : -c;
}

/**
 * Display rows. Sorting happens within each section (sections keep their
 * order); collapsed sections hide their symbols unless `collapsedAware` is false.
 */
export function buildRows(
  items: WatchlistItem[],
  sort: SortSpec | null,
  quotes: Quotes,
  collapsedAware = true,
): Row[] {
  type Sym = Extract<Row, { kind: 'symbol' }>;
  const rows: Row[] = [];
  let group: Sym[] = [];
  let header: Extract<Row, { kind: 'section' }> | null = null;
  const flush = () => {
    if (sort)
      group = group
        .map((r, i) => ({ r, i, v: sortValue(r.symbol, quotes[r.symbol], sort.key) }))
        .sort((x, y) => compare(x.v, y.v, sort.dir) || x.i - y.i)
        .map((x) => x.r);
    if (header) header.count = group.length;
    if (!(header?.collapsed && collapsedAware)) rows.push(...group);
    group = [];
  };
  items.forEach((it, index) => {
    if (it.type === 'section') {
      flush();
      header = {
        kind: 'section',
        id: it.id,
        title: it.title,
        collapsed: !!it.collapsed,
        count: 0,
        index,
      };
      rows.push(header);
    } else group.push({ kind: 'symbol', symbol: it.symbol, sectionId: header?.id ?? null, index });
  });
  flush();
  return rows;
}

/** Symbols flagged `color`, oldest flag first. */
export function flagRows(
  flags: Record<string, { color: FlagColor; at: string }>,
  color: FlagColor,
): Row[] {
  return Object.entries(flags)
    .filter(([, f]) => f.color === color)
    .sort(([sa, a], [sb, b]) => (a.at < b.at ? -1 : a.at > b.at ? 1 : sa.localeCompare(sb)))
    .map(([symbol]) => ({ kind: 'symbol', symbol, sectionId: null, index: -1 }));
}

export const isFlagRef = (ref: string): boolean =>
  ref.startsWith('flag:') && (FLAG_COLORS as readonly string[]).includes(ref.slice(5));

/** Lists alphabetically (case-insensitive). */
export function sortedLists(lists: Record<string, WatchlistEntry>): WatchlistEntry[] {
  return Object.values(lists).sort(
    (a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || (a.id < b.id ? -1 : 1),
  );
}

/** The list to show: the stored choice if it still exists, else the alphabetically first. */
export function resolveActive(
  activeId: ListRef | null,
  lists: Record<string, WatchlistEntry>,
): ListRef | null {
  if (activeId && (lists[activeId] || isFlagRef(activeId))) return activeId;
  return sortedLists(lists)[0]?.id ?? null;
}

// ------------------------------------------------------------ .txt

const US = new Set(['NASDAQ', 'NYSE', 'AMEX', 'NYSEARCA', 'ARCA', 'BATS', 'CBOE', 'OTC']);
const SUFFIX: Record<string, string> = {
  LSE: '.L',
  XETR: '.DE',
  FWB: '.F',
  TSX: '.TO',
  TSXV: '.V',
  ASX: '.AX',
  HKEX: '.HK',
  TSE: '.T',
  NSE: '.NS',
  BSE: '.BO',
  BIST: '.IS',
  SIX: '.SW',
  BME: '.MC',
  MIL: '.MI',
  OMXSTO: '.ST',
  KRX: '.KS',
  TWSE: '.TW',
  SSE: '.SS',
  SZSE: '.SZ',
  BMFBOVESPA: '.SA',
};
const FX = new Set(['FX', 'FX_IDC', 'OANDA', 'FOREXCOM', 'PEPPERSTONE', 'FXCM', 'SAXO']);
const CRYPTO = new Set(['BINANCE', 'COINBASE', 'KRAKEN', 'BITSTAMP', 'BYBIT', 'BITFINEX', 'OKX']);
const SPECIAL: Record<string, string> = {
  'SP:SPX': '^GSPC',
  'NASDAQ:NDX': '^NDX',
  'NASDAQ:IXIC': '^IXIC',
  'DJ:DJI': '^DJI',
  'TVC:VIX': '^VIX',
  'CBOE:VIX': '^VIX',
  'TVC:DXY': 'DX-Y.NYB',
};

/** `mapped` is false when the exchange prefix is unknown/ambiguous (the ticker is kept). */
function mapSymbol(raw: string): { symbol: string; mapped: boolean } {
  const up = raw.trim().toUpperCase();
  const special = SPECIAL[up];
  if (special) return { symbol: special, mapped: true };
  const i = up.indexOf(':');
  if (i < 0) return { symbol: up, mapped: true };
  const ex = up.slice(0, i);
  const ticker = up.slice(i + 1);
  const fut = /^(.+?)[12]!$/.exec(ticker);
  if (fut) return { symbol: `${fut[1]}=F`, mapped: true };
  if (US.has(ex)) return { symbol: ticker, mapped: true };
  if (ex === 'HKEX') {
    const digits = /^\d+$/.test(ticker) ? ticker.replace(/^0+/, '').padStart(4, '0') : ticker;
    return { symbol: `${digits}.HK`, mapped: true };
  }
  const suffix = SUFFIX[ex];
  if (suffix) return { symbol: `${ticker}${suffix}`, mapped: true };
  if (FX.has(ex))
    return /^[A-Z]{6}$/.test(ticker)
      ? { symbol: `${ticker}=X`, mapped: true }
      : { symbol: ticker, mapped: false };
  if (CRYPTO.has(ex)) {
    const m = /^(.+?)(USDT|USDC|USD|EUR)$/.exec(ticker);
    if (m) return { symbol: `${m[1]}-${m[2] === 'EUR' ? 'EUR' : 'USD'}`, mapped: true };
    return { symbol: ticker, mapped: false };
  }
  return { symbol: ticker, mapped: false }; // EURONEXT and unknown exchanges
}

/** Yahoo symbol for a `EXCHANGE:TICKER` (or plain) symbol; null if unusable. */
export function toYahooSymbol(raw: string): string | null {
  const { symbol } = mapSymbol(raw);
  return SYMBOL_RE.test(symbol) ? symbol : null;
}

/**
 * Parse the TickerGlass plain-text watchlist format: one `EXCHANGE:TICKER` per
 * entry, comma or newline separated, optional `###Section` headers. Entries
 * are mapped to Yahoo symbols. `unmapped`
 * lists entries whose prefix could not be mapped (ticker kept); `skipped`
 * counts entries that are not valid symbols.
 */
export function parseTxt(text: string): {
  items: WatchlistItem[];
  unmapped: string[];
  skipped: number;
} {
  const items: WatchlistItem[] = [];
  const unmapped: string[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const part of text.split(/[,\r\n]+/)) {
    if (items.length >= MAX_WATCHLIST_ITEMS) break;
    const entry = part.trim();
    if (!entry) continue;
    if (entry.startsWith('###')) {
      const title = entry.slice(3).trim().slice(0, MAX_SECTION_TITLE).trim() || 'Section';
      items.push({ type: 'section', id: crypto.randomUUID(), title, collapsed: false });
      continue;
    }
    const { symbol, mapped } = mapSymbol(entry);
    if (!SYMBOL_RE.test(symbol)) {
      skipped++;
      continue;
    }
    if (!mapped && !unmapped.includes(entry.toUpperCase())) unmapped.push(entry.toUpperCase());
    if (seen.has(symbol)) continue;
    seen.add(symbol);
    items.push({ type: 'symbol', symbol });
  }
  return { items, unmapped, skipped };
}

/** TickerGlass plain-text watchlist format: one line, comma separated, sections as `###Title`; no trailing newline. */
export const formatTxt = (items: WatchlistItem[]): string =>
  items.map((i) => (i.type === 'section' ? `###${i.title}` : i.symbol)).join(',');

/** File name for an export (`/\:*?"<>|` replaced). */
export const txtFileName = (name: string): string =>
  `${name.replace(/[/\\:*?"<>|]/g, '_').trim() || 'watchlist'}.txt`;

/** Why `symbol` cannot be added to `items`, or null if it can. */
export function addBlocker(
  items: readonly WatchlistItem[],
  symbol: string,
): 'duplicate' | 'full' | null {
  if (items.some((i) => i.type === 'symbol' && i.symbol === symbol)) return 'duplicate';
  return items.length >= MAX_WATCHLIST_ITEMS ? 'full' : null;
}
