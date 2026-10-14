/**
 * One evaluated series `symbol|interval|prepost` (docs/alerts.md §3.2-§3.6):
 * symbol resolution, history load, live subscription, close detection, poll
 * fallback, the indicator runtime, the timeline and the drawings cache. Emits
 * samples to its alerts.
 */
import {
  alertBars,
  CloseTracker,
  closeEventTime,
  DrawingLevelError,
  seriesKey,
  type Alert,
  type AlertRuntimeState,
  type DrawingLike,
} from '@investopen/alerts';
import {
  buildTradingCalendar,
  createTzConverter,
  FeedError,
  formatInterval,
  intervalSeconds,
  isIntraday,
  parseInterval,
  tryParseSymbolExpression,
  type AnchorTimeline,
  type Bar,
  type DataFeed,
  type Interval,
  type SymbolInfo,
  type TradingCalendar,
  type Unsubscribe,
} from '@investopen/engine/node';
import {
  getIndicator,
  IndicatorRuntime,
  timeframeInputValue,
  type BarArrays,
} from '@investopen/indicators';
import type { ApiClient } from './api';
import { AlertRunner, type FireJob, type RunnerEnv } from './alert-runner';
import { backoffMs, type Clock } from './clock';
import type { Config } from './config';
import { errText, type Logger } from './log';
import { OperandCache } from './operands';

const WS_SYMBOL_RE = /^[A-Za-z0-9.\-=^]{1,32}$/;
const TRIM = 500;
const PAGE = 5000;
const TF_WARMUP = 300;
const TF_MAX_BARS = 5000;
const RETRY_MIN_MS = 5000;
const RETRY_MAX_MS = 300_000;
const DAY = 86_400;

export type SeriesState = 'idle' | 'loading' | 'ready' | 'retrying' | 'disposed';

/** What a series needs from the service. */
export interface SeriesHost {
  feed: DataFeed;
  api: Pick<ApiClient, 'getDrawings'>;
  clock: Clock;
  log: Logger;
  cfg: Config;
  enqueueFire(job: FireJob): void;
  /** Mark the alert's state dirty (called after every sample). */
  markState(runner: AlertRunner): void;
  /** Saved state of this alert at this revision, if any. */
  savedState(runner: AlertRunner): AlertRuntimeState | null;
  /** Permanent problem (symbol, drawing, indicator): post `status: error`. */
  alertError(alert: Alert, reason: string): void;
  /** `expiresAt` reached: post `status: expired`. */
  alertExpired(alert: Alert): void;
  /** Live socket has been down long enough that the series must be polled. */
  liveDown(): boolean;
  /** Series forced to poll by the 200-symbol cap. */
  overCap(series: Series): boolean;
  onError(message: string): void;
}

/** Resolved timeframe of an indicator input (web `resolveTimeframe`, docs/indicators.md §4). */
export function resolveTimeframe(tf: string, chartInterval: Interval | string): string {
  if (!tf) return '';
  let chart: Interval;
  try {
    chart = typeof chartInterval === 'string' ? parseInterval(chartInterval) : chartInterval;
  } catch {
    return '';
  }
  let target = tf;
  if (tf === 'auto') target = isIntraday(chart) ? '1D' : chart.unit === 'day' ? '1W' : '12M';
  let t: Interval;
  try {
    t = parseInterval(target);
  } catch {
    return '';
  }
  return intervalSeconds(t) <= intervalSeconds(chart) ? '' : formatInterval(t);
}

class Cols {
  time: number[] = [];
  open: number[] = [];
  high: number[] = [];
  low: number[] = [];
  close: number[] = [];
  volume: number[] = [];
  get length(): number {
    return this.time.length;
  }
  push(b: Bar): void {
    this.time.push(b.time);
    this.open.push(b.open);
    this.high.push(b.high);
    this.low.push(b.low);
    this.close.push(b.close);
    this.volume.push(b.volume);
  }
  set(i: number, b: Bar): void {
    this.open[i] = b.open;
    this.high[i] = b.high;
    this.low[i] = b.low;
    this.close[i] = b.close;
    this.volume[i] = b.volume;
  }
  at(i: number): Bar {
    return {
      time: this.time[i]!,
      open: this.open[i]!,
      high: this.high[i]!,
      low: this.low[i]!,
      close: this.close[i]!,
      volume: this.volume[i]!,
    };
  }
  drop(n: number): void {
    for (const k of ['time', 'open', 'high', 'low', 'close', 'volume'] as const)
      this[k].splice(0, n);
  }
  arrays(): BarArrays {
    return {
      time: Float64Array.from(this.time),
      open: Float64Array.from(this.open),
      high: Float64Array.from(this.high),
      low: Float64Array.from(this.low),
      close: Float64Array.from(this.close),
      volume: Float64Array.from(this.volume),
    };
  }
}

