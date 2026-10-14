import type {
  Bar,
  BarColumns,
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
import {
  alignKeys,
  alignModeFor,
  asOfIndex,
  calendarContext,
  evalBar,
  evalBarColumns,
  lowerBound,
  maxStaleSeconds,
  tryParseSymbolExpression,
  type AlignMode,
  type BarColumnsLike,
  type OhlcLike,
  type ParsedSymbol,
} from './expression';
import { FeedError } from './http-feed';
import { formatInterval, intervalSeconds } from './intervals';
import { emptyColumns, localDay, type BucketContext } from './resample';

const DAY = 86_400;
/** API cap on bars per request. */
const MAX_LEG_LIMIT = 20_000;
const PARSE_CACHE = 64;
const TAIL_CACHE = 32;
/** Bars per leg kept from the newest page to seed live updates. */
const TAIL_BARS = 16;
/** Max primary fetches per getBars when the cut rule empties a page. */
const MAX_EMPTY_ATTEMPTS = 5;
const LEG_INFO_CACHE = 64;
/** Bars per leg kept while live. */
const RING_BARS = 64;

/** Newest bars of one leg, as fetched by the last `to`-less getBars. */
interface LegTail {
  bars: Bar[];
  /** Calendar key context (calendar mode only). */
  ctx: BucketContext | null;
}

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

function barAt(c: BarColumns, i: number): Bar {
  return {
    time: c.time[i] as number,
    open: c.open[i] as number,
    high: c.high[i] as number,
    low: c.low[i] as number,
    close: c.close[i] as number,
    volume: c.volume[i] as number,
  };
}

function tailBars(c: BarColumns): Bar[] {
  const n = c.time.length;
  const out: Bar[] = [];
  for (let i = Math.max(0, n - TAIL_BARS); i < n; i++) out.push(barAt(c, i));
  return out;
}

/** Set `key` as most recently used, evicting the oldest beyond `max`. */
function lruSet<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) {
    const oldest = map.keys().next();
    if (oldest.done === true) break;
    map.delete(oldest.value);
  }
}

function lruGet<K, V>(map: Map<K, V>, key: K): V | undefined {
  const v = map.get(key);
  if (v !== undefined) {
    map.delete(key);
    map.set(key, v);
  }
  return v;
}

/**
 * DataFeed wrapper that serves symbol expressions such as `AAPL/MSFT` or
 * `(A+B)/2` by fetching every leg from the wrapped feed, aligning the legs on
 * the first (primary) symbol's bar times and evaluating per row. Plain
 * symbols pass straight through.
 */
export class ExpressionFeed implements DataFeed {
  private readonly inner: DataFeed;
  private readonly maxLegs: number;
  private readonly parsed = new Map<string, ParsedSymbol>();
  private readonly legInfo = new Map<string, SymbolInfo>();
  private readonly tails = new Map<string, Map<string, LegTail>>();

  constructor(inner: DataFeed, opts?: { maxLegs?: number }) {
    this.inner = inner;
    this.maxLegs = opts?.maxLegs ?? 8;
  }

  async resolveSymbol(symbol: string): Promise<SymbolInfo> {
    const p = this.parse(symbol);
    if (p.plain) return this.inner.resolveSymbol(p.symbols[0] as string);
    const infos = await this.resolveLegs(p, symbol);
    const primary = infos[0] as SymbolInfo;
    const currency = primary.currency;
    const sameCurrency = currency !== null && infos.every((i) => i.currency === currency);
    const sameSession = infos.every(
      (i) => i.timezone === primary.timezone && i.session === primary.session,
    );
    let hint = 0;
    for (const i of infos) hint = Math.max(hint, i.priceHint);
    const priceHint = p.dividesBySymbol ? Math.max(4, hint) : hint;
    return {
      symbol: p.canonical,
      name: p.canonical,
      exchange: null,
      exchangeName: 'Expression',
      type: 'expression',
      currency: p.linear && sameCurrency ? currency : null,
      timezone: primary.timezone,
      session: sameSession ? primary.session : null,
      priceHint,
      minTick: 10 ** -priceHint,
    };
  }

