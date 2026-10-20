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
  UTCTimestamp,
} from '../types';
import { formatInterval, intervalSeconds, intervalsEqual, isIntraday } from './intervals';
import { bucketStart, createBucketContext, localDay, type BucketContext } from './resample';

/** Bars per forward page. */
const PAGE_LIMIT = 2000;
/** A forward buffer is topped up when fewer bars than this remain after the clock. */
const REFILL_AHEAD = 500;
/** Initial forward page span, in nominal bars of the buffer's interval. */
const SPAN_BARS = 1000;
/** Upper bound on requests per buffer operation (span halvings, gap skips, back pages). */
const MAX_REQUESTS = 40;
const DAY = 86_400;

export type ReplayMode = 'live' | 'replay';

/** Tick choice: automatic intrabar, whole chart bars, or a fixed intrabar interval. */
export type ReplayUpdate = 'auto' | 'bars' | Interval;

export interface ReplayFeedOptions {
  /** How far back (seconds) history of `interval` reaches; null = unlimited. */
  lookbackSeconds?: (interval: Interval) => number | null;
  /** Current unix time in seconds. Defaults to the wall clock. */
  now?: () => number;
}

export interface ReplayStartOptions {
  /** Chart symbol and interval. */
  symbol: string;
  interval: Interval;
  /** Picked bar time: it becomes the last visible chart bar. */
  lastVisible: UTCTimestamp;
  update: ReplayUpdate;
  prepost: boolean;
}

export interface ReplayInfo {
  /** Interval of one clock step, or null when whole chart bars are replayed. */
  tick: Interval | null;
  warning: string | null;
}

export interface ReplayClock {
  /** Open time of the last revealed tick. */
  last: UTCTimestamp;
  /** Open time of the first unrevealed tick (E): data at or after it is hidden. */
  next: UTCTimestamp;
}

export interface ReplayFeedEvents {
  clock: ReplayClock;
  /** No more data to reveal (realtime reached). */
  end: void;
  warning: string;
}

interface SeriesKey {
  symbol: string;
  interval: Interval;
  prepost: boolean;
}

function symbolKey(symbol: string): string {
  return symbol.trim().toUpperCase();
}