function sameBar(a: Bar, b: Bar): boolean {
  return (
    a.open === b.open &&
    a.high === b.high &&
    a.low === b.low &&
    a.close === b.close &&
    a.volume === b.volume
  );
}

function fromColumns(c: {
  time: ArrayLike<number>;
  open: ArrayLike<number>;
  high: ArrayLike<number>;
  low: ArrayLike<number>;
  close: ArrayLike<number>;
  volume: ArrayLike<number>;
}): Bar[] {
  const out: Bar[] = [];
  for (let i = 0; i < c.time.length; i++)
    out.push({
      time: c.time[i]!,
      open: c.open[i]!,
      high: c.high[i]!,
      low: c.low[i]!,
      close: c.close[i]!,
      volume: c.volume[i]!,
    });
  return out;
}

export class Series {
  readonly key: string;
  readonly runners = new Map<string, AlertRunner>();
  state: SeriesState = 'idle';
  lastError: string | null = null;

  private readonly interval: Interval;
  private readonly ivSec: number;
  private info: SymbolInfo | null = null;
  private cols = new Cols();
  private runtime: IndicatorRuntime | null = null;
  private tracker: CloseTracker | null = null;
  private calendar: TradingCalendar | null = null;
  private calendarDay = NaN;
  private readonly cache = new OperandCache();
  private readonly drawings = new Map<string, DrawingLike>();
  private unsub: Unsubscribe | null = null;
  private readonly tfSeries = new Map<string, Unsubscribe | null>();
  private readonly instanceUsers = new Map<string, Set<string>>();
  private gen = 0;
  private chain: Promise<void> = Promise.resolve();
  private window = 0;
  private retryAttempt = 0;
  private retryAt = 0;
  private nextPollAt = 0;
  private polling = false;
  private historyExhausted = false;
  private readonly createdAt: number;
  readonly legs: string[];

  constructor(
    readonly symbol: string,
    readonly intervalStr: string,
    readonly prepost: boolean,
    private readonly host: SeriesHost,
  ) {
    this.key = seriesKey(symbol, intervalStr, prepost);
    this.interval = parseInterval(intervalStr);
    this.ivSec = intervalSeconds(this.interval);
    this.createdAt = host.clock.now();
    const parsed = tryParseSymbolExpression(symbol);
    this.legs = parsed.ok ? parsed.value.symbols : [symbol];
  }

  get order(): number {
    return this.createdAt;
  }
  get ready(): boolean {
    return this.state === 'ready';
  }
  get length(): number {
    return this.cols.length;
  }
  /** Series is polled instead of (or besides) live ticks (§3.6). */
  get polled(): boolean {
    return this.needsPoll();
  }
  /** Distinct live-subscribable symbols of this series. */
  get liveSymbols(): string[] {
    return this.legs.filter((l) => WS_SYMBOL_RE.test(l));
  }
  /** Test hook: last stored bar. */
  lastBar(): Bar | null {
    return this.cols.length ? this.cols.at(this.cols.length - 1) : null;
  }

  // -------------------------------------------------------------- alerts

  addAlert(runner: AlertRunner): void {
    this.runners.set(runner.id, runner);
    if (this.state === 'idle') {
      void this.start();
      return;
    }
    if (this.state !== 'ready') return; // picked up when the load completes
    this.serial(async () => {
      if (this.state !== 'ready') return;
      const need = this.windowFor([runner]);
      if (
        need > this.window ||
        (runner.drawingIds.length && !this.historyExhausted && this.cols.length < need)
      ) {
        await this.load();
        return;
      }
      await this.activate([runner], true);
    });
  }

  removeAlert(id: string): void {
    const r = this.runners.get(id);
    if (!r) return;
    this.runners.delete(id);
    this.releaseInstances(r);
  }