  searchSymbols(query: string, limit?: number): Promise<SymbolSearchResult[]> {
    return this.inner.searchSymbols(query, limit);
  }

  async getBars(req: GetBarsRequest): Promise<GetBarsResult> {
    const p = this.parse(req.symbol);
    const legs = p.symbols;
    const primarySym = legs[0] as string;
    if (p.plain) return this.inner.getBars({ ...req, symbol: primarySym });

    const mode = alignModeFor(req.interval);
    const calendar = mode === 'calendar';
    // Leg infos are needed for calendar keys (each leg's own exchange date).
    const infosP = calendar ? this.resolveLegs(p, req.symbol) : Promise.resolve(null);
    // A guaranteed handler: if the primary fetch throws first, the rejection is
    // not reported as unhandled. The await below still sees it.
    infosP.catch(() => {});

    // One extra primary bar, if available, serves as the lead-in row so the
    // first returned row has the same forward-fill state as in a larger fetch.
    const primaryLimit = req.limit < MAX_LEG_LIMIT ? req.limit + 1 : req.limit;
    const P = await this.inner.getBars({ ...req, symbol: primarySym, limit: primaryLimit });
    const pn = P.bars.time.length;
    if (pn === 0) return { bars: emptyColumns(), hasMore: P.hasMore };
    return this.buildPage(req, p, mode, calendar, infosP, P, 1);
  }

  /**
   * Align and evaluate one primary page. If the cut rule leaves nothing but the
   * primary has more history, step back (at most MAX_EMPTY_RETRIES times)
   * rather than hand the chart an empty page with hasMore, which it reads as
   * the end of history.
   */
  private async buildPage(
    req: GetBarsRequest,
    p: ParsedSymbol,
    mode: AlignMode,
    calendar: boolean,
    infosP: Promise<SymbolInfo[] | null>,
    P: GetBarsResult,
    attempt: number,
  ): Promise<GetBarsResult> {
    const legs = p.symbols;
    const pn = P.bars.time.length;

    const stale = maxStaleSeconds(req.interval);
    const ivl = intervalSeconds(req.interval);
    const pad = calendar ? 2 * DAY : 0;
    const legTo = req.to === undefined ? undefined : req.to + pad;
    const spanStart = (P.bars.time[0] as number) - stale - pad;
    const span = (legTo ?? Date.now() / 1000) - spanStart;
    const legLimit = Math.min(MAX_LEG_LIMIT, Math.max(req.limit, Math.ceil(span / ivl) + 2));
    const others = await Promise.all(
      legs.slice(1).map((symbol) => {
        const r: GetBarsRequest = { ...req, symbol, limit: legLimit };
        if (legTo === undefined) delete r.to;
        else r.to = legTo;
        return this.inner.getBars(r);
      }),
    );
    const results = [P, ...others];
    const infos = await infosP;

    const ctxs = results.map((r, k) =>
      calendar
        ? calendarContext(infos?.[k]?.timezone ?? null, r.bars.time, r.bars.time.length)
        : null,
    );
    const keys = results.map((r, k) => {
      const ctx = ctxs[k];
      const t = r.bars.time;
      return ctx === null || ctx === undefined ? t : alignKeys(t, t.length, mode, ctx);
    });
    const pk = keys[0] as Float64Array;

    // Rows before a still-paging leg's first bar are incomplete: drop them now,
    // they are refetched with the next page.
    let cut = 0;
    for (let k = 1; k < results.length; k++) {
      const r = results[k] as GetBarsResult;
      if (!r.hasMore) continue;
      const lk = keys[k] as Float64Array;
      cut = Math.max(cut, lk.length === 0 ? pn : lowerBound(pk, pn, lk[0] as number));
    }
    // Without a lead-in row the first primary row's fill state is unknown.
    const first = Math.max(cut, P.hasMore ? 1 : 0);
    if (first >= pn) {
      if (attempt >= MAX_EMPTY_ATTEMPTS || !P.hasMore) {
        return { bars: emptyColumns(), hasMore: P.hasMore };
      }
      const next = await this.inner.getBars({
        ...req,
        symbol: legs[0] as string,
        limit: req.limit < MAX_LEG_LIMIT ? req.limit + 1 : req.limit,
        to: P.bars.time[0] as number,
      });
      if (next.bars.time.length === 0) return { bars: emptyColumns(), hasMore: next.hasMore };
      return this.buildPage(
        { ...req, to: P.bars.time[0] as number },
        p,
        mode,
        calendar,
        infosP,
        next,
        attempt + 1,
      );
    }
    const lead = Math.max(0, first - 1);
    const rn = pn - lead;

    const legMap = new Map<string, BarColumnsLike>();
    const rows: Int32Array[] = [];
    results.forEach((r, k) => {
      const sym = legs[k] as string;
      legMap.set(sym, r.bars);
      const lk = keys[k] as Float64Array;
      const idx =
        k === 0
          ? Int32Array.from({ length: rn }, (_, i) => lead + i)
          : asOfIndex(pk.subarray(lead), rn, lk, lk.length, stale);
      rows.push(idx);
    });
    const out = evalBarColumns(p.ast, legMap, rows, rn);

    // Drop the lead-in row, then keep the newest `limit` rows.
    const firstTime = P.bars.time[first] as number;
    let s = 0;
    const on = out.time.length;
    while (s < on && (out.time[s] as number) < firstTime) s++;
    const truncated = on - s > req.limit;
    if (truncated) s = on - req.limit;
    const bars = s === 0 ? out : sliceColumns(out, s, on);

    // Only the newest page seeds live updates, not a step-back page.
    if (req.to === undefined && attempt === 1) {
      const tail = new Map<string, LegTail>();
      results.forEach((r, k) => {
        tail.set(legs[k] as string, { bars: tailBars(r.bars), ctx: ctxs[k] ?? null });
      });
      lruSet(this.tails, tailKey(p.canonical, req.interval, req.prepost), tail, TAIL_CACHE);
    }
    return { bars, hasMore: P.hasMore || cut > 0 || truncated };
  }

