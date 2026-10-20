import type {
  Bar,
  BarListener,
  DataFeed,
  GetBarsRequest,
  GetBarsResult,
  SubscribeRequest,
  SymbolInfo,
  SymbolSearchResult,
  Unsubscribe,
} from '../types';
import { formatInterval } from './intervals';

export interface CoalescingFeedOptions {
  /** How long a finished result is reused (ms). Default 10000. */
  ttlMs?: number;
  /** Most distinct requests remembered; least recently used are dropped. Default 64. */
  maxEntries?: number;
  /** Clock override for tests. */
  now?: () => number;
}

interface Entry {
  promise: Promise<GetBarsResult>;
  /** Set when the request resolved; in-flight entries never expire. */
  doneAt: number | null;
}

/**
 * Shares identical `getBars` requests between consumers (several charts of a
 * layout opening the same symbol and interval): concurrent calls join one
 * in-flight request, and the last result is reused for a short time. Failed
 * requests are never kept. Everything else passes straight through.
 *
 * Results are shared by reference, so consumers must treat them as read-only.
 */
export class CoalescingFeed implements DataFeed {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  /** Insertion order = recency (re-inserted on use). */
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly inner: DataFeed,
    opts: CoalescingFeedOptions = {},
  ) {
    this.ttlMs = opts.ttlMs ?? 10_000;
    this.maxEntries = opts.maxEntries ?? 64;
    this.now = opts.now ?? (() => Date.now());
  }

  resolveSymbol(symbol: string): Promise<SymbolInfo> {
    return this.inner.resolveSymbol(symbol);
  }

  searchSymbols(query: string, limit?: number): Promise<SymbolSearchResult[]> {
    return this.inner.searchSymbols(query, limit);
  }

  getBars(req: GetBarsRequest): Promise<GetBarsResult> {
    const key = [
      req.symbol,
      formatInterval(req.interval),
      req.limit,
      req.to ?? '',
      req.adjusted ?? '',
      req.prepost ?? '',
    ].join('|');
    const hit = this.entries.get(key);
    if (hit && (hit.doneAt === null || this.now() - hit.doneAt < this.ttlMs)) {
      this.entries.delete(key);
      this.entries.set(key, hit);
      return hit.promise;
    }
    this.entries.delete(key);
    const entry: Entry = { promise: this.inner.getBars(req), doneAt: null };
    this.entries.set(key, entry);
    entry.promise.then(
      () => {
        entry.doneAt = this.now();
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
}