  private releaseInstances(r: AlertRunner): void {
    const rt = this.runtime;
    for (const h of r.instances) {
      const users = this.instanceUsers.get(h.hash);
      users?.delete(r.id);
      if (users && users.size === 0) {
        this.instanceUsers.delete(h.hash);
        rt?.remove(h.hash);
      }
    }
  }

  dispose(): void {
    this.state = 'disposed';
    this.gen++;
    this.unsub?.();
    this.unsub = null;
    for (const u of this.tfSeries.values()) u?.();
    this.tfSeries.clear();
    this.runtime = null;
    this.runners.clear();
  }

  // ------------------------------------------------------------ plumbing

  /** Run `fn` after everything queued before it; errors are logged, never thrown. */
  private serial(fn: () => Promise<void> | void): void {
    const gen = this.gen;
    this.chain = this.chain.then(async () => {
      if (gen !== this.gen) return;
      try {
        await fn();
      } catch (err) {
        this.host.log.error('series task failed', { series: this.key, error: errText(err) });
        this.lastError = errText(err);
        this.host.onError(this.lastError);
      }
    });
  }

  /** Resolves when queued work is done (tests, shutdown). */
  whenIdle(): Promise<void> {
    return this.chain;
  }

  private windowFor(runners: Iterable<AlertRunner>): number {
    let w = 0;
    for (const r of runners)
      w = Math.max(
        w,
        alertBars(r.alert.spec, { maxBars: this.host.cfg.maxBars, intervalSeconds: this.ivSec }),
      );
    return Math.min(this.host.cfg.maxBars, w);
  }

  private hasDrawings(): boolean {
    for (const r of this.runners.values()) if (r.drawingIds.length) return true;
    return false;
  }

  // ---------------------------------------------------------------- load

  async start(): Promise<void> {
    if (this.state === 'disposed') return;
    this.serial(() => this.load());
    await this.chain;
  }

  private async load(): Promise<void> {
    if (this.runners.size === 0) return;
    const gen = ++this.gen;
    this.state = 'loading';
    this.unsub?.();
    this.unsub = null;
    for (const u of this.tfSeries.values()) u?.();
    this.tfSeries.clear();
    this.instanceUsers.clear();
    try {
      const info = await this.host.feed.resolveSymbol(this.symbol);
      if (gen !== this.gen) return;
      this.info = info;
      await this.refreshDrawings();
      if (gen !== this.gen) return;
      const w = Math.max(this.windowFor(this.runners.values()), 50);
      this.window = w;
      const minTime = this.minAnchorTime();
      const cols = await this.loadHistory(w, minTime, gen);
      if (gen !== this.gen || !cols) return;
      this.cols = cols;
      this.buildRuntime(info);
      this.rebuildCalendar();
      this.resetTracker();
      await this.loadTimeframes(gen);
      if (gen !== this.gen) return;
      this.state = 'ready';
      this.retryAttempt = 0;
      this.lastError = null;
      this.cache.clear();
      await this.activate([...this.runners.values()]);
      if (gen !== this.gen) return;
      this.subscribeLive();
      this.nextPollAt = this.host.clock.now() + this.host.cfg.pollMs;
    } catch (err) {
      if (gen !== this.gen) return;
      this.onLoadError(err);
    }
  }

  private onLoadError(err: unknown): void {
    const msg = errText(err);
    const permanent =
      err instanceof RangeError ||
      (err instanceof FeedError && [400, 404, 422].includes(err.status));
    if (permanent) {
      const reason =
        err instanceof FeedError && err.status === 404 ? 'symbol not found' : msg.slice(0, 500);
      this.host.log.warn('series failed permanently', { series: this.key, error: msg });
      for (const r of [...this.runners.values()]) this.failRunner(r, reason);
      this.state = 'idle';
      return;
    }
    this.state = 'retrying';
    this.lastError = msg;
    this.host.onError(msg);
    const delay = backoffMs(this.retryAttempt++, RETRY_MIN_MS, RETRY_MAX_MS);
    this.retryAt = this.host.clock.now() + delay;
    this.host.log.warn('series load failed, retrying', {
      series: this.key,
      error: msg,
      inMs: delay,
    });
  }

  private minAnchorTime(): number | null {
    let min = Infinity;
    for (const r of this.runners.values())
      for (const id of r.drawingIds) {
        const d = this.drawings.get(id);
        for (const p of d?.points ?? []) min = Math.min(min, p.time);
      }
    return Number.isFinite(min) ? min : null;
  }

