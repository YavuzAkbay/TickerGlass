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
import { intervalSeconds, isIntraday, isNativeInterval, resampleBase } from './intervals';
import {
  bucketStart,
  createBucketContext,
  emptyColumns,
  localDay,
  resample,
  seedBucketAnchor,
  usesDataAnchor,
  type BucketContext,
  type BucketOptions,
} from './resample';

/** API cap on bars per request. */
const MAX_BASE_LIMIT = 20_000;
/** Upper bound on base requests per getBars call. */
const MAX_PAGES = 20;
const DAY = 86_400;

function sliceColumns(c: BarColumns, start: number, end: number): BarColumns {
  return {
    time: c.time.slice(start, end),
    open: c.open.slice(start, end),
    high: c.high.slice(start, end),
    low: c.low.slice(start, end),
    close: c.close.slice(start, end),
    volume: c.volume.slice(start, end),
  };
}

function concatColumns(parts: readonly BarColumns[]): BarColumns {
  if (parts.length === 1 && parts[0] !== undefined) return parts[0];
  let n = 0;
  for (const p of parts) n += p.time.length;
  const out = emptyColumns(n);
  let at = 0;
  for (const p of parts) {
    out.time.set(p.time, at);
    out.open.set(p.open, at);
    out.high.set(p.high, at);
    out.low.set(p.low, at);
    out.close.set(p.close, at);
    out.volume.set(p.volume, at);
    at += p.time.length;
  }
  return out;
}

/**
 * Number of leading output buckets that may be incomplete because older base
 * history was not fetched: always the first bucket, and for intraday targets
 * whose oldest base bar is anchored by data (no session / out of session) every
 * bucket on that local day, since the day's anchor may be wrong.
 */
function incompleteHead(
  out: BarColumns,
  base: BarColumns,
  intraday: boolean,
  opts: BucketOptions,
): number {
  const n = out.time.length;
  if (n === 0) return 0;
  let drop = 1;
  const first = base.time[0];
  if (intraday && first !== undefined) {
    const ctx = createBucketContext(opts);
    if (usesDataAnchor(first, ctx)) {
      const day0 = localDay(first, ctx);
      while (drop < n && localDay(out.time[drop] as number, ctx) <= day0) drop++;
    }
  }
  return drop;
}

function symbolKey(symbol: string): string {
  return symbol.trim().toUpperCase();
}

/**
 * DataFeed wrapper that serves non-native intervals (3m, 4h, 2D, 6M, ...) by
 * resampling the best native base interval from the wrapped feed. Native
 * intervals pass straight through.
 */
export class ResamplingFeed implements DataFeed {
  private readonly inner: DataFeed;
  private readonly infoCache = new Map<string, Promise<SymbolInfo>>();
  private readonly infoResolved = new Map<string, SymbolInfo>();

  constructor(inner: DataFeed) {
    this.inner = inner;
  }

  resolveSymbol(symbol: string): Promise<SymbolInfo> {
    const key = symbolKey(symbol);
    let p = this.infoCache.get(key);
    if (p === undefined) {
      p = this.inner.resolveSymbol(symbol).then((info) => {
        this.infoResolved.set(key, info);
        return info;
      });
      this.infoCache.set(key, p);
      // Do not cache failures; a later call retries.
      p.catch(() => {
        if (this.infoCache.get(key) === p) this.infoCache.delete(key);
      });
    }
    return p;
  }

  /** Forget every resolved symbol (the data provider changed). */
  clearSymbolCache(): void {
    this.infoCache.clear();
    this.infoResolved.clear();
  }

  searchSymbols(query: string, limit?: number): Promise<SymbolSearchResult[]> {
    return this.inner.searchSymbols(query, limit);
  }

