/** Pure watchlist helpers: rows, sorting, active list and `.txt` import/export. */
import type { LiveQuote } from '../quotes/types';
import type { SnapshotRow } from '../screener/server/snapshot';
import { COLUMN_DEFS } from './columns/registry';
import { useWatchlistPrefs } from './prefs';
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
/** Server-screener snapshot rows by symbol (the snapshot columns' sort values). */
export type Snaps = Record<string, SnapshotRow | undefined>;

/** Resolved display metadata for a symbol (see watchlist/page/symbolMeta.ts). */
export interface SymbolMeta {
  name: string;
  exchange: string | null;
  type: string | null;
}

// ------------------------------------------------------------ rows

function sortValue(
  sym: string,
  q: LiveQuote | undefined,
  key: SortKey,
  meta: Record<string, SymbolMeta | undefined> | undefined,
  snaps: Snaps | undefined,
): number | string | null {
  // One accessor per column, defined in the registry (null = no value, sorted last).
  return key === 'symbol' ? sym : COLUMN_DEFS[key].accessor(q, meta?.[sym], snaps?.[sym]);
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

/** Section id -> collapsed (the local-only state, `useWatchlistPrefs.collapsed`). */
export type CollapsedMap = Readonly<Record<string, boolean | undefined>>;

/** Collapsed state of a section: the local pref, else the legacy flag stored in the item. */
export const sectionCollapsed = (
  map: CollapsedMap | undefined,
  item: Extract<WatchlistItem, { type: 'section' }>,
): boolean => map?.[item.id] ?? !!item.collapsed;

/**
 * Display rows. Sorting happens within each section (sections keep their
 * order); collapsed sections hide their symbols unless `collapsedAware` is false.
 * `meta` supplies company names for the optional page-only `name` sort.
 * `collapsed` is the local collapse state (default: the current prefs; pass the
 * subscribed `useWatchlistPrefs((s) => s.collapsed)` to rebuild when it changes).
 * `snaps` supplies the values of the snapshot columns (rows without one sort last).
 */
export function buildRows(
  items: WatchlistItem[],
  sort: SortSpec | null,
  quotes: Quotes,
  collapsedAware = true,
  meta?: Record<string, SymbolMeta | undefined>,
  collapsed: CollapsedMap = useWatchlistPrefs.getState().collapsed,
  snaps?: Snaps,
): Row[] {
  type Sym = Extract<Row, { kind: 'symbol' }>;
  const rows: Row[] = [];
  let group: Sym[] = [];
  let header: Extract<Row, { kind: 'section' }> | null = null;
  const flush = () => {
    if (sort)
      group = group
        .map((r, i) => ({ r, i, v: sortValue(r.symbol, quotes[r.symbol], sort.key, meta, snaps) }))
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
        collapsed: sectionCollapsed(collapsed, it),
        count: 0,
        index,
      };
      rows.push(header);
    } else group.push({ kind: 'symbol', symbol: it.symbol, sectionId: header?.id ?? null, index });
  });
  flush();
  return rows;
}

/**
 * Symbols in the order the table shows them: per-section sort applied, symbols
 * of collapsed sections left out. `next`/`prev` commands follow this order.
 */
export function displayOrder(
  items: WatchlistItem[],
  sort: SortSpec | null,
  quotes: Quotes,
  collapsed?: CollapsedMap,
  meta?: Record<string, SymbolMeta | undefined>,
  snaps?: Snaps,
): string[] {
  return buildRows(items, sort, quotes, true, meta, collapsed ?? {}, snaps).flatMap((r) =>
    r.kind === 'symbol' ? [r.symbol] : [],
  );
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

/** Exchanges whose tickers are Yahoo's as they are (class shares `BRK.B` become `BRK-B`). */
const US = new Set(['NASDAQ', 'NYSE', 'AMEX', 'NYSEARCA', 'ARCA', 'BATS', 'CBOE', 'OTC']);
/** Exchange -> Yahoo suffix. A bare `EURONEXT` is deliberately absent: the prefix does not say which market. */
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
  OSL: '.OL',
  OMXCOP: '.CO',
  OMXHEX: '.HE',
  KRX: '.KS',
  KOSDAQ: '.KQ',
  TWSE: '.TW',
  TPEX: '.TWO',
  SGX: '.SI',
  SSE: '.SS',
  SZSE: '.SZ',
  BMFBOVESPA: '.SA',
  BMV: '.MX',
  // Euronext by market: a bare `EURONEXT:` prefix does not say which one (Paris, Amsterdam, ...).
  EURONEXT_PAR: '.PA',
  EURONEXT_PARIS: '.PA',
  EPA: '.PA',
  EURONEXT_AMS: '.AS',
  EURONEXT_AMSTERDAM: '.AS',
  AMS: '.AS',
  EURONEXT_BRU: '.BR',
  EURONEXT_BRUSSELS: '.BR',
  EBR: '.BR',
  EURONEXT_LIS: '.LS',
  EURONEXT_LISBON: '.LS',
  ELI: '.LS',
  EURONEXT_DUB: '.IR',
  EURONEXT_DUBLIN: '.IR',
};
/** Exchanges with `.B`-style class shares: Yahoo writes them `RCI-B.TO`. */
const CLASS_SHARE_SUFFIX = new Set(['TSX', 'TSXV']);
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