  private async loadHistory(w: number, minTime: number | null, gen: number): Promise<Cols | null> {
    const cap = minTime !== null ? this.host.cfg.maxDrawingBars : w;
    let bars: Bar[] = [];
    let to: number | undefined;
    this.historyExhausted = false;
    for (;;) {
      const limit = Math.min(PAGE, Math.max(1, (minTime !== null ? cap : w) - bars.length));
      const req: Parameters<DataFeed['getBars']>[0] = {
        symbol: this.symbol,
        interval: this.interval,
        prepost: this.prepost,
        limit,
      };
      if (to !== undefined) req.to = to;
      const res = await this.host.feed.getBars(req);
      if (gen !== this.gen) return null;
      const page = fromColumns(res.bars);
      bars = page.concat(bars);
      if (page.length === 0 || !res.hasMore) {
        this.historyExhausted = true;
        break;
      }
      to = page[0]!.time;
      const enough = bars.length >= w;
      const covered = minTime === null || bars[0]!.time <= minTime - 2 * this.ivSec;
      if ((enough && covered) || bars.length >= cap) break;
    }
    const cols = new Cols();
    for (const b of bars) cols.push(b);
    return cols;
  }

  private buildRuntime(info: SymbolInfo): void {
    const rt = new IndicatorRuntime({
      resolveTimeframe: (tf) => resolveTimeframe(tf, this.interval),
      context: {
        timezone: info.timezone ?? 'UTC',
        session: info.session,
        intervalSeconds: this.ivSec,
      },
    });
    this.runtime = rt;
    for (const r of [...this.runners.values()]) this.addInstances(r);
    rt.setBars(this.cols.arrays());
  }

  /** Add the runner's indicator instances; a failure puts the alert into `error`. */
  private addInstances(r: AlertRunner): boolean {
    const rt = this.runtime;
    if (!rt) return false;
    try {
      const tfs: Record<string, number> = {};
      for (const h of r.instances) {
        const def = getIndicator(h.type);
        if (!def) throw new Error(`unknown indicator '${h.type}'`);
        const tf = resolveTimeframe(timeframeInputValue(def, h.inputs), this.interval);
        if (tf) tfs[tf] = intervalSeconds(parseInterval(tf));
      }
      if (Object.keys(tfs).length) rt.setContext({ timeframeSeconds: tfs });
      for (const h of r.instances) {
        let users = this.instanceUsers.get(h.hash);
        if (!users) {
          rt.add({ id: h.hash, type: h.type, inputs: h.inputs });
          users = new Set();
          this.instanceUsers.set(h.hash, users);
        }
        users.add(r.id);
      }
      return true;
    } catch (err) {
      this.failRunner(r, errText(err).slice(0, 500));
      return false;
    }
  }

  private async loadTimeframes(gen: number): Promise<void> {
    const rt = this.runtime;
    const n = this.cols.length;
    if (!rt || !n) return;
    for (const tf of rt.requiredTimeframes()) {
      if (this.tfSeries.has(tf)) continue;
      this.tfSeries.set(tf, null);
      try {
        const iv = parseInterval(tf);
        const first = this.cols.time[0]!;
        const end = Math.max(this.cols.time[n - 1]!, this.host.clock.now() / 1000);
        const limit = Math.min(
          TF_MAX_BARS,
          Math.ceil((end - first) / intervalSeconds(iv)) + TF_WARMUP,
        );
        const res = await this.host.feed.getBars({
          symbol: this.symbol,
          interval: iv,
          prepost: this.prepost,
          limit,
        });
        if (gen !== this.gen) return;
        const bars = fromColumns(res.bars);
        if (!bars.length) {
          this.tfSeries.delete(tf);
          continue;
        }
        const c = new Cols();
        for (const b of bars) c.push(b);
        rt.setTimeframeBars(tf, c.arrays());
        const info = this.info;
        this.tfSeries.set(
          tf,
          this.host.feed.subscribe(
            {
              symbol: this.symbol,
              interval: iv,
              prepost: this.prepost,
              timezone: info?.timezone ?? null,
              session: info?.session ?? null,
            },
            bars[bars.length - 1]!,
            (b) => this.serial(() => void this.runtime?.updateTimeframeBar(tf, b)),
          ),
        );
      } catch (err) {
        this.tfSeries.delete(tf);
        this.host.log.warn('timeframe load failed', { series: this.key, tf, error: errText(err) });
      }
    }
  }