  async getBars(req: GetBarsRequest): Promise<GetBarsResult> {
    if (isNativeInterval(req.interval)) return this.inner.getBars(req);
    const info = await this.resolveSymbol(req.symbol);
    const opts: BucketOptions = { timezone: info.timezone, session: info.session };
    const { base, factor } = resampleBase(req.interval);
    const intraday = isIntraday(req.interval);
    const limit = Math.max(1, Math.floor(req.limit));
    // Intraday heads may lose a whole local day; fetch at least a day per page so
    // small limits do not degenerate into many tiny requests.
    const minPage = intraday ? Math.ceil(DAY / intervalSeconds(base)) + factor : 0;

    const chunks: BarColumns[] = [];
    let baseTo = req.to;
    let baseHasMore = false;
    let complete = emptyColumns();
    let wanted = limit * factor + factor;
    for (let page = 0; page < MAX_PAGES; page++) {
      const baseReq: GetBarsRequest = {
        ...req,
        interval: base,
        limit: Math.min(MAX_BASE_LIMIT, Math.max(wanted, minPage)),
      };
      if (baseTo !== undefined) baseReq.to = baseTo;
      const res = await this.inner.getBars(baseReq);
      baseHasMore = res.hasMore;
      const got = res.bars.time.length;
      if (got > 0) chunks.unshift(res.bars);
      if (chunks.length === 0) break;
      const merged = concatColumns(chunks);
      const out = resample(merged, req.interval, opts);
      complete = baseHasMore
        ? sliceColumns(out, incompleteHead(out, merged, intraday, opts), out.time.length)
        : out;
      if (got === 0 || !baseHasMore || complete.time.length >= limit) break;
      baseTo = merged.time[0];
      wanted = (limit - complete.time.length) * factor + factor;
    }

    const n = complete.time.length;
    const bars = n > limit ? sliceColumns(complete, n - limit, n) : complete;
    // Paging: the caller passes our oldest bucket start as the next `to`; base bars
    // before it belong to strictly older buckets, so pages neither gap nor overlap.
    return { bars, hasMore: baseHasMore || n > limit };
  }

  subscribe(req: SubscribeRequest, lastBar: Bar | null, onBar: BarListener): Unsubscribe {
    if (isNativeInterval(req.interval)) return this.inner.subscribe(req, lastBar, onBar);
    const target = { unit: req.interval.unit, count: req.interval.count };
    const intraday = isIntraday(target);
    const { base } = resampleBase(target);
    const key = symbolKey(req.symbol);

    const makeCtx = (info: SymbolInfo | undefined): BucketContext => {
      const ctx = createBucketContext({
        timezone: req.timezone !== undefined ? req.timezone : (info?.timezone ?? null),
        session: req.session !== undefined ? req.session : (info?.session ?? null),
      });
      if (intraday && cur !== null) seedBucketAnchor(cur.time, ctx);
      return ctx;
    };

    // Running aggregate of the current target bucket: the chart's last bar (what
    // happened before we subscribed) plus every base bar seen in that bucket.
    let cur: Bar | null = lastBar ? { ...lastBar } : null;
    let prefix: Bar | null = lastBar ? { ...lastBar } : null;
    const baseBars = new Map<number, Bar>();
    let ctx = makeCtx(this.infoResolved.get(key));
    let active = true;

    if ((req.timezone === undefined || req.session === undefined) && !this.infoResolved.has(key)) {
      this.resolveSymbol(req.symbol).then(
        (info) => {
          if (active) ctx = makeCtx(info);
        },
        () => {
          // Lookup failed: keep bucketing in UTC without a session. The chart's own
          // resolveSymbol call surfaces the error.
        },
      );
    }

    const onBase = (b: Bar): void => {
      const tb = bucketStart(b.time, target, ctx);
      if (cur !== null && tb < cur.time) return;
      if (cur === null || tb > cur.time) {
        prefix = null;
        baseBars.clear();
      }
      baseBars.set(b.time, { ...b });
      cur = aggregate(tb, prefix, baseBars);
      onBar({ ...cur });
    };

    // Base bars start fresh (null lastBar): they then carry only post-subscription
    // activity, which combines with `prefix` without double-counting volume.
    const unsubInner = this.inner.subscribe({ ...req, interval: base }, null, onBase);
    return () => {
      if (!active) return;
      active = false;
      unsubInner();
    };
  }
}

function aggregate(time: number, prefix: Bar | null, baseBars: Map<number, Bar>): Bar {
  const bars = [...baseBars.values()].sort((a, b) => a.time - b.time);
  const first = bars[0];
  const last = bars[bars.length - 1];
  const out: Bar = {
    time,
    open: prefix?.open ?? first?.open ?? NaN,
    high: prefix?.high ?? -Infinity,
    low: prefix?.low ?? Infinity,
    close: last?.close ?? prefix?.close ?? NaN,
    volume: prefix?.volume ?? 0,
  };
  for (const b of bars) {
    if (b.high > out.high) out.high = b.high;
    if (b.low < out.low) out.low = b.low;
    out.volume += b.volume;
  }
  return out;
}