/** `symbol` is '' when the exchange prefix is unknown or ambiguous: the bare ticker is never guessed. */
function mapSymbol(raw: string): { symbol: string; mapped: boolean } {
  const unmapped = { symbol: '', mapped: false };
  const up = raw.trim().toUpperCase();
  const special = SPECIAL[up];
  if (special) return { symbol: special, mapped: true };
  const i = up.indexOf(':');
  if (i < 0) return { symbol: up, mapped: true };
  const ex = up.slice(0, i);
  const ticker = up.slice(i + 1);
  if (!ticker) return unmapped;
  const fut = /^(.+?)[12]!$/.exec(ticker);
  if (fut) return { symbol: `${fut[1]}=F`, mapped: true };
  if (US.has(ex)) {
    const cls = /^([A-Z]{1,5})[./]([A-Z])$/.exec(ticker);
    return { symbol: cls ? `${cls[1]}-${cls[2]}` : ticker, mapped: true };
  }
  if (ex === 'HKEX') {
    const digits = /^\d+$/.test(ticker) ? ticker.replace(/^0+/, '').padStart(4, '0') : ticker;
    return { symbol: `${digits}.HK`, mapped: true };
  }
  const suffix = SUFFIX[ex];
  if (suffix) {
    let base = ticker.replace(/\.+$/, ''); // LSE:BP. -> BP
    const cls = /^(.+)\.([A-Z])$/.exec(base);
    if (cls && CLASS_SHARE_SUFFIX.has(ex)) base = `${cls[1]}-${cls[2]}`;
    return base ? { symbol: `${base}${suffix}`, mapped: true } : unmapped;
  }
  if (FX.has(ex))
    return /^[A-Z]{6}$/.test(ticker) ? { symbol: `${ticker}=X`, mapped: true } : unmapped;
  if (CRYPTO.has(ex)) {
    const m = /^(.+?)(USDT|USDC|USD|EUR)$/.exec(ticker);
    return m ? { symbol: `${m[1]}-${m[2] === 'EUR' ? 'EUR' : 'USD'}`, mapped: true } : unmapped;
  }
  return unmapped; // plain EURONEXT (which market?) and unknown exchanges
}

/** Yahoo symbol for a `EXCHANGE:TICKER` (or plain) symbol; null if unmapped or unusable. */
export function toYahooSymbol(raw: string): string | null {
  const { symbol } = mapSymbol(raw);
  return SYMBOL_RE.test(symbol) ? symbol : null;
}

export interface ParsedTxt {
  items: WatchlistItem[];
  /** Entries whose exchange prefix could not be mapped; they are NOT imported. */
  unmapped: string[];
  /** Entries that are not valid symbols. */
  skipped: number;
  /** Entries that repeat an earlier symbol. */
  duplicates: number;
  /** Entries left out because the list reached `MAX_WATCHLIST_ITEMS`. */
  truncated: number;
}

/**
 * Parse the TickerGlass plain-text watchlist format: one `EXCHANGE:TICKER` per
 * entry, comma or newline separated, optional `###Section` headers. Entries
 * are mapped to Yahoo symbols; entries with an unknown exchange prefix are
 * reported in `unmapped` and left out. With `loose` (pasted text) whitespace
 * and `;` separate entries too (sections still run to the end of the line).
 */
