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

/**
 * Intrabar tick intervals, finest first. 90m is left out (as in resampleBase): it
 * has a much shorter history than 60m and divides few chart intervals.
 */
const TICK_CANDIDATES: readonly Interval[] = [
  { unit: 'minute', count: 1 },
  { unit: 'minute', count: 2 },
  { unit: 'minute', count: 5 },
  { unit: 'minute', count: 15 },
  { unit: 'minute', count: 30 },
  { unit: 'hour', count: 1 },
  { unit: 'day', count: 1 },
];
/** At most this many ticks per chart bar (keeps stepping through a bar bearable). */
const MAX_TICKS_PER_BAR = 120;

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
  /** Must be 'auto', 'bars' or one of tickIntervals(interval). */
  update: ReplayUpdate;
  prepost: boolean;
  /** Dividend-adjusted prices, as the chart requests them. */
  adjusted?: boolean;
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

export interface ChooseTickOptions {
  update: ReplayUpdate;
  /** Replay start (E0), unix seconds. */
  start: number;
  /** Current unix time in seconds. */
  now: number;
  lookbackSeconds?: (interval: Interval) => number | null;
}

export interface TickChoice {
  /** Preferred tick interval, or null for whole bars. */
  tick: Interval | null;
  warning: string | null;
  /** Usable tick intervals in order of preference (tick first); empty for whole bars. */
  candidates: Interval[];
}

/**
 * Tick intervals that can drive intrabar replay of `chart` bars: native candidates
 * strictly finer than the chart interval, at most MAX_TICKS_PER_BAR per bar, and
 * for intraday charts dividing the chart interval evenly.
 */
export function tickIntervals(chart: Interval): Interval[] {
  const c = intervalSeconds(chart);
  const out: Interval[] = [];
  for (const t of TICK_CANDIDATES) {
    const s = intervalSeconds(t);
    if (s >= c || c / s > MAX_TICKS_PER_BAR) continue;
    if (isIntraday(chart) && (!isIntraday(t) || (c / 60) % (s / 60) !== 0)) continue;
    out.push({ unit: t.unit, count: t.count });
  }
  return out;
}

function coverageWarning(tick: Interval, lookback: number | null): string {
  if (lookback === null)
    return `No intrabar data for ${formatInterval(tick)}; replaying whole bars.`;
  return `Intrabar data for ${formatInterval(tick)} only covers the last ${Math.floor(lookback / DAY)} days; replaying whole bars.`;
}

/**
 * Pick the tick interval for replaying `chart` bars from `opts.start`: the finest
 * valid interval whose history reaches the start (with a day of margin). Throws
 * if an explicit `update` interval is not valid for the chart interval.
 */
export function chooseTick(chart: Interval, opts: ChooseTickOptions): TickChoice {
  const update = opts.update;
  if (update === 'bars') return { tick: null, warning: null, candidates: [] };
  const valid = tickIntervals(chart);
  let wanted = valid;
  if (update !== 'auto') {
    const hit = valid.find((t) => intervalsEqual(t, update));
    if (hit === undefined) {
      throw new Error(
        `replay: ${formatInterval(update)} is not a valid tick interval for ${formatInterval(chart)}`,
      );
    }
    wanted = [hit];
  }
  const lookback = (t: Interval): number | null => opts.lookbackSeconds?.(t) ?? null;
  const covered = wanted.filter((t) => {
    const lb = lookback(t);
    return lb === null || opts.start >= opts.now - lb + DAY;
  });
  const first = covered[0];
  if (first !== undefined) return { tick: first, warning: null, candidates: covered };
  // Name the coarsest interval: it has the longest history.
  const coarsest = wanted[wanted.length - 1];
  const warning = coarsest !== undefined ? coverageWarning(coarsest, lookback(coarsest)) : null;
  return { tick: null, warning, candidates: [] };
}