  subscribe(req: SubscribeRequest, lastBar: Bar | null, onBar: BarListener): Unsubscribe {
    const parsed = this.tryParse(req.symbol);
    if (parsed === null) {
      // getBars/resolveSymbol report the parse error; nothing to stream.
      return () => {};
    }
    const legs = parsed.symbols;
    if (parsed.plain)
      return this.inner.subscribe({ ...req, symbol: legs[0] as string }, lastBar, onBar);

    const interval = { unit: req.interval.unit, count: req.interval.count };
    const live = new LiveExpression(
      parsed,
      interval,
      lruGet(this.tails, tailKey(parsed.canonical, interval, req.prepost)),
      lastBar,
      onBar,
    );
    let active = true;
    const unsubs: Unsubscribe[] = [];
    const start = (infos: SymbolInfo[]): void => {
      live.setInfos(infos);
      legs.forEach((symbol, k) => {
        const info = infos[k] as SymbolInfo;
        // Each leg buckets in its own exchange time, never the expression's.
        const legReq: SubscribeRequest = {
          symbol,
          interval,
          timezone: info.timezone,
          session: info.session,
        };
        if (req.prepost !== undefined) legReq.prepost = req.prepost;
        unsubs.push(
          this.inner.subscribe(legReq, live.lastLegBar(k), (b) => {
            if (active) live.onLegBar(k, b);
          }),
        );
      });
    };

    const known = legs.map((s) => lruGet(this.legInfo, s));
    if (known.every((i) => i !== undefined)) {
      start(known as SymbolInfo[]);
    } else {
      this.resolveLegs(parsed, req.symbol).then(
        (infos) => {
          if (active) start(infos);
        },
        () => {
          // Unknown leg: the chart's own resolveSymbol call surfaces the error.
        },
      );
    }
    return () => {
      if (!active) return;
      active = false;
      for (const u of unsubs) u();
      unsubs.length = 0;
    };
  }