  private subscribeLive(): void {
    const last = this.cols.length ? this.cols.at(this.cols.length - 1) : null;
    const info = this.info;
    this.unsub = this.host.feed.subscribe(
      {
        symbol: this.symbol,
        interval: this.interval,
        prepost: this.prepost,
        timezone: info?.timezone ?? null,
        session: info?.session ?? null,
      },
      last,
      (b) => this.serial(() => this.processBar(b)),
    );
  }

  // ------------------------------------------------------------- calendar

  private rebuildCalendar(): void {
    const info = this.info;
    const n = this.cols.length;
    const tz = info?.timezone ?? 'UTC';
    const session = this.prepost ? null : (info?.session ?? null);
    this.calendar = n ? buildTradingCalendar(this.cols.time, n, this.interval, tz, session) : null;
    this.calendarDay = n ? this.localDay(this.cols.time[n - 1]!) : NaN;
  }

  private localDay(t: number): number {
    const tz = this.info?.timezone ?? 'UTC';
    return Math.floor(createTzConverter(tz).toLocal(t) / DAY);
  }

  private resetTracker(): void {
    const tracker = new CloseTracker({
      interval: this.interval,
      symbolInfo: this.info,
      prepost: this.prepost,
      graceS: this.host.cfg.closeGraceS,
    });
    const n = this.cols.length;
    if (n) {
      const closed = this.closeAt(n - 1, this.host.cfg.closeGraceS) <= this.host.clock.now();
      tracker.reset(this.cols.time[n - 1]!, closed);
    }
    this.tracker = tracker;
  }

  // ----------------------------------------------------------- env / ops

  private makeEnv(): RunnerEnv {
    const me = (): Series => this;
    const c = this.cols;
    return {
      get info() {
        return me().info as SymbolInfo;
      },
      get length() {
        return c.length;
      },
      get lastClosed() {
        return me().tracker?.closed ?? false;
      },
      time: (i) => c.time[i] ?? NaN,
      open: (i) => c.open[i] ?? NaN,
      high: (i) => c.high[i] ?? NaN,
      low: (i) => c.low[i] ?? NaN,
      close: (i) => c.close[i] ?? NaN,
      volume: (i) => c.volume[i] ?? NaN,
      indicator: (hash, out, i) => me().runtime?.result(hash)?.values[out]?.[i] ?? NaN,
      drawing: (id) => me().drawings.get(id),
      timeline: () => me().timeline(),
      closeAt: (i, grace) => me().closeAt(i, grace),
    };
  }

  private timeline(): AnchorTimeline {
    const n = this.cols.length;
    return {
      time: this.cols.time,
      length: n,
      interval: this.interval,
      bricks: false,
      endTime: n ? this.cols.time[n - 1]! : NaN,
      calendar: this.calendar,
    };
  }

  private closeAt(i: number, graceS: number): number {
    return closeEventTime(
      i,
      { time: this.cols.time, length: this.cols.length },
      this.info,
      this.prepost,
      this.interval,
      graceS,
    );
  }

  // ------------------------------------------------------------- samples

  private failRunner(r: AlertRunner, reason: string): void {
    this.removeAlert(r.id);
    this.host.alertError(r.alert, reason);
  }

  /** Seed runners (restoring state) and give tick modes their first sample. */
  private async activate(runners: AlertRunner[], addInstances = false): Promise<void> {
    const rt = this.runtime;
    if (!rt) return;
    const now = this.host.clock.now();
    const env = this.makeEnv();
    if (addInstances) {
      for (const r of runners) if (this.runners.has(r.id)) this.addInstances(r);
      await this.loadTimeframes(this.gen);
    }
    this.cache.clear();
    const n = this.cols.length;
    for (const r of runners) {
      if (!this.runners.has(r.id)) continue;
      if (this.instanceError(r)) continue;
      try {
        const job = r.seed(env, this.cache, this.host.savedState(r), now);
        if (job) this.fire(r, job);
        else if (n > 0 && r.alert.spec.trigger !== 'oncePerBarClose' && !r.done)
          this.sampleOne(r, env, 'tick', n - 1, now);
      } catch (err) {
        this.runnerFailure(r, err);
      }
      this.host.markState(r);
    }
  }

  private instanceError(r: AlertRunner): boolean {
    const rt = this.runtime;
    if (!rt) return false;
    for (const h of r.instances) {
      const st = rt.status(h.hash);
      if (st?.state === 'error') {
        this.failRunner(r, st.message.slice(0, 500));
        return true;
      }
    }
    return false;
  }