function seriesKey(k: SeriesKey): string {
  return `${symbolKey(k.symbol)}|${formatInterval(k.interval)}|${k.prepost ? 1 : 0}`;
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

/** Columns with every bar at or after `limit` removed. */
function clipColumns(c: BarColumns, limit: number): BarColumns {
  let n = c.time.length;
  while (n > 0 && (c.time[n - 1] as number) >= limit) n--;
  if (n === c.time.length) return c;
  return {
    time: c.time.slice(0, n),
    open: c.open.slice(0, n),
    high: c.high.slice(0, n),
    low: c.low.slice(0, n),
    close: c.close.slice(0, n),
    volume: c.volume.slice(0, n),
  };
}

/**
 * Bars of one (symbol, interval, prepost) series around the replay clock. Grows
 * forward page by page as the clock advances, and backward on demand. Loaded bars
 * are contiguous: every bar in [bars[0].time, hi) is present. Operations are
 * serialized, so concurrent callers never page the same range twice.
 */
class ForwardBuffer {
  readonly bars: Bar[] = [];
  /** Shared by subscriptions and getBars calls; dropped from the cache at zero. */
  refs = 0;
  /** The loaded range reaches past "now": no later bars exist yet. */
  ended = false;
  /** Exclusive end of the loaded range. */
  private hi: number;
  /** No bars exist before bars[0]. */
  private head = false;
  private span: number;
  private readonly maxSpan: number;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly inner: DataFeed,
    readonly key: string,
    readonly series: SeriesKey,
    anchor: number,
    private readonly now: () => number,
  ) {
    this.hi = anchor;
    this.maxSpan = SPAN_BARS * intervalSeconds(series.interval);
    this.span = this.maxSpan;
  }

  /** Index of the last bar with time < t, or -1. */
  lastBefore(t: number): number {
    let lo = 0;
    let hi = this.bars.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((this.bars[mid] as Bar).time < t) lo = mid + 1;
      else hi = mid;
    }
    return lo - 1;
  }

  /** Index of the first bar with time > t (bars.length if none). */
  firstAfter(t: number): number {
    let lo = 0;
    let hi = this.bars.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((this.bars[mid] as Bar).time <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /**
   * End of bar `i`: the next native bar's time, or time + interval for the last
   * bar once the buffer has ended. Infinity while the next bar is not loaded yet.
   */
  barEnd(i: number): number {
    const next = this.bars[i + 1];
    if (next !== undefined) return next.time;
    const b = this.bars[i] as Bar;
    return this.ended ? b.time + intervalSeconds(this.series.interval) : Infinity;
  }

  /**
   * Load until a bar after `t` is known (or the series has ended), then top up
   * with one more page if fewer than `ahead` bars remain after `t`.
   */
  ensureAfter(t: number, ahead = REFILL_AHEAD): Promise<void> {
    return this.serial(async () => {
      for (let n = 0; !this.ended && this.firstAfter(t) === this.bars.length; n++) {
        if (n >= MAX_REQUESTS) throw new Error(`replay: no data after ${t} for ${this.key}`);
        await this.pageForward();
      }
      if (!this.ended && this.bars.length - this.firstAfter(t) < ahead) await this.pageForward();
    });
  }

  /** Load backward until a bar before `t` is known, or history has no such bar. */
  ensureBefore(t: number): Promise<void> {
    return this.serial(async () => {
      const sec = intervalSeconds(this.series.interval);
      for (let n = 0; n < MAX_REQUESTS; n++) {
        const first = this.bars[0];
        if (this.head || (first !== undefined && first.time < t)) return;
        const to = first?.time ?? this.hi;
        const limit = Math.min(PAGE_LIMIT, Math.max(2, Math.ceil((to - t) / sec) + 2));
        const res = await this.inner.getBars(this.request(to, limit));
        const older: Bar[] = [];
        for (let i = 0; i < res.bars.time.length; i++) {
          if ((res.bars.time[i] as number) < to) older.push(barAt(res.bars, i));
        }
        this.bars.unshift(...older);
        if (older.length === 0 || !res.hasMore) this.head = true;
      }
      throw new Error(`replay: no data before ${t} for ${this.key}`);
    });
  }

  /**
   * One forward page [hi, hi + span). A full page whose first bar is after `hi`
   * may have skipped bars, so the span is halved and the page retried.
   */
  private async pageForward(): Promise<void> {
    const from = this.hi;
    for (let n = 0; n < MAX_REQUESTS; n++) {
      const to = from + this.span;
      const res = await this.inner.getBars(this.request(to, PAGE_LIMIT));
      const t = res.bars.time;
      const k = t.length;
      if (k >= PAGE_LIMIT && (t[0] as number) > from && this.span > 1) {
        this.span = Math.max(1, Math.floor(this.span / 2));
        continue;
      }
      // [from, to) is now fully known. An empty buffer also keeps older bars: they
      // are the newest ones before `to`, hence contiguous with it.
      const empty = this.bars.length === 0;
      const lastTime = this.bars[this.bars.length - 1]?.time ?? -Infinity;
      for (let i = 0; i < k; i++) {
        const time = t[i] as number;
        if (time >= to || time <= lastTime || (!empty && time < from)) continue;
        this.bars.push(barAt(res.bars, i));
      }
      if (empty && !res.hasMore) this.head = true;
      if (k < PAGE_LIMIT / 2) this.span = Math.min(this.maxSpan, this.span * 2);
      this.hi = to;
      if (to > this.now()) this.ended = true;
      return;
    }
    throw new Error(`replay: could not page ${this.key} forward from ${from}`);
  }

  private request(to: number, limit: number): GetBarsRequest {
    const { symbol, interval, prepost } = this.series;
    return { symbol, interval, prepost, to, limit };
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.queue.then(fn);
    // Keep the queue alive after a failure; the caller still sees the rejection.
    this.queue = p.catch(() => undefined);
    return p;
  }
}

/**
 * Last bar of `buf` revealed under rule P at clock `e` (closed: end <= e), or -1.
 * Without ticks finer than the series interval only closed bars are visible.
 */
function lastClosed(buf: ForwardBuffer, e: number): number {
  const j = buf.lastBefore(e);
  if (j < 0) return -1;
  return buf.barEnd(j) <= e ? j : j - 1;
}

interface PassthroughSub {
  unsubscribe: Unsubscribe;
}

interface ReplaySub {
  req: SubscribeRequest;
  onBar: BarListener;
  /** The subscriber's newest bar; only used once, as the catch-up baseline. */
  lastBar: Bar | null;
  active: boolean;
  /** Generation the state below belongs to; -1 = not initialized. */
  gen: number;
  buf: ForwardBuffer | null;
  /** Rule A: bucket target, context and running aggregate. */
  bucket: { interval: Interval; ctx: BucketContext } | null;
  /** Time of the newest series bar already emitted (P) or aggregated (A). */
  done: number;
  cur: Bar | null;
  queue: Promise<void>;
}

/**
 * Outermost DataFeed wrapper for market replay. In live mode it is a pure
 * passthrough. In replay mode it hides every bar at or after the clock E (the
 * open time of the first unrevealed tick) from getBars and serves subscriptions
 * from forward buffers as the clock is stepped, never touching the inner feed's
 * live updates. Pure: no timers; the caller drives step().
 *
 * Visibility of a series (S, I) with chart interval C:
 * - Rule P (I <= C): bars are partitioned by the native bars of (S, I); a bar is
 *   visible once closed, i.e. the next native bar's time is <= E.
 * - Rule A (I > C): buckets of the rule-P view of (S, C), like ResamplingFeed.
 */
export class ReplayFeed implements DataFeed {
  /** Incremented on start, seek, stop and clock-moving primary changes. */
  epoch = 0;

  private readonly inner: DataFeed;
  private readonly options: ReplayFeedOptions;
  private readonly now: () => number;
  private _mode: ReplayMode = 'live';
  /** Internal generation: any change that invalidates buffers and subscription state. */
  private gen = 0;
  private primary: SeriesKey | null = null;
  private info: ReplayInfo = { tick: null, warning: null };
  private ticks: ForwardBuffer | null = null;
  private e = NaN;
  private lastTick = NaN;
  private endEmitted = false;
  private readonly buffers = new Map<string, ForwardBuffer>();
  private readonly live = new Set<PassthroughSub>();
  private readonly subs = new Set<ReplaySub>();
  /** Resolves (never rejects) once the pending start/setPrimary has settled. */
  private settled: Promise<void> = Promise.resolve();
  private stepQueue: Promise<unknown> = Promise.resolve();
  // Not the engine Emitter: events.ts is off limits for the node-safe entry
  // (node.test.ts), which re-exports feed/.
  private readonly handlers = new Map<keyof ReplayFeedEvents, Set<(payload: never) => void>>();

  constructor(inner: DataFeed, options: ReplayFeedOptions = {}) {
    this.inner = inner;
    this.options = options;
    this.now = options.now ?? (() => Date.now() / 1000);
  }

  get mode(): ReplayMode {
    return this._mode;
  }

  get clock(): ReplayClock {
    return { last: this.lastTick, next: this.e };
  }

  on<K extends keyof ReplayFeedEvents>(
    event: K,
    handler: (payload: ReplayFeedEvents[K]) => void,
  ): () => void {
    let set = this.handlers.get(event);
    if (set === undefined) {
      set = new Set();
      this.handlers.set(event, set);
    }
    const h = handler as (payload: never) => void;
    set.add(h);
    return () => {
      set.delete(h);
    };
  }

  /**
   * Enter replay (or seek while replaying). Live subscriptions are dropped from
   * the inner feed and muted; callers reload to pick up the clipped history.
   */
  start(opts: ReplayStartOptions): Promise<ReplayInfo> {
    const gen = this.reset();
    this.epoch++;
    if (this._mode === 'live') {
      for (const s of this.live) s.unsubscribe();
      this.live.clear();
    }
    this._mode = 'replay';
    const primary: SeriesKey = {
      symbol: opts.symbol,
      interval: { unit: opts.interval.unit, count: opts.interval.count },
      prepost: opts.prepost,
    };
    this.primary = primary;
    this.info = { tick: null, warning: null };
    // Conservative until the tick buffer answers: nothing after the picked bar.
    this.setClock(opts.lastVisible, opts.lastVisible + 1, false);

    const p = (async (): Promise<ReplayInfo> => {
      const ticks = this.acquire(primary, opts.lastVisible);
      const lv = opts.lastVisible;
      await ticks.ensureAfter(lv);
      if (gen !== this.gen) return this.info;
      const i = ticks.firstAfter(lv);
      const next = ticks.bars[i];
      let e: number;
      if (next !== undefined) {
        e = next.time;
      } else {
        // Picked the newest bar (or past it): reveal everything that exists.
        const last = ticks.bars[i - 1];
        e = Math.max(
          lv + 1,
          last !== undefined ? last.time + intervalSeconds(primary.interval) : 0,
        );
      }
      await ticks.ensureBefore(e);
      if (gen !== this.gen) return this.info;
      this.ticks = ticks;
      const j = ticks.lastBefore(e);
      this.setClock(j >= 0 ? (ticks.bars[j] as Bar).time : lv, e, true);
      return this.info;
    })();
    this.settled = p.then(
      () => undefined,
      () => undefined,
    );
    return p;
  }

  /**
   * Chart symbol or interval changed during replay. Snaps E back to the newest
   * tick of the new series at or before it, so nothing ahead is ever shown (at
   * most one partial tick is lost).
   */
  setPrimary(symbol: string, interval: Interval): Promise<ReplayInfo> {
    const cur = this.primary;
    if (this._mode !== 'replay' || cur === null) return Promise.resolve(this.info);
    if (symbolKey(cur.symbol) === symbolKey(symbol) && intervalsEqual(cur.interval, interval)) {
      return Promise.resolve(this.info);
    }
    const prev = this.settled;
    const gen = this.reset();
    const primary: SeriesKey = {
      symbol,
      interval: { unit: interval.unit, count: interval.count },
      prepost: cur.prepost,
    };
    this.primary = primary;

    const p = (async (): Promise<ReplayInfo> => {
      await prev;
      if (gen !== this.gen) return this.info;
      const e = this.e;
      const ticks = this.acquire(primary, e);
      await ticks.ensureAfter(e, 1);
      await ticks.ensureBefore(e);
      if (gen !== this.gen) return this.info;
      this.ticks = ticks;
      const atE = ticks.bars[ticks.firstAfter(e) - 1];
      const j = ticks.lastBefore(e);
      // New E: the tick at E if there is one, else the newest tick before it.
      const snapped =
        atE !== undefined && atE.time === e ? e : j >= 0 ? (ticks.bars[j] as Bar).time : e;
      if (snapped !== e) this.epoch++;
      const k = ticks.lastBefore(snapped);
      this.setClock(k >= 0 ? (ticks.bars[k] as Bar).time : this.lastTick, snapped, true);
      return this.info;
    })();
    this.settled = p.then(
      () => undefined,
      () => undefined,
    );
    return p;
  }

  /**
   * Reveal the next tick and emit the newly visible bars to every subscription.
   * Resolves 'end' (and emits 'end' once) when nothing is left to reveal.
   */
  step(): Promise<'ok' | 'end'> {
    const p = this.stepQueue.then(() => this.doStep());
    this.stepQueue = p.catch(() => undefined);
    return p;
  }

  /** Leave replay: back to live passthrough. Callers reload and resubscribe. */
  stop(): void {
    if (this._mode === 'live') return;
    this.reset();
    this.epoch++;
    this._mode = 'live';
    this.primary = null;
    this.info = { tick: null, warning: null };
    for (const s of this.subs) s.active = false;
    this.subs.clear();
    this.e = NaN;
    this.lastTick = NaN;
  }

  // ------------------------------------------------------------------ DataFeed

  resolveSymbol(symbol: string): Promise<SymbolInfo> {
    return this.inner.resolveSymbol(symbol);
  }

  searchSymbols(query: string, limit?: number): Promise<SymbolSearchResult[]> {
    return this.inner.searchSymbols(query, limit);
  }

  async getBars(req: GetBarsRequest): Promise<GetBarsResult> {
    if (this._mode === 'live') return this.inner.getBars(req);
    await this.settled;
    // stop() may have run while waiting.
    if (this.mode === 'live') return this.inner.getBars(req);
    const cutoff = await this.cutoff(req.symbol, req.interval, req.prepost ?? false);
    const to = req.to === undefined ? cutoff : Math.min(req.to, cutoff);
    const res = await this.inner.getBars({ ...req, to });
    // Inner wrappers may return bars at or after `to` (ExpressionFeed pads legs).
    return { bars: clipColumns(res.bars, to), hasMore: res.hasMore };
  }

  subscribe(req: SubscribeRequest, lastBar: Bar | null, onBar: BarListener): Unsubscribe {
    if (this._mode === 'live') {
      const s: PassthroughSub = { unsubscribe: this.inner.subscribe(req, lastBar, onBar) };
      this.live.add(s);
      return () => {
        // Already dropped (and unsubscribed) when replay started.
        if (!this.live.delete(s)) return;
        s.unsubscribe();
      };
    }
    const sub: ReplaySub = {
      req: { ...req, interval: { unit: req.interval.unit, count: req.interval.count } },
      onBar,
      lastBar: lastBar ? { ...lastBar } : null,
      active: true,
      gen: -1,
      buf: null,
      bucket: null,
      done: -Infinity,
      cur: null,
      queue: Promise.resolve(),
    };
    this.subs.add(sub);
    queueMicrotask(() => {
      this.runSub(sub).catch(() => {
        // The subscription stays uninitialized; the next step() retries it and
        // rejects with the error.
      });
    });
    return () => {
      if (!sub.active) return;
      sub.active = false;
      this.subs.delete(sub);
      this.release(sub.buf);
      sub.buf = null;
    };
  }

  // ------------------------------------------------------------------ internals

  private emit<K extends keyof ReplayFeedEvents>(event: K, payload: ReplayFeedEvents[K]): void {
    const set = this.handlers.get(event);
    if (set === undefined) return;
    for (const h of [...set]) (h as (p: ReplayFeedEvents[K]) => void)(payload);
  }

  /** Invalidate buffers and subscription state; returns the new generation. */
  private reset(): number {
    this.gen++;
    this.buffers.clear();
    this.ticks = null;
    this.endEmitted = false;
    this.settled = Promise.resolve();
    return this.gen;
  }

  private setClock(last: number, next: number, emit: boolean): void {
    this.lastTick = last;
    this.e = next;
    if (emit) this.emit('clock', this.clock);
  }

  private acquire(series: SeriesKey, anchor: number): ForwardBuffer {
    const key = seriesKey(series);
    let buf = this.buffers.get(key);
    if (buf === undefined) {
      buf = new ForwardBuffer(this.inner, key, series, anchor, this.now);
      this.buffers.set(key, buf);
    }
    buf.refs++;
    return buf;
  }

  private release(buf: ForwardBuffer | null): void {
    if (buf === null) return;
    buf.refs--;
    if (buf.refs <= 0 && this.buffers.get(buf.key) === buf) this.buffers.delete(buf.key);
  }

  /** Rule P applies to intervals up to the chart interval, rule A above it. */
  private bucketTarget(interval: Interval): Interval | null {
    const c = this.primary?.interval;
    if (c === undefined || intervalSeconds(interval) <= intervalSeconds(c)) return null;
    return interval;
  }

  private async contextFor(req: {
    symbol: string;
    timezone?: string | null;
    session?: string | null;
  }): Promise<BucketContext> {
    if (req.timezone !== undefined && req.session !== undefined) {
      return createBucketContext({ timezone: req.timezone, session: req.session });
    }
    const info = await this.inner.resolveSymbol(req.symbol);
    return createBucketContext({
      timezone: req.timezone !== undefined ? req.timezone : info.timezone,
      session: req.session !== undefined ? req.session : info.session,
    });
  }

  /**
   * Bucket start of the newest rule-P bar of `buf` at `e` (rule A), with `ctx`
   * primed from the start of that bar's local day so data-anchored intraday
   * grids match ResamplingFeed. Null if no bar is revealed.
   */
  private async revealedBucket(
    buf: ForwardBuffer,
    e: number,
    target: Interval,
    ctx: BucketContext,
  ): Promise<{ start: number; last: number } | null> {
    await buf.ensureAfter(e, 1);
    await buf.ensureBefore(e);
    const r = lastClosed(buf, e);
    if (r < 0) return null;
    const last = (buf.bars[r] as Bar).time;
    if (isIntraday(target)) {
      const dayStart = ctx.localToUtc(localDay(last, ctx) * DAY);
      await buf.ensureBefore(dayStart);
      for (let i = buf.lastBefore(dayStart) + 1; i < buf.bars.length; i++) {
        const t = (buf.bars[i] as Bar).time;
        if (t >= last) break;
        bucketStart(t, target, ctx);
      }
    }
    return { start: bucketStart(last, target, ctx), last };
  }

  /** Exclusive upper bound on bar times getBars may return for a series. */
  private async cutoff(symbol: string, interval: Interval, prepost: boolean): Promise<number> {
    const e = this.e;
    const primary = this.primary;
    if (primary === null) return e;
    const target = this.bucketTarget(interval);
    if (target === null) {
      const buf = this.acquire({ symbol, interval, prepost }, e);
      try {
        await buf.ensureAfter(e, 1);
        await buf.ensureBefore(e);
        const j = buf.lastBefore(e);
        // A bar partly before E but not closed is still forming: hide it.
        return j >= 0 && buf.barEnd(j) > e ? (buf.bars[j] as Bar).time : e;
      } finally {
        this.release(buf);
      }
    }
    const buf = this.acquire({ symbol, interval: primary.interval, prepost }, e);
    try {
      const ctx = await this.contextFor({ symbol });
      const b = await this.revealedBucket(buf, e, target, ctx);
      return b !== null ? b.start : bucketStart(e, target, ctx);
    } finally {
      this.release(buf);
    }
  }

  private async doStep(): Promise<'ok' | 'end'> {
    if (this._mode !== 'replay') throw new Error('ReplayFeed.step: not in replay mode');
    await this.settled;
    const gen = this.gen;
    const ticks = this.ticks;
    if (ticks === null) throw new Error('ReplayFeed.step: replay is not ready');
    const e = this.e;
    await ticks.ensureAfter(e);
    if (gen !== this.gen) return 'ok';
    // The tick at (or first after) E is revealed; E moves to the one after it.
    const k = ticks.lastBefore(e) + 1;
    const tick = ticks.bars[k];
    if (tick === undefined) {
      if (!this.endEmitted) {
        this.endEmitted = true;
        this.emit('end', undefined);
      }
      return 'end';
    }
    await ticks.ensureAfter(tick.time);
    if (gen !== this.gen) return 'ok';
    const after = ticks.bars[k + 1];
    const primary = this.primary as SeriesKey;
    const next = after !== undefined ? after.time : tick.time + intervalSeconds(primary.interval);
    this.setClock(tick.time, next, true);
    await Promise.all([...this.subs].map((s) => this.runSub(s)));
    return 'ok';
  }

  private runSub(sub: ReplaySub): Promise<void> {
    const p = sub.queue.then(() => this.updateSub(sub));
    sub.queue = p.catch(() => undefined);
    return p;
  }

  private async updateSub(sub: ReplaySub): Promise<void> {
    await this.settled;
    if (!sub.active || this._mode !== 'replay') return;
    const gen = this.gen;
    if (sub.gen !== gen) {
      await this.initSub(sub, gen);
      if (sub.gen !== gen) return;
    }
    await this.advanceSub(sub, gen);
  }

  private async initSub(sub: ReplaySub, gen: number): Promise<void> {
    const primary = this.primary;
    if (primary === null) return;
    this.release(sub.buf);
    sub.buf = null;
    sub.cur = null;
    const e = this.e;
    const { symbol, interval } = sub.req;
    const prepost = sub.req.prepost ?? false;
    const target = this.bucketTarget(interval);
    const buf = this.acquire(
      { symbol, interval: target ? primary.interval : interval, prepost },
      e,
    );
    sub.buf = buf;
    if (target === null) {
      sub.bucket = null;
      await buf.ensureAfter(e, 1);
      await buf.ensureBefore(e);
      if (gen !== this.gen || !sub.active) return;
      const r = lastClosed(buf, e);
      // Catch up from the subscriber's newest bar (a step may have happened between
      // its getBars and subscribe); without one, everything revealed counts as sent.
      // `lastBar` is cleared after the first init, so re-inits never replay history.
      sub.done = sub.lastBar?.time ?? (r >= 0 ? (buf.bars[r] as Bar).time : -Infinity);
    } else {
      const ctx = await this.contextFor(sub.req);
      const b = await this.revealedBucket(buf, e, target, ctx);
      if (b !== null) await buf.ensureBefore(b.start);
      if (gen !== this.gen || !sub.active) return;
      sub.bucket = { interval: target, ctx };
      // Aggregate the forming bucket from its first bar on the first advance.
      const before = b !== null ? buf.lastBefore(b.start) : -1;
      sub.done = before >= 0 ? (buf.bars[before] as Bar).time : -Infinity;
    }
    sub.lastBar = null;
    sub.gen = gen;
  }

  private async advanceSub(sub: ReplaySub, gen: number): Promise<void> {
    const buf = sub.buf;
    if (buf === null) return;
    const e = this.e;
    await buf.ensureAfter(e);
    if (gen !== this.gen || !sub.active) return;
    const last = lastClosed(buf, e);
    const bucket = sub.bucket;
    if (bucket === null) {
      for (let i = buf.firstAfter(sub.done); i <= last && sub.active; i++) {
        const b = buf.bars[i] as Bar;
        sub.done = b.time;
        sub.onBar({ ...b });
      }
      return;
    }
    let dirty = false;
    for (let i = buf.firstAfter(sub.done); i <= last; i++) {
      const b = buf.bars[i] as Bar;
      sub.done = b.time;
      const start = bucketStart(b.time, bucket.interval, bucket.ctx);
      if (sub.cur !== null && start > sub.cur.time) {
        if (dirty && sub.active) sub.onBar({ ...sub.cur });
        sub.cur = null;
        dirty = false;
      }
      if (sub.cur !== null && start < sub.cur.time) continue;
      sub.cur = sub.cur === null ? { ...b, time: start } : merge(sub.cur, b);
      dirty = true;
    }
    if (dirty && sub.active && sub.cur !== null) sub.onBar({ ...sub.cur });
  }
}

function merge(agg: Bar, b: Bar): Bar {
  return {
    time: agg.time,
    open: agg.open,
    high: Math.max(agg.high, b.high),
    low: Math.min(agg.low, b.low),
    close: b.close,
    volume: agg.volume + b.volume,
  };
}
