import type {
  Bar,
  BarColumns,
  BarListener,
  DataFeed,
  GetBarsRequest,
  GetBarsResult,
  SubscribeRequest,
  SymbolInfo,
  SymbolSearchResult,
  Unsubscribe,
} from '../types';
import { formatInterval, intervalSeconds } from './intervals';

export interface CoalescingFeedOptions {
  /** How long a finished result is reused (ms). Default 10000. */
  ttlMs?: number;
  /**
   * How long a finished open-ended request (no `to`: the latest bars) is reused (ms).
   * Default 1000. Kept short because subscribe() passes straight through and does not
   * backfill bars that closed between a cached result and the subscription, so a
   * long-lived "latest bars" result could leave a gap in a chart opened later.
   */
  openEndedTtlMs?: number;
  /**
   * How long a finished bounded request (with `to`: older history) is reused (ms).
   * Default: `ttlMs`. History before `to` rarely changes, so this can be long.
   */
  historicalTtlMs?: number;
  /**
   * Keep the latest open-ended result per series (symbol, interval, adjusted, prepost)
   * and, once it is older than `openEndedTtlMs`, refresh it by fetching only the bars
   * since its last bar (plus a few for overlap) instead of the whole page. Default false.
   */
  tailRefresh?: boolean;
  /**
   * With `tailRefresh`: a series whose last full fetch is older than this (ms) is
   * fetched in full again, so revisions of older bars are picked up. Default 30 min.
   */
  seriesMaxAgeMs?: number;
  /** Most distinct requests remembered; least recently used are dropped. Default 64. */
  maxEntries?: number;
  /**
   * Total bars kept across all cached results (each result counted once even when
   * shared); least recently used are dropped beyond it. Default: unbounded.
   */
  maxBars?: number;
  /**
   * Cache `searchSymbols` results (LRU of 100 queries, 10 min). Concurrent identical
   * searches share one request; failures are not kept. Default false.
   */
  searchCache?: boolean;
  /** Clock override for tests. */
  now?: () => number;
}

interface Entry {
  promise: Promise<GetBarsResult>;
  /** Set when the request resolved; in-flight entries never expire. */
  doneAt: number | null;
  ttlMs: number;
  /** The resolved result, for the bar budget. */
  result: GetBarsResult | null;
  /** Recency stamp, comparable across the request and series caches. */
  used: number;
}

/** Latest open-ended bars of one series (`tailRefresh`). */
interface Series {
  /** Not sliced to any request's limit; may hold a few bars more than the last request. */
  result: GetBarsResult;
  /** When the series was last fetched in full (tail merges keep it). */
  fullAt: number;
  /** Order in which the fetch that produced it started; older fetches never overwrite. */
  seq: number;
  used: number;
}

interface SearchEntry {
  promise: Promise<SymbolSearchResult[]>;
  doneAt: number | null;
}

const SEARCH_MAX_ENTRIES = 100;
const SEARCH_TTL_MS = 10 * 60_000;
/** Bars re-fetched before the cached last bar so the tail overlaps it (the last bar may have been forming). */
const TAIL_OVERLAP = 3;

/**
 * Shares identical `getBars` requests between consumers (several charts of a
 * layout opening the same symbol and interval): concurrent calls join one
 * in-flight request, and the last result is reused for a short time. Failed
 * requests are never kept. Everything else passes straight through.
 *
 * With `tailRefresh`, reopening a recently loaded series fetches only its newest
 * bars and merges them into the cached ones.
 *
 * Results are shared by reference, so consumers must treat them as read-only.
 */
export class CoalescingFeed implements DataFeed {
  private readonly ttlMs: number;
  private readonly openEndedTtlMs: number;
  private readonly historicalTtlMs: number;
  private readonly tailRefresh: boolean;
  private readonly seriesMaxAgeMs: number;
  private readonly maxEntries: number;
  private readonly maxBars: number;
  private readonly searchCache: boolean;
  private readonly now: () => number;
  /** Insertion order = recency (re-inserted on use). */
  private readonly entries = new Map<string, Entry>();
  /** Same order rule as `entries`. */
  private readonly series = new Map<string, Series>();
  private readonly searches = new Map<string, SearchEntry>();
  private useSeq = 0;
  private fetchSeq = 0;