  private runnerFailure(r: AlertRunner, err: unknown): void {
    if (err instanceof DrawingLevelError) this.failRunner(r, err.message);
    else {
      this.host.log.error('alert evaluation failed', {
        alertId: r.id,
        series: this.key,
        error: errText(err),
      });
      this.failRunner(r, `evaluation failed: ${errText(err)}`.slice(0, 500));
    }
  }

  private fire(r: AlertRunner, job: FireJob): void {
    this.host.enqueueFire(job);
    this.host.log.info('alert fired', {
      alertId: r.id,
      series: this.key,
      barTime: job.body.barTime,
    });
  }

  private sampleOne(
    r: AlertRunner,
    env: RunnerEnv,
    kind: 'tick' | 'close',
    i: number,
    now: number,
    eventAt?: number,
  ): void {
    try {
      const job = r.sample(env, this.cache, kind, i, now, eventAt);
      if (job) this.fire(r, job);
    } catch (err) {
      this.runnerFailure(r, err);
      return;
    }
    if (!r.done) this.host.markState(r);
  }

  private emit(kind: 'tick' | 'close', i: number, eventAt?: number): void {
    if (i < 0 || i >= this.cols.length) return;
    const env = this.makeEnv();
    const now = this.host.clock.now();
    for (const r of [...this.runners.values()]) {
      if (r.done) continue;
      if (this.instanceError(r)) continue;
      this.sampleOne(r, env, kind, i, now, eventAt);
    }
  }

  // ---------------------------------------------------------------- bars

  private append(b: Bar): void {
    this.cols.push(b);
    const n = this.cols.length;
    this.runtime?.updateBar(n - 1, b);
    const day = this.localDay(b.time);
    if (day !== this.calendarDay) this.rebuildCalendar();
    const cap = (this.hasDrawings() ? this.host.cfg.maxDrawingBars : this.window) + TRIM;
    if (n > cap) {
      this.cols.drop(TRIM);
      this.runtime?.setBars(this.cols.arrays());
      this.rebuildCalendar();
    }
  }

  private async processBar(b: Bar): Promise<void> {
    const tracker = this.tracker;
    if (this.state !== 'ready' || !tracker) return;
    const now = this.host.clock.now();
    const r = tracker.onBar(b.time, now);
    if (r.kind === 'old') return;
    const n = this.cols.length;
    if (r.kind === 'update') {
      if (n === 0 || this.cols.time[n - 1] !== b.time) return;
      this.cols.set(n - 1, b);
      this.runtime?.updateBar(n - 1, b);
      this.cache.clear();
      if (!tracker.closed) this.emit('tick', n - 1);
      return;
    }
    if (r.closed) await this.closeBar(n - 1, r.closed.at);
    this.append(b);
    this.cache.clear();
    this.emit('tick', this.cols.length - 1);
  }

  /** Refetch the newest 3 bars, take the final values of bar `i`, emit its close sample (§2.4). */
  private async closeBar(i: number, at: number): Promise<void> {
    let full = false;
    try {
      const res = await this.host.feed.getBars({
        symbol: this.symbol,
        interval: this.interval,
        prepost: this.prepost,
        limit: 3,
      });
      for (const fb of fromColumns(res.bars)) {
        const idx = this.indexOfTime(fb.time);
        if (idx < 0 || sameBar(this.cols.at(idx), fb)) continue;
        this.cols.set(idx, fb);
        if (idx === this.cols.length - 1) this.runtime?.updateBar(idx, fb);
        else full = true;
      }
    } catch (err) {
      this.host.log.warn('close refetch failed, using tick values', {
        series: this.key,
        error: errText(err),
      });
    }
    if (full) this.runtime?.setBars(this.cols.arrays());
    this.cache.clear();
    this.emit('close', i, at);
  }

  private indexOfTime(t: number): number {
    for (let i = this.cols.length - 1; i >= 0 && i >= this.cols.length - 10; i--) {
      if (this.cols.time[i] === t) return i;
      if ((this.cols.time[i] ?? 0) < t) break;
    }
    return -1;
  }

  // --------------------------------------------------------------- clock