export function parseTxt(text: string, opts: { loose?: boolean } = {}): ParsedTxt {
  const items: WatchlistItem[] = [];
  const unmapped: string[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  let duplicates = 0;
  let truncated = 0;
  const entries: string[] = [];
  for (const part of text.split(/[,\r\n]+/)) {
    const entry = part.trim();
    if (!entry) continue;
    if (opts.loose && !entry.startsWith('###'))
      entries.push(...entry.split(/[\s;]+/).filter(Boolean));
    else entries.push(entry);
  }
  for (const entry of entries) {
    if (items.length >= MAX_WATCHLIST_ITEMS) {
      truncated++;
      continue;
    }
    if (entry.startsWith('###')) {
      const title = entry.slice(3).trim().slice(0, MAX_SECTION_TITLE).trim() || 'Section';
      items.push({ type: 'section', id: crypto.randomUUID(), title, collapsed: false });
      continue;
    }
    const { symbol, mapped } = mapSymbol(entry);
    if (!mapped) {
      if (!unmapped.includes(entry.toUpperCase())) unmapped.push(entry.toUpperCase());
      continue;
    }
    if (!SYMBOL_RE.test(symbol)) {
      skipped++;
      continue;
    }
    if (seen.has(symbol)) {
      duplicates++;
      continue;
    }
    seen.add(symbol);
    items.push({ type: 'symbol', symbol });
  }
  return { items, unmapped, skipped, duplicates, truncated };
}

/** Toast text for an import: what was added, then what was not (unmapped listed up to 5). */
export function describeImport(r: ParsedTxt, count: number, target = ''): string {
  const parts = [
    `Imported ${count} symbol${count === 1 ? '' : 's'}${target ? ` to ${target}` : ''}`,
  ];
  if (r.unmapped.length) {
    const shown = r.unmapped.slice(0, 5).join(', ');
    const more = r.unmapped.length > 5 ? ` +${r.unmapped.length - 5} more` : '';
    parts.push(`${r.unmapped.length} not imported (unknown exchange): ${shown}${more}`);
  }
  if (r.skipped) parts.push(`${r.skipped} invalid`);
  if (r.duplicates) parts.push(`${r.duplicates} duplicate${r.duplicates === 1 ? '' : 's'} skipped`);
  if (r.truncated) parts.push(`${r.truncated} left out (lists hold ${MAX_WATCHLIST_ITEMS} items)`);
  return parts.join('; ');
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

// ------------------------------------------------------------ TradingView export

/** Yahoo index / special symbols -> TradingView (the reverse of `SPECIAL`). */
const TV_SPECIAL: Record<string, string> = {
  '^GSPC': 'SP:SPX',
  '^NDX': 'NASDAQ:NDX',
  '^IXIC': 'NASDAQ:IXIC',
  '^DJI': 'DJ:DJI',
  '^VIX': 'TVC:VIX',
  'DX-Y.NYB': 'TVC:DXY',
};
/** Yahoo suffix -> TradingView exchange (the reverse of `SUFFIX`, one prefix per suffix). */
const TV_EXCHANGE: Record<string, string> = {
  '.L': 'LSE',
  '.DE': 'XETR',
  '.F': 'FWB',
  '.TO': 'TSX',
  '.V': 'TSXV',
  '.AX': 'ASX',
  '.HK': 'HKEX',
  '.T': 'TSE',
  '.NS': 'NSE',
  '.BO': 'BSE',
  '.IS': 'BIST',
  '.SW': 'SIX',
  '.MC': 'BME',
  '.MI': 'MIL',
  '.ST': 'OMXSTO',
  '.OL': 'OSL',
  '.CO': 'OMXCOP',
  '.HE': 'OMXHEX',
  '.KS': 'KRX',
  '.KQ': 'KOSDAQ',
  '.TW': 'TWSE',
  '.TWO': 'TPEX',
  '.SI': 'SGX',
  '.SS': 'SSE',
  '.SZ': 'SZSE',
  '.SA': 'BMFBOVESPA',
  '.MX': 'BMV',
};
/** TradingView writes every Euronext market as `EURONEXT:`; TickerGlass cannot read that prefix back. */
const TV_EURONEXT = new Set(['.PA', '.AS', '.BR', '.LS', '.IR']);
/** Yahoo futures root -> TradingView exchange of its continuous contract (`CME_MINI:ES1!`). */
const TV_FUTURES: Record<string, string> = {
  ES: 'CME_MINI',
  NQ: 'CME_MINI',
  RTY: 'CME_MINI',
  YM: 'CBOT_MINI',
  CL: 'NYMEX',
  NG: 'NYMEX',
  HO: 'NYMEX',
  RB: 'NYMEX',
  PL: 'NYMEX',
  PA: 'NYMEX',
  GC: 'COMEX',
  SI: 'COMEX',
  HG: 'COMEX',
  ZC: 'CBOT',
  ZS: 'CBOT',
  ZW: 'CBOT',
  ZB: 'CBOT',
  ZN: 'CBOT',
  ZF: 'CBOT',
  ZT: 'CBOT',
  KC: 'ICEUS',
  SB: 'ICEUS',
  CT: 'ICEUS',
  CC: 'ICEUS',
  LE: 'CME',
  HE: 'CME',
};

/** Listing exchange names (as the screener universe writes them) -> TradingView prefix the importer reads back. */
const TV_US_EXCHANGE: Record<string, string> = {
  NASDAQ: 'NASDAQ',
  NYSE: 'NYSE',
  AMEX: 'AMEX',
  'NYSE AMERICAN': 'AMEX',
  NYSEARCA: 'AMEX',
  ARCA: 'AMEX',
};

export interface TvSymbol {
  /** `EXCHANGE:TICKER`, or the bare ticker where TradingView resolves it by itself. */
  symbol: string;
  /** A guess or a loss: the exchange is unknown, or TickerGlass cannot read the entry back. */
  approximate: boolean;
}

/**
 * TradingView entry for a Yahoo symbol: the reverse of the import mapping. Lossless (re-importing gives the
 * same symbol) for: indices in `TV_SPECIAL`, suffixed listings (`.L`, `.DE`, `.TO` with class shares,
 * `.HK` with its zero padding, ...), `XXXYYY=X` pairs, `XXX-USD`/`-EUR` crypto (written `COINBASE:XXXUSD`)
 * and `XX=F` futures of `TV_FUTURES` (`CME_MINI:ES1!`).
 * US class shares are written `NYSE:BRK.B` (the importer reads a US prefix back as `BRK-B`, a bare `BRK.B`
 * would stay as is, which Yahoo does not know); `exchange` (NASDAQ / NYSE / AMEX, when known) replaces `NYSE`.
 * Lossy: Euronext (`EURONEXT:AIR`, which TickerGlass does not import); `-X`
 * class shares outside Canada (`BT-A.L` -> `LSE:BT.A`, read back as `BT.A.L`); `JPY=X` (-> `FX_IDC:USDJPY`);
 * futures with an unlisted root and indices without a TradingView name (written as they are, `approximate`).
 * A plain US ticker is written bare (TradingView picks its primary listing), or with `exchange` when known.
 */
export function toTradingViewSymbol(yahoo: string, exchange?: string | null): TvSymbol {
  const y = yahoo.trim().toUpperCase();
  const special = TV_SPECIAL[y];
  if (special) return { symbol: special, approximate: false };
  if (y.startsWith('^')) return { symbol: y, approximate: true };

  const fut = /^([A-Z0-9]{1,5})=F$/.exec(y);
  if (fut) {
    const ex = TV_FUTURES[fut[1]!];
    return ex
      ? { symbol: `${ex}:${fut[1]}1!`, approximate: false }
      : { symbol: `${fut[1]}1!`, approximate: true };
  }
  const fx = /^([A-Z]{6})=X$/.exec(y);
  if (fx) return { symbol: `FX_IDC:${fx[1]}`, approximate: false };
  const fxShort = /^([A-Z]{3})=X$/.exec(y); // Yahoo: `JPY=X` is USD/JPY
  if (fxShort) return { symbol: `FX_IDC:USD${fxShort[1]}`, approximate: true };
  const crypto = /^([A-Z0-9]{2,10})-(USD|EUR)$/.exec(y);
  if (crypto) return { symbol: `COINBASE:${crypto[1]}${crypto[2]}`, approximate: false };

  const suf = /^(.+)(\.[A-Z]{1,3})$/.exec(y);
  if (suf) {
    const [, base, ext] = suf as unknown as [string, string, string];
    if (TV_EURONEXT.has(ext)) return { symbol: `EURONEXT:${base}`, approximate: true };
    const ex = TV_EXCHANGE[ext];
    if (ex) {
      if (ex === 'HKEX' && /^\d+$/.test(base))
        return { symbol: `HKEX:${base.replace(/^0+/, '') || '0'}`, approximate: false };
      const cls = /^(.+)-([A-Z])$/.exec(base);
      if (cls)
        return { symbol: `${ex}:${cls[1]}.${cls[2]}`, approximate: !CLASS_SHARE_SUFFIX.has(ex) };
      return { symbol: `${ex}:${base}`, approximate: false };
    }
  }
  const usEx = exchange ? TV_US_EXCHANGE[exchange.trim().toUpperCase()] : undefined;
  const cls = /^([A-Z]{1,5})-([A-Z])$/.exec(y);
  if (cls) return { symbol: `${usEx ?? 'NYSE'}:${cls[1]}.${cls[2]}`, approximate: false };
  return { symbol: usEx && /^[A-Z]{1,5}$/.test(y) ? `${usEx}:${y}` : y, approximate: false };
}

/**
 * TradingView watchlist text: like `formatTxt` (comma separated, `###Section` headers) with every symbol
 * mapped by `toTradingViewSymbol`. `approximate` lists the Yahoo symbols whose entry is a guess or a loss.
 */
export function formatTradingViewTxt(
  items: readonly WatchlistItem[],
  exchangeOf?: (yahoo: string) => string | null | undefined,
): {
  text: string;
  approximate: string[];
} {
  const approximate: string[] = [];
  const text = items
    .map((i) => {
      // A comma in a header would split it.
      if (i.type === 'section') return `###${i.title.replace(/[,\s]+/g, ' ').trim()}`;
      const tv = toTradingViewSymbol(i.symbol, exchangeOf?.(i.symbol));
      if (tv.approximate) approximate.push(i.symbol);
      return tv.symbol;
    })
    .join(',');
  return { text, approximate };
}