  private tryParse(symbol: string): ParsedSymbol | null {
    const hit = lruGet(this.parsed, symbol);
    if (hit !== undefined) return hit;
    const r = tryParseSymbolExpression(symbol);
    if (!r.ok) return null;
    lruSet(this.parsed, symbol, r.value, PARSE_CACHE);
    return r.value;
  }

  private parse(symbol: string): ParsedSymbol {
    const hit = this.tryParse(symbol);
    if (hit !== null) {
      if (hit.symbols.length > this.maxLegs) {
        throw new FeedError(`Too many symbols (max ${this.maxLegs})`, 400);
      }
      return hit;
    }
    const r = tryParseSymbolExpression(symbol);
    const message = r.ok ? 'Invalid symbol expression' : r.error.message;
    throw new FeedError(message, 400, r.ok ? undefined : { cause: r.error });
  }

  /** Resolve every leg in parallel (symbols order). Failures name the leg. */
  private resolveLegs(p: ParsedSymbol, input: string): Promise<SymbolInfo[]> {
    return Promise.all(
      p.symbols.map((symbol) => {
        const cached = lruGet(this.legInfo, symbol);
        if (cached !== undefined) return Promise.resolve(cached);
        return this.inner.resolveSymbol(symbol).then(
          (info) => {
            lruSet(this.legInfo, symbol, info, LEG_INFO_CACHE);
            return info;
          },
          (err: unknown) => {
            throw legError(symbol, input, err);
          },
        );
      }),
    );
  }
}

function legError(symbol: string, input: string, err: unknown): FeedError {
  const status = err instanceof FeedError ? err.status : 0;
  if (status >= 400 && status < 500) {
    let hint = symbol.includes('-') ? ' — for a spread put spaces around the minus: A - B' : '';
    if (!symbol.includes('/') && /[A-Za-z]\/[A-Za-z]/.test(input)) {
      hint += ' — to use a symbol containing \'/\', quote it: "BRK/B"';
    }
    return new FeedError(`Unknown symbol in expression: ${symbol}${hint}`, status, { cause: err });
  }
  const detail = err instanceof Error ? err.message : String(err);
  return new FeedError(`Could not resolve ${symbol}: ${detail}`, status, { cause: err });
}

function tailKey(canonical: string, interval: Interval, prepost: boolean | undefined): string {
  return `${canonical}|${formatInterval(interval)}|${prepost === true ? 1 : 0}`;
}

/** Live state of one expression subscription: a ring of recent bars per leg. */
class LiveExpression {
  private readonly mode: AlignMode;
  private readonly stale: number;
  private readonly rings: Bar[][];
  private readonly tailCtx: (BucketContext | null)[];
  private timezones: (string | null)[];
  /** Per-leg calendar context built from the ring, keyed by the ring's first time. */
  private readonly memoCtx: ({ head: number; len: number; ctx: BucketContext } | undefined)[] = [];
  private lastEmitted: number;

  constructor(
    private readonly parsed: ParsedSymbol,
    interval: Interval,
    tail: Map<string, LegTail> | undefined,
    lastBar: Bar | null,
    private readonly onBar: BarListener,
  ) {
    this.mode = alignModeFor(interval);
    this.stale = maxStaleSeconds(interval);
    this.rings = parsed.symbols.map((s) => (tail?.get(s)?.bars ?? []).map((b) => ({ ...b })));
    this.tailCtx = parsed.symbols.map((s) => tail?.get(s)?.ctx ?? null);
    this.timezones = parsed.symbols.map(() => null);
    this.lastEmitted = lastBar?.time ?? -Infinity;
  }