  /** 1 s clock: expiry, rule-2 close, poll scheduling, retry. */
  onClock(now: number): void {
    for (const r of [...this.runners.values()]) {
      if (!r.done && r.evaluator.isExpired(now)) {
        this.removeAlert(r.id);
        this.host.alertExpired(r.alert);
      }
    }
    if (this.runners.size === 0) return;
    if (this.state === 'retrying' && now >= this.retryAt) {
      this.state = 'loading';
      this.serial(() => this.load());
      return;
    }
    if (this.state !== 'ready' || !this.tracker) return;
    const ev = this.tracker.onClock(now);
    if (ev) {
      const i = this.cols.length - 1;
      this.serial(() => this.closeBar(i, ev.at));
    }
    if (!this.polling && now >= this.nextPollAt && this.needsPoll()) {
      this.polling = true;
      this.nextPollAt = now + this.pollInterval(now);
      this.serial(async () => {
        try {
          await this.pollOnce();
        } finally {
          this.polling = false;
        }
      });
    }
  }

  private needsPoll(): boolean {
    if (this.host.liveDown()) return true;
    if (this.legs.some((l) => !WS_SYMBOL_RE.test(l))) return true;
    return this.host.overCap(this);
  }

  private pollInterval(now: number): number {
    const base = this.host.cfg.pollMs;
    return this.outsideSession(now) ? Math.max(base, 4 * base) : base;
  }

  private outsideSession(now: number): boolean {
    const m = /^(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(this.info?.session?.trim() ?? '');
    const tzName = this.info?.timezone;
    if (!m || !tzName) return false;
    const local = createTzConverter(tzName).toLocal(Math.floor(now / 1000));
    const day = Math.floor(local / DAY);
    const wd = (day + 4) % 7;
    if (wd === 0 || wd === 6) return true;
    const tod = local - day * DAY;
    const start = Number(m[1]) * 3600 + Number(m[2]) * 60;
    const end = Number(m[3]) * 3600 + Number(m[4]) * 60;
    return tod < start || tod >= end;
  }

  private async pollOnce(): Promise<void> {
    if (this.state !== 'ready') return;
    try {
      const res = await this.host.feed.getBars({
        symbol: this.symbol,
        interval: this.interval,
        prepost: this.prepost,
        limit: 3,
      });
      const bars = fromColumns(res.bars);
      const lastT = this.cols.time[this.cols.length - 1] ?? -Infinity;
      let restated = false;
      for (const b of bars) {
        if (b.time >= lastT) continue;
        const idx = this.indexOfTime(b.time);
        if (idx >= 0 && !sameBar(this.cols.at(idx), b)) {
          this.cols.set(idx, b);
          restated = true;
        }
      }
      if (restated) {
        this.runtime?.setBars(this.cols.arrays());
        this.cache.clear();
      }
      for (const b of bars) if (b.time >= lastT) await this.processBar(b);
    } catch (err) {
      const e = errText(err);
      this.lastError = e;
      this.host.onError(e);
      this.host.log.warn('poll failed', { series: this.key, error: e });
      // Keep alerts active; try again after the normal interval.
    }
  }

  // ------------------------------------------------------------ drawings

  /** Refetch the symbol's drawings; referenced ones missing -> alerts error. */
  async refreshDrawings(): Promise<void> {
    const wanted = new Set<string>();
    for (const r of this.runners.values()) for (const id of r.drawingIds) wanted.add(id);
    if (wanted.size === 0) {
      this.drawings.clear();
      return;
    }
    const list = await this.host.api.getDrawings(this.symbol);
    this.drawings.clear();
    for (const d of list)
      if (wanted.has(d.id))
        this.drawings.set(d.id, {
          type: d.data.type,
          points: d.data.points ?? [],
          style: d.data.style ?? {},
        });
    this.cache.clear();
    for (const r of [...this.runners.values()])
      for (const id of r.drawingIds)
        if (!this.drawings.has(id)) {
          this.failRunner(r, 'drawing not found');
          break;
        }
  }

  /** `drawings.changed` naming ids this series references. */
  onDrawingsChanged(ids: readonly string[]): void {
    const refs = new Set<string>();
    for (const r of this.runners.values()) for (const id of r.drawingIds) refs.add(id);
    if (!ids.some((id) => refs.has(id))) return;
    this.serial(async () => {
      try {
        await this.refreshDrawings();
      } catch (err) {
        this.host.log.warn('drawings refresh failed', { series: this.key, error: errText(err) });
      }
    });
  }
}