interface SeriesKey {
  symbol: string;
  interval: Interval;
  prepost: boolean;
  adjusted: boolean | undefined;
}

function symbolKey(symbol: string): string {
  return symbol.trim().toUpperCase();
}

function seriesKey(k: SeriesKey): string {
  const adj = k.adjusted === undefined ? '' : k.adjusted ? 1 : 0;
  return `${symbolKey(k.symbol)}|${formatInterval(k.interval)}|${k.prepost ? 1 : 0}|${adj}`;
}

function copyInterval(i: Interval): Interval {
  return { unit: i.unit, count: i.count };
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
 * Nominal end of a bar opening at `t`. Months use calendar months (the 30-day
 * nominal length would close a bar before its last days); a start late in a UTC
 * month is an exchange-local 1st east of UTC, so its end is rounded up a day.
 * Never earlier than the real end.
 */
function nominalEnd(t: number, interval: Interval): number {
  if (interval.unit !== 'month') return t + intervalSeconds(interval);
  const d = new Date(t * 1000);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  if (d.getUTCDate() > 15) return Date.UTC(y, m + 1 + interval.count, 1) / 1000 + DAY;
  return Date.UTC(y, m + interval.count, d.getUTCDate()) / 1000 + (t % DAY);
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

function sameBar(a: Bar | null, b: Bar): boolean {
  return (
    a !== null &&
    a.time === b.time &&
    a.open === b.open &&
    a.high === b.high &&
    a.low === b.low &&
    a.close === b.close &&
    a.volume === b.volume
  );
}

/**
 * Bars of one (symbol, interval, prepost, adjusted) series around the replay
 * clock. Grows forward page by page as the clock advances, and backward on
 * demand. Loaded bars are contiguous: every bar in [bars[0].time, hi) is present.
 * Operations are serialized, so concurrent callers never page the same range
 * twice. Callers re-derive indices after every await (backward loads prepend).
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

  /** Time of the first loaded bar with time >= t (or > t if `strict`), else Infinity. */
  timeFrom(t: number, strict = false): number {
    const i = strict ? this.firstAfter(t) : this.lastBefore(t) + 1;
    return this.bars[i]?.time ?? Infinity;
  }

  /**
   * End of bar `i`: the next native bar's time or the bar's nominal end, whichever
   * comes first, so a bar is not held back across its symbol's holidays.
   */
  barEnd(i: number): number {
    const b = this.bars[i] as Bar;
    const end = nominalEnd(b.time, this.series.interval);
    const next = this.bars[i + 1];
    return next !== undefined ? Math.min(next.time, end) : end;
  }

  /**
   * Load until a bar after `t` (at or after it if `inclusive`) is known, or the
   * series has ended; then top up with one more page if fewer than `ahead` bars
   * remain after `t`.
   */
  ensureAfter(t: number, ahead = REFILL_AHEAD, inclusive = false): Promise<void> {
    return this.serial(async () => {
      const from = (): number => (inclusive ? this.lastBefore(t) + 1 : this.firstAfter(t));
      for (let n = 0; !this.ended && from() === this.bars.length; n++) {
        if (n >= MAX_REQUESTS) throw new Error(`replay: no data after ${t} for ${this.key}`);
        await this.pageForward();
      }
      if (!this.ended && this.bars.length - from() < ahead) await this.pageForward();
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
   * Aggregate of the bars in [from, to) with the given bar time, or null if none:
   * open of the first, max high, min low, close of the last, summed volume.
   */
  aggregate(time: number, from: number, to: number): Bar | null {
    let out: Bar | null = null;
    for (let i = this.lastBefore(from) + 1; i < this.bars.length; i++) {
      const b = this.bars[i] as Bar;
      if (b.time >= to) break;
      out = out === null ? { ...b, time } : merge(out, b);
    }
    return out;
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
    const { symbol, interval, prepost, adjusted } = this.series;
    const req: GetBarsRequest = { symbol, interval, prepost, to, limit };
    if (adjusted !== undefined) req.adjusted = adjusted;
    return req;
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.queue.then(fn);
    // Keep the queue alive after a failure; the caller still sees the rejection.
    this.queue = p.catch(() => undefined);
    return p;
  }
}

/** Last closed bar of `buf` at clock `e` (end <= e), or -1. */
function lastClosed(buf: ForwardBuffer, e: number): number {
  const j = buf.lastBefore(e);
  if (j < 0) return -1;
  return buf.barEnd(j) <= e ? j : j - 1;
}

/**
 * Rule-P forming bar of `buf` at `e` built from `ticks`: the native bar partly
 * before E that has not closed, aggregated from its revealed ticks (time < e).
 * Ticks must be loaded from the bar's start (ensureBefore) up to e.
 */
function formingBar(buf: ForwardBuffer, ticks: ForwardBuffer, e: number): Bar | null {
  const j = buf.lastBefore(e);
  if (j < 0 || buf.barEnd(j) <= e) return null;
  const t = (buf.bars[j] as Bar).time;
  return ticks.aggregate(t, t, e);
}

/** Start time of the bar `formingBar` would aggregate, or null if none is forming. */
function formingStart(buf: ForwardBuffer, e: number): number | null {
  const j = buf.lastBefore(e);
  if (j < 0 || buf.barEnd(j) <= e) return null;
  return (buf.bars[j] as Bar).time;
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
  /** Native bars: (S, I) under rule P, (S, C) under rule A. */
  buf: ForwardBuffer | null;
  /** Ticks finer than `buf` when S is the chart symbol in intrabar mode. */
  ticks: ForwardBuffer | null;
  /** Rule A: bucket target and context. */
  bucket: { interval: Interval; ctx: BucketContext } | null;
  /** Time of the newest closed native bar already emitted (P) or aggregated (A). */
  done: number;
  /** Rule A: aggregate of the closed native bars of the current bucket. */
  cur: Bar | null;
  /** Last bar handed to onBar (suppresses identical re-emits). */
  sent: Bar | null;
  queue: Promise<void>;
}

/**
 * Outermost DataFeed wrapper for market replay. In live mode it is a pure
 * passthrough. In replay mode it hides every bar at or after the clock E (the
 * open time of the first unrevealed tick) from getBars and serves subscriptions
 * from forward buffers as the clock is stepped, never touching the inner feed's
 * live updates. Pure: no timers; the caller drives step().
 *
 * Ticks are bars of the chart symbol at the tick interval: the chart interval in
 * bar mode, a finer native interval in intrabar mode (see chooseTick).
 *
 * Visibility of a series (S, I) with chart interval C:
 * - Rule P (I <= C): bars are partitioned by the native bars of (S, I). A bar is
 *   closed once its end (next native bar time, capped at its nominal end) is <= E.
 *   If S has ticks finer than I, the bar partly before E is shown as the
 *   aggregate of its revealed ticks; on rollover the native bar is emitted first
 *   (settle), then the next bar's first aggregate.
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
  private update: ReplayUpdate = 'auto';
  private info: ReplayInfo = { tick: null, warning: null };
  /** Native chart bars (S0, C). */
  private chartBars: ForwardBuffer | null = null;
  /** Clock ticks: (S0, T) in intrabar mode, chartBars in bar mode. */
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
   * Rejects (without changing state) if an explicit `update` interval is invalid.
   */
  start(opts: ReplayStartOptions): Promise<ReplayInfo> {
    const update = opts.update;
    if (
      typeof update === 'object' &&
      !tickIntervals(opts.interval).some((t) => intervalsEqual(t, update))
    ) {
      return Promise.reject(
        new Error(
          `replay: ${formatInterval(update)} is not a valid tick interval for ${formatInterval(opts.interval)}`,
        ),
      );
    }
    const gen = this.reset();
    this.epoch++;
    if (this._mode === 'live') {
      for (const s of this.live) s.unsubscribe();
      this.live.clear();
    }
    this._mode = 'replay';
    const primary: SeriesKey = {
      symbol: opts.symbol,
      interval: copyInterval(opts.interval),
      prepost: opts.prepost,
      adjusted: opts.adjusted,
    };
    this.primary = primary;
    this.update = typeof update === 'object' ? copyInterval(update) : update;
    this.info = { tick: null, warning: null };
    // Conservative until the buffers answer: nothing after the picked bar.
    this.setClock(opts.lastVisible, opts.lastVisible + 1, false);

    const p = (async (): Promise<ReplayInfo> => {
      const lv = opts.lastVisible;
      const bars = this.acquire(primary, lv);
      await bars.ensureAfter(lv);
      if (gen !== this.gen) return this.info;
      const next = bars.timeFrom(lv, true);
      let e: number;
      if (next !== Infinity) {
        e = next;
      } else {
        // Picked the newest bar (or past it): reveal everything that exists.
        const last = bars.bars[bars.firstAfter(lv) - 1];
        e = Math.max(lv + 1, last !== undefined ? nominalEnd(last.time, primary.interval) : 0);
      }
      await bars.ensureBefore(e);
      const pick = await this.pickTicks(primary, e, gen);
      if (pick === null) return this.info;
      const ticks = pick.ticks ?? bars;
      await ticks.ensureBefore(e);
      if (gen !== this.gen) return this.info;
      this.chartBars = bars;
      this.ticks = ticks;
      this.info = { tick: pick.tick, warning: pick.warning };
      const j = ticks.lastBefore(e);
      this.setClock(j >= 0 ? (ticks.bars[j] as Bar).time : lv, e, true);
      if (pick.warning !== null) this.emit('warning', pick.warning);
      return this.info;
    })();
    this.settled = p.then(
      () => undefined,
      () => undefined,
    );
    return p;
  }

  /**
   * Chart symbol or interval changed during replay. Re-picks the tick interval and
   * snaps E back to the newest new tick at or before it, so nothing ahead is ever
   * shown (at most one partial tick is lost). An explicit update interval that
   * does not fit the new chart interval falls back to 'auto'.
   */
  setPrimary(symbol: string, interval: Interval): Promise<ReplayInfo> {
    const cur = this.primary;
    if (this._mode !== 'replay' || cur === null) return Promise.resolve(this.info);
    if (symbolKey(cur.symbol) === symbolKey(symbol) && intervalsEqual(cur.interval, interval)) {
      return Promise.resolve(this.info);
    }
    const prev = this.settled;
    const gen = this.reset();
    const primary: SeriesKey = { ...cur, symbol, interval: copyInterval(interval) };
    this.primary = primary;

    const p = (async (): Promise<ReplayInfo> => {
      await prev;
      if (gen !== this.gen) return this.info;
      const e = this.e;
      const bars = this.acquire(primary, e);
      await bars.ensureAfter(e, 1);
      await bars.ensureBefore(e);
      const pick = await this.pickTicks(primary, e, gen);
      if (pick === null) return this.info;
      const ticks = pick.ticks ?? bars;
      await ticks.ensureAfter(e, 1);
      await ticks.ensureBefore(e);
      if (gen !== this.gen) return this.info;
      this.chartBars = bars;
      this.ticks = ticks;
      this.info = { tick: pick.tick, warning: pick.warning };
      // E' = max{ tau in new ticks : tau <= E } (E itself if there is none).
      const atE = ticks.timeFrom(e) === e;
      const j = ticks.lastBefore(e);
      const snapped = atE ? e : j >= 0 ? (ticks.bars[j] as Bar).time : e;
      if (snapped !== e) this.epoch++;
      const k = ticks.lastBefore(snapped);
      this.setClock(k >= 0 ? (ticks.bars[k] as Bar).time : this.lastTick, snapped, true);
      if (pick.warning !== null) this.emit('warning', pick.warning);
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
    const cutoff = await this.cutoff({
      symbol: req.symbol,
      interval: req.interval,
      prepost: req.prepost ?? false,
      adjusted: req.adjusted,
    });
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
      req: { ...req, interval: copyInterval(req.interval) },
      onBar,
      lastBar: lastBar ? { ...lastBar } : null,
      active: true,
      gen: -1,
      buf: null,
      ticks: null,
      bucket: null,
      done: -Infinity,
      cur: null,
      sent: null,
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
      this.releaseSub(sub);
    };
  }

  // ------------------------------------------------------------------ internals

  /** Invalidate buffers and subscription state; returns the new generation. */
  private reset(): number {
    this.gen++;
    this.buffers.clear();
    this.chartBars = null;
    this.ticks = null;
    this.endEmitted = false;
    this.settled = Promise.resolve();
    return this.gen;
  }

  private emit<K extends keyof ReplayFeedEvents>(event: K, payload: ReplayFeedEvents[K]): void {
    const set = this.handlers.get(event);
    if (set === undefined) return;
    for (const h of [...set]) (h as (p: ReplayFeedEvents[K]) => void)(payload);
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

  private releaseSub(sub: ReplaySub): void {
    this.release(sub.buf);
    this.release(sub.ticks);
    sub.buf = null;
    sub.ticks = null;
  }

  /**
   * Tick buffer for the chart at `e`: the first candidate of chooseTick whose data
   * has a tick in [e, e + chart interval) (availability probe), else whole bars.
   * Null if the generation changed meanwhile.
   */
  private async pickTicks(
    primary: SeriesKey,
    e: number,
    gen: number,
  ): Promise<{
    ticks: ForwardBuffer | null;
    tick: Interval | null;
    warning: string | null;
  } | null> {
    let update = this.update;
    if (typeof update === 'object') {
      const u = update;
      if (!tickIntervals(primary.interval).some((t) => intervalsEqual(t, u))) update = 'auto';
    }
    const lookbackSeconds = this.options.lookbackSeconds;
    const opts: ChooseTickOptions = { update, start: e, now: this.now() };
    if (lookbackSeconds !== undefined) opts.lookbackSeconds = lookbackSeconds;
    const choice = chooseTick(primary.interval, opts);
    let probed: Interval | null = null;
    for (const tick of choice.candidates) {
      const buf = this.acquire({ ...primary, interval: tick }, e);
      await buf.ensureAfter(e, 1, true);
      if (gen !== this.gen) return null;
      if (buf.timeFrom(e) < e + intervalSeconds(primary.interval)) {
        return { ticks: buf, tick, warning: null };
      }
      this.release(buf);
      probed = tick;
    }
    const warning =
      choice.warning ??
      (probed !== null ? coverageWarning(probed, lookbackSeconds?.(probed) ?? null) : null);
    return { ticks: null, tick: null, warning };
  }

  /** Tick buffer series for (S, interval) if S has ticks finer than `interval`. */
  private tickSeries(
    symbol: string,
    interval: Interval,
    prepost: boolean,
    adjusted: boolean | undefined,
  ): SeriesKey | null {
    const primary = this.primary;
    const tick = this.info.tick;
    if (primary === null || tick === null) return null;
    if (symbolKey(symbol) !== symbolKey(primary.symbol)) return null;
    if (intervalSeconds(tick) >= intervalSeconds(interval)) return null;
    return { symbol, interval: tick, prepost, adjusted };
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

  /** Load what the rule-P view of `buf` (with optional `ticks`) needs at `e`. */
  private async loadView(
    buf: ForwardBuffer,
    ticks: ForwardBuffer | null,
    e: number,
  ): Promise<void> {
    await buf.ensureAfter(e, 1);
    await buf.ensureBefore(e);
    if (ticks === null) return;
    await ticks.ensureAfter(e, 1);
    const start = formingStart(buf, e);
    if (start !== null) await ticks.ensureBefore(start);
  }

  /**
   * Bucket start of the newest rule-P bar (closed, or forming with revealed ticks)
   * of `buf` at `e` (rule A), with `ctx` primed from the start of that bar's local
   * day so data-anchored intraday grids match ResamplingFeed. Null if no bar is
   * revealed. Expects loadView(buf, ticks, e) to have run.
   */
  private async revealedBucket(
    buf: ForwardBuffer,
    ticks: ForwardBuffer | null,
    e: number,
    target: Interval,
    ctx: BucketContext,
  ): Promise<{ start: number; last: number } | null> {
    const forming = ticks !== null ? formingBar(buf, ticks, e) : null;
    const r = lastClosed(buf, e);
    const last = forming?.time ?? (r >= 0 ? (buf.bars[r] as Bar).time : null);
    if (last === null) return null;
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
  private async cutoff(series: SeriesKey): Promise<number> {
    const e = this.e;
    const primary = this.primary;
    if (primary === null) return e;
    const { symbol, interval, prepost, adjusted } = series;
    const target = this.bucketTarget(interval);
    if (target === null) {
      const buf = this.acquire(series, e);
      try {
        await buf.ensureAfter(e, 1);
        await buf.ensureBefore(e);
        // A bar partly before E but not closed is still forming: hide it (its
        // revealed part, if any, comes from subscriptions).
        return formingStart(buf, e) ?? e;
      } finally {
        this.release(buf);
      }
    }
    const buf = this.acquire({ ...series, interval: primary.interval }, e);
    const tickKey = this.tickSeries(symbol, primary.interval, prepost, adjusted);
    const ticks = tickKey !== null ? this.acquire(tickKey, e) : null;
    try {
      const ctx = await this.contextFor({ symbol });
      await this.loadView(buf, ticks, e);
      const b = await this.revealedBucket(buf, ticks, e, target, ctx);
      return b !== null ? b.start : bucketStart(e, target, ctx);
    } finally {
      this.release(buf);
      this.release(ticks);
    }
  }

  private async doStep(): Promise<'ok' | 'end'> {
    if (this._mode !== 'replay') throw new Error('ReplayFeed.step: not in replay mode');
    await this.settled;
    const gen = this.gen;
    const bars = this.chartBars;
    const ticks = this.ticks;
    const primary = this.primary;
    if (bars === null || ticks === null || primary === null) {
      throw new Error('ReplayFeed.step: replay is not ready');
    }
    const e = this.e;
    await bars.ensureAfter(e, REFILL_AHEAD, true);
    if (ticks !== bars) await ticks.ensureAfter(e, REFILL_AHEAD, true);
    const c = bars.timeFrom(e);
    if (c !== Infinity) await bars.ensureAfter(c);
    if (gen !== this.gen) return 'ok';
    // Reveal the next tick; a chart bar without ticks is revealed whole, as one step.
    const t = ticks.timeFrom(e);
    const cNext = bars.timeFrom(c, true);
    const u = c < t && !(t < cNext) ? c : t;
    if (u === Infinity) {
      if (!this.endEmitted) {
        this.endEmitted = true;
        this.emit('end', undefined);
      }
      return 'end';
    }
    await ticks.ensureAfter(u);
    if (ticks !== bars) await bars.ensureAfter(u);
    if (gen !== this.gen) return 'ok';
    let next = Math.min(ticks.timeFrom(u, true), bars.timeFrom(u, true));
    if (next === Infinity) {
      // Newest data: reveal the last tick and close the last chart bar.
      const lastBar = bars.bars[bars.firstAfter(u) - 1];
      const tickIv = this.info.tick ?? primary.interval;
      next = Math.max(
        nominalEnd(u, tickIv),
        lastBar !== undefined ? nominalEnd(lastBar.time, primary.interval) : u + 1,
      );
    }
    this.setClock(u, next, true);
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
    this.releaseSub(sub);
    sub.cur = null;
    const e = this.e;
    const { symbol, interval } = sub.req;
    const prepost = sub.req.prepost ?? false;
    const adjusted = sub.req.adjusted;
    const target = this.bucketTarget(interval);
    const native = target !== null ? primary.interval : interval;
    const buf = this.acquire({ symbol, interval: native, prepost, adjusted }, e);
    const tickKey = this.tickSeries(symbol, native, prepost, adjusted);
    const ticks = tickKey !== null ? this.acquire(tickKey, e) : null;
    sub.buf = buf;
    sub.ticks = ticks;
    await this.loadView(buf, ticks, e);
    if (target === null) {
      if (gen !== this.gen || !sub.active) return;
      sub.bucket = null;
      const r = lastClosed(buf, e);
      // Catch up from the subscriber's newest bar (a step may have happened between
      // its getBars and subscribe); without one, everything closed counts as sent.
      // `lastBar` is cleared after the first init, so re-inits never replay history.
      sub.done = sub.lastBar?.time ?? (r >= 0 ? (buf.bars[r] as Bar).time : -Infinity);
    } else {
      const ctx = await this.contextFor(sub.req);
      const b = await this.revealedBucket(buf, ticks, e, target, ctx);
      if (b !== null) await buf.ensureBefore(b.start);
      if (gen !== this.gen || !sub.active) return;
      sub.bucket = { interval: target, ctx };
      // Aggregate the current bucket from its first bar on the first advance.
      const before = b !== null ? buf.lastBefore(b.start) : -1;
      sub.done = before >= 0 ? (buf.bars[before] as Bar).time : -Infinity;
    }
    sub.lastBar = null;
    sub.sent = null;
    sub.gen = gen;
  }

  private emitTo(sub: ReplaySub, bar: Bar): void {
    if (!sub.active || sameBar(sub.sent, bar)) return;
    sub.sent = { ...bar };
    sub.onBar({ ...bar });
  }

  private async advanceSub(sub: ReplaySub, gen: number): Promise<void> {
    const buf = sub.buf;
    if (buf === null) return;
    const ticks = sub.ticks;
    const e = this.e;
    await buf.ensureAfter(e);
    if (ticks !== null) {
      await ticks.ensureAfter(e);
      const start = formingStart(buf, e);
      if (start !== null) await ticks.ensureBefore(start);
    }
    if (gen !== this.gen || !sub.active) return;
    const last = lastClosed(buf, e);
    const forming = ticks !== null ? formingBar(buf, ticks, e) : null;
    const bucket = sub.bucket;
    if (bucket === null) {
      // Settle closed native bars first, then show the forming one.
      for (let i = buf.firstAfter(sub.done); i <= last; i++) {
        const b = buf.bars[i] as Bar;
        sub.done = b.time;
        this.emitTo(sub, b);
      }
      if (forming !== null) this.emitTo(sub, forming);
      return;
    }
    for (let i = buf.firstAfter(sub.done); i <= last; i++) {
      const b = buf.bars[i] as Bar;
      sub.done = b.time;
      const start = bucketStart(b.time, bucket.interval, bucket.ctx);
      if (sub.cur !== null && start > sub.cur.time) {
        this.emitTo(sub, sub.cur);
        sub.cur = null;
      }
      if (sub.cur !== null && start < sub.cur.time) continue;
      sub.cur = sub.cur === null ? { ...b, time: start } : merge(sub.cur, b);
    }
    let out = sub.cur;
    if (forming !== null) {
      const fb = bucketStart(forming.time, bucket.interval, bucket.ctx);
      if (sub.cur !== null && fb > sub.cur.time) {
        this.emitTo(sub, sub.cur);
        sub.cur = null;
      }
      out = sub.cur !== null ? merge(sub.cur, forming) : { ...forming, time: fb };
    }
    if (out !== null) this.emitTo(sub, out);
  }
}