  setInfos(infos: readonly SymbolInfo[]): void {
    this.timezones = infos.map((i) => i.timezone);
    this.memoCtx.length = 0;
  }

  lastLegBar(k: number): Bar | null {
    const ring = this.rings[k] as Bar[];
    const b = ring[ring.length - 1];
    return b === undefined ? null : { ...b };
  }

  onLegBar(k: number, b: Bar): void {
    const ring = this.rings[k] as Bar[];
    const at = upsert(ring, b);
    if (at < 0) return;
    const primary = this.rings[0] as Bar[];
    if (k === 0) {
      this.emitRow(at);
      return;
    }
    const cur = primary.length - 1;
    if (cur < 0) return;
    // A leg bar newer than the current row waits for the primary to append.
    if (this.key(k, b.time) > this.key(0, (primary[cur] as Bar).time)) return;
    this.emitRow(cur);
  }

  private emitRow(pi: number): void {
    const primary = this.rings[0] as Bar[];
    const pb = primary[pi] as Bar;
    if (pb.time < this.lastEmitted) return;
    const key = this.key(0, pb.time);
    const prev = primary[pi - 1];
    const prevKey = prev === undefined ? null : this.key(0, prev.time);
    const legBars = new Map<string, OhlcLike>();
    legBars.set(this.parsed.symbols[0] as string, pb);
    for (let k = 1; k < this.rings.length; k++) {
      const lb = this.asOf(k, key);
      if (lb === null) return;
      // Same leg bar as the previous row: forward-filled at its close.
      const filled = prevKey !== null && this.asOf(k, prevKey) === lb;
      const c = lb.close;
      legBars.set(
        this.parsed.symbols[k] as string,
        filled ? { open: c, high: c, low: c, close: c } : lb,
      );
    }
    const row = evalBar(this.parsed.ast, legBars);
    if (row === null) return;
    this.lastEmitted = pb.time;
    this.onBar({ time: pb.time, ...row, volume: 0 });
  }

  /** Newest bar of leg `k` with key <= `key` and not older than the stale limit. */
  private asOf(k: number, key: number): Bar | null {
    const ring = this.rings[k] as Bar[];
    for (let j = ring.length - 1; j >= 0; j--) {
      const b = ring[j] as Bar;
      const lk = this.key(k, b.time);
      if (lk <= key) return key - lk <= this.stale ? b : null;
    }
    return null;
  }

  private key(k: number, t: number): number {
    if (this.mode === 'instant') return t;
    const seeded = this.tailCtx[k] ?? null;
    if (seeded !== null) return localDay(t, seeded) * DAY;
    const ring = this.rings[k] as Bar[];
    const head = ring.length > 0 ? (ring[0] as Bar).time : NaN;
    let memo = this.memoCtx[k];
    // Rebuild only when the ring's first bar or size changed (once per new bar).
    if (memo === undefined || !Object.is(memo.head, head) || memo.len !== ring.length) {
      const times = ring.map((b) => b.time);
      memo = {
        head,
        len: ring.length,
        ctx: calendarContext(this.timezones[k] ?? null, times, times.length),
      };
      this.memoCtx[k] = memo;
    }
    return localDay(t, memo.ctx) * DAY;
  }
}

/**
 * Insert or replace `b` in an ascending ring. Returns its index, or -1 when it
 * is older than the newest bar and not already present (ignored).
 */
function upsert(ring: Bar[], b: Bar): number {
  const last = ring[ring.length - 1];
  if (last === undefined || b.time > last.time) {
    ring.push({ ...b });
    if (ring.length > RING_BARS) ring.splice(0, ring.length - RING_BARS);
    return ring.length - 1;
  }
  for (let j = ring.length - 1; j >= 0; j--) {
    const t = (ring[j] as Bar).time;
    if (t === b.time) {
      ring[j] = { ...b };
      return j;
    }
    if (t < b.time) break;
  }
  return -1;
}