  constructor(
    private readonly inner: DataFeed,
    opts: CoalescingFeedOptions = {},
  ) {
    this.ttlMs = opts.ttlMs ?? 10_000;
    this.openEndedTtlMs = Math.min(this.ttlMs, opts.openEndedTtlMs ?? 1000);
    this.historicalTtlMs = opts.historicalTtlMs ?? this.ttlMs;
    this.tailRefresh = opts.tailRefresh ?? false;
    this.seriesMaxAgeMs = opts.seriesMaxAgeMs ?? 30 * 60_000;
    this.maxEntries = opts.maxEntries ?? 64;
    this.maxBars = opts.maxBars ?? Infinity;
    this.searchCache = opts.searchCache ?? false;
    this.now = opts.now ?? (() => Date.now());
  }

  resolveSymbol(symbol: string): Promise<SymbolInfo> {
    return this.inner.resolveSymbol(symbol);
  }

  searchSymbols(query: string, limit?: number): Promise<SymbolSearchResult[]> {
    if (!this.searchCache) return this.inner.searchSymbols(query, limit);
    const key = `${query.trim()}|${limit ?? ''}`;
    const hit = this.searches.get(key);
    this.searches.delete(key);
    if (hit && (hit.doneAt === null || this.now() - hit.doneAt < SEARCH_TTL_MS)) {
      this.searches.set(key, hit);
      return hit.promise;
    }
    const entry: SearchEntry = { promise: this.inner.searchSymbols(query, limit), doneAt: null };
    this.searches.set(key, entry);
    entry.promise.then(
      () => {
        entry.doneAt = this.now();
      },
      () => {
        if (this.searches.get(key) === entry) this.searches.delete(key);
      },
    );
    while (this.searches.size > SEARCH_MAX_ENTRIES) {
      const oldest = this.searches.keys().next().value;
      if (oldest === undefined) break;
      this.searches.delete(oldest);
    }
    return entry.promise;
  }

  getBars(req: GetBarsRequest): Promise<GetBarsResult> {
    const interval = formatInterval(req.interval);
    // Absent and false mean the same: one key.
    const adjusted = req.adjusted ? 1 : 0;
    const prepost = req.prepost ? 1 : 0;
    const key = [req.symbol, interval, req.limit, req.to ?? '', adjusted, prepost].join('|');
    const hit = this.entries.get(key);
    if (hit && (hit.doneAt === null || this.now() - hit.doneAt < hit.ttlMs)) {
      this.entries.delete(key);
      this.entries.set(key, hit);
      hit.used = ++this.useSeq;
      return hit.promise;
    }
    this.entries.delete(key);
    const openEnded = req.to === undefined;
    const promise =
      openEnded && this.tailRefresh
        ? this.fetchLatest(req, [req.symbol, interval, adjusted, prepost].join('|'))
        : this.inner.getBars(req);
    const entry: Entry = {
      promise,
      doneAt: null,
      ttlMs: openEnded ? this.openEndedTtlMs : this.historicalTtlMs,
      result: null,
      used: ++this.useSeq,
    };
    this.entries.set(key, entry);
    entry.promise.then(
      (result) => {
        entry.doneAt = this.now();
        entry.result = result;
        this.enforceBarBudget();
      },
      () => {
        if (this.entries.get(key) === entry) this.entries.delete(key);
      },
    );
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return entry.promise;
  }

  subscribe(req: SubscribeRequest, lastBar: Bar | null, onBar: BarListener): Unsubscribe {
    return this.inner.subscribe(req, lastBar, onBar);
  }

  /** Open-ended request with `tailRefresh`: merge a small tail into the cached series when possible. */
  private async fetchLatest(req: GetBarsRequest, seriesKey: string): Promise<GetBarsResult> {
    const seq = ++this.fetchSeq;
    const cached = this.usableSeries(seriesKey, req.limit);
    if (cached !== null) {
      const bars = cached.result.bars;
      const last = bars.time[bars.time.length - 1] ?? 0;
      const elapsedBars = Math.ceil((this.now() / 1000 - last) / intervalSeconds(req.interval));
      const limit = Math.min(req.limit, Math.max(0, elapsedBars) + TAIL_OVERLAP);
      const tail = await this.inner.getBars({ ...req, limit });
      const merged = mergeTail(cached.result, tail);
      if (merged !== null) {
        this.storeSeries(seriesKey, merged, cached.fullAt, seq);
        return sliceLatest(merged, req.limit);
      }
      // The tail does not reach the cached bars (a gap): fetch the whole page.
    }
    const result = await this.inner.getBars(req);
    this.storeSeries(seriesKey, result, this.now(), seq);
    return result;
  }

  /** The cached series if a tail can complete it to `limit` bars, else null (dropping it if expired). */
  private usableSeries(key: string, limit: number): Series | null {
    const s = this.series.get(key);
    if (s === undefined) return null;
    if (this.now() - s.fullAt >= this.seriesMaxAgeMs) {
      this.series.delete(key);
      return null;
    }
    this.series.delete(key);
    this.series.set(key, s);
    s.used = ++this.useSeq;
    const n = s.result.bars.time.length;
    // Too short for this request while older bars exist: the tail cannot fill it.
    if (n === 0 || (n < limit && s.result.hasMore)) return null;
    return s;
  }

  private storeSeries(key: string, result: GetBarsResult, fullAt: number, seq: number): void {
    const prev = this.series.get(key);
    if (prev !== undefined && prev.seq > seq) return; // a newer fetch already landed
    this.series.delete(key);
    this.series.set(key, { result, fullAt, seq, used: ++this.useSeq });
    while (this.series.size > this.maxEntries) {
      const oldest = this.series.keys().next().value;
      if (oldest === undefined) break;
      this.series.delete(oldest);
    }
    this.enforceBarBudget();
  }

  /** Drop least recently used results (requests or series) until the bar budget holds. */
  private enforceBarBudget(): void {
    if (!Number.isFinite(this.maxBars)) return;
    while (this.cachedBars() > this.maxBars) {
      const e = this.entries.entries().next().value;
      const s = this.series.entries().next().value;
      if (e !== undefined && (s === undefined || e[1].used < s[1].used)) {
        this.entries.delete(e[0]);
      } else if (s !== undefined) {
        this.series.delete(s[0]);
      } else {
        break;
      }
    }
  }

  private cachedBars(): number {
    // Keyed by column, not result: a result object may wrap another one's arrays.
    const seen = new Set<Float64Array>();
    let total = 0;
    const add = (r: GetBarsResult | null) => {
      if (r === null || seen.has(r.bars.time)) return;
      seen.add(r.bars.time);
      total += r.bars.time.length;
    };
    for (const e of this.entries.values()) add(e.result);
    for (const s of this.series.values()) add(s.result);
    return total;
  }
}

/**
 * Merge freshly fetched latest bars into a cached series: fresh bars replace cached
 * ones from the first fresh time onward, newer ones are appended. Returns null when
 * the tail starts after the cached last bar (bars in between would be missing) or is
 * empty. Never mutates its inputs. The result is not sliced to any limit.
 */
export function mergeTail(cached: GetBarsResult, tail: GetBarsResult): GetBarsResult | null {
  const c = cached.bars;
  const t = tail.bars;
  const n = c.time.length;
  const first = t.time[0];
  if (first === undefined || n === 0 || first > (c.time[n - 1] ?? -Infinity)) return null;
  // Cached bars before the first fresh one are kept.
  let keep = 0;
  while (keep < n && (c.time[keep] ?? Infinity) < first) keep++;
  const join = (a: Float64Array, b: Float64Array): Float64Array => {
    const out = new Float64Array(keep + b.length);
    out.set(a.subarray(0, keep), 0);
    out.set(b, keep);
    return out;
  };
  const bars: BarColumns = {
    time: join(c.time, t.time),
    open: join(c.open, t.open),
    high: join(c.high, t.high),
    low: join(c.low, t.low),
    close: join(c.close, t.close),
    volume: join(c.volume, t.volume),
  };
  // Older history: as the cache knew it, unless the tail reached back past it.
  return { bars, hasMore: keep > 0 ? cached.hasMore : tail.hasMore };
}

/** The last `limit` bars (`r` itself if it has no more); `hasMore` also when bars were cut off. */
function sliceLatest(r: GetBarsResult, limit: number): GetBarsResult {
  const n = r.bars.time.length;
  if (n <= limit) return r;
  const from = n - limit;
  const cut = (a: Float64Array): Float64Array => a.slice(from);
  const b = r.bars;
  return {
    bars: {
      time: cut(b.time),
      open: cut(b.open),
      high: cut(b.high),
      low: cut(b.low),
      close: cut(b.close),
      volume: cut(b.volume),
    },
    hasMore: true,
  };
}
