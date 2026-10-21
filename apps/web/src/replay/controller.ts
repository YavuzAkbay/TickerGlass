import {
  formatInterval,
  parseInterval,
  type ChartEvents,
  type Interval,
  type ReplayFeed,
  type ReplayInfo,
  type ReplayUpdate,
  type UTCTimestamp,
} from '@tickerglass/engine';
import { REPLAY_SPEEDS, useReplayStore } from './store';

/** The part of ReplayFeed the controller drives. */
export type ReplayFeedLike = Pick<
  ReplayFeed,
  'start' | 'setPrimary' | 'step' | 'stop' | 'on' | 'mode' | 'clock' | 'revealedBar'
>;

/** The part of Chart the controller needs. */
export interface ReplayChart {
  getSymbol(): string;
  getInterval(): string;
  reload(): Promise<void>;
  on<K extends keyof ChartEvents>(event: K, fn: (p: ChartEvents[K]) => void): () => void;
  readonly store: { readonly length: number; readonly time: Float64Array };
}

/** Per-session add-ons driven by the clock (replay alerts, paper trading). */
export interface ReplaySession {
  /** A session starts or restarts (start/seek): drop all state. */
  reset(): void;
  /** The chart shows the start bar: take the first sample without acting on it. */
  prime(): void;
  /** A step revealed more data. */
  step(): void;
  /** Leaving replay, before `reset` (e.g. a summary). */
  end?(): void;
}

export interface ReplayControllerDeps {
  sessions?: readonly ReplaySession[];
  feed: ReplayFeedLike;
  /** The replay chart: pinned from the start until replay ends; owns the clock's symbol and interval. */
  getChart: () => ReplayChart | null;
  /** The other charts of the layout: clipped by the shared feed and reloaded with the replay chart. */
  getOtherCharts: () => readonly ReplayChart[];
  prepost: () => boolean;
  /** User-facing errors (toasts in the app). */
  onError?: (message: string) => void;
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

function parseUpdate(text: string): ReplayUpdate {
  if (text === 'auto' || text === 'bars') return text;
  try {
    return parseInterval(text);
  } catch {
    return 'auto';
  }
}

/**
 * Drives the ReplayFeed from UI actions: start/seek, the play loop, stepping and
 * leaving replay. The chart is reloaded after start/seek/stop, never per step
 * (a reload cancels drawings in progress); steps reach it through the feed.
 */
export class ReplayController {
  private offs: (() => void)[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Bumped by pause/stop/start: stale loop iterations and loads see it and bail out. */
  private generation = 0;
  private readonly onError: (message: string) => void;

  constructor(private readonly deps: ReplayControllerDeps) {
    this.onError = deps.onError ?? ((m) => console.error(m));
  }

  get running(): boolean {
    const s = useReplayStore.getState().status;
    return s === 'loading' || s === 'paused' || s === 'playing' || s === 'ended';
  }

  // ------------------------------------------------------------- picking

  /** Wait for the user to pick the last visible bar (the pick tool lives in the UI). */
  beginPick(): void {
    if (useReplayStore.getState().status === 'loading') return;
    this.clearTimer();
    this.set({ status: 'picking' });
  }

  cancelPick(): void {
    if (useReplayStore.getState().status !== 'picking') return;
    this.set({ status: this.deps.feed.mode === 'replay' ? 'paused' : 'off' });
  }

  // --------------------------------------------------------- start / seek

  /** Enter replay with `lastVisible` as the last visible bar of the chart. */
  async start(lastVisible: number): Promise<void> {
    const chart = this.deps.getChart();
    if (!chart) return;
    const { feed } = this.deps;
    this.clearTimer();
    const gen = ++this.generation;
    this.set({ status: 'loading' });
    this.each((s) => s.reset());
    try {
      const interval = parseInterval(chart.getInterval());
      // Before loading: a symbol or interval change while loading must reach setPrimary.
      this.attach(chart);
      const info = await this.begin(chart, interval, lastVisible as UTCTimestamp);
      if (gen !== this.generation) return;
      this.applyInfo(info);
      await this.reloadAll(chart);
      if (gen !== this.generation) return;
      this.each((s) => s.prime());
      this.set({ status: 'paused' });
    } catch (err) {
      if (gen !== this.generation) return;
      this.onError(`Replay: ${errText(err)}`);
      this.leave(chart, feed.mode === 'replay');
    }
  }

  /** Reload the replay chart and every other chart (their data is clipped to the clock). */
  private reloadAll(chart: ReplayChart): Promise<unknown> {
    return Promise.all([chart, ...this.deps.getOtherCharts()].map((c) => c.reload()));
  }

  /** Move the replay to another bar. Same as start: the feed seeks when already replaying. */
  seek(lastVisible: number): Promise<void> {
    return this.start(lastVisible);
  }

  private async begin(
    chart: ReplayChart,
    interval: Interval,
    lastVisible: UTCTimestamp,
  ): Promise<ReplayInfo> {
    const common = {
      symbol: chart.getSymbol(),
      interval,
      lastVisible,
      prepost: this.deps.prepost(),
    };
    const update = useReplayStore.getState().update;
    try {
      return await this.deps.feed.start({ ...common, update: parseUpdate(update) });
    } catch (err) {
      if (update === 'auto') throw err;
      // The saved update interval does not fit this chart interval.
      this.set({ update: 'auto' });
      return await this.deps.feed.start({ ...common, update: 'auto' });
    }
  }

  // ----------------------------------------------------------- play / step

  play(): void {
    const { status } = useReplayStore.getState();
    if (status !== 'paused') return;
    const gen = ++this.generation;
    this.set({ status: 'playing' });
    void this.tick(gen);
  }

  pause(): void {
    if (useReplayStore.getState().status !== 'playing') return;
    this.generation++;
    this.clearTimer();
    this.set({ status: 'paused' });
  }

  togglePlay(): void {
    if (useReplayStore.getState().status === 'playing') this.pause();
    else this.play();
  }

  /** Reveal one tick (while paused). */
  async step(): Promise<void> {
    if (useReplayStore.getState().status !== 'paused') return;
    const gen = this.generation;
    try {
      const r = await this.deps.feed.step();
      this.afterStep(r, gen);
    } catch (err) {
      if (gen !== this.generation) return;
      this.onError(`Replay: ${errText(err)}`);
    }
  }

  /** One play-loop iteration: wait for the step to finish (backpressure), then the delay. */
  private async tick(gen: number): Promise<void> {
    try {
      const r = await this.deps.feed.step();
      if (!this.afterStep(r, gen)) return;
    } catch (err) {
      if (gen !== this.generation) return;
      this.onError(`Replay: ${errText(err)}`);
      this.generation++;
      this.set({ status: 'paused' });
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick(gen);
    }, useReplayStore.getState().speed);
  }

  /**
   * A feed step completed: session add-ons see every completed step exactly once,
   * even when pause/play/exit moved on meanwhile. Returns whether the caller's loop
   * is still current and should continue.
   */
  private afterStep(r: 'ok' | 'end', gen: number): boolean {
    if (r === 'ok' && this.deps.feed.mode === 'replay') this.each((s) => s.step());
    if (gen !== this.generation) return false;
    if (r === 'end') {
      this.onEnd();
      return false;
    }
    return true;
  }

  private onEnd(): void {
    this.generation++;
    this.clearTimer();
    this.set({ status: 'ended' });
  }

  // ---------------------------------------------------------- speed / update

  setSpeed(ms: number): void {
    if ((REPLAY_SPEEDS as readonly number[]).includes(ms)) this.set({ speed: ms });
  }

  /** Faster: shorter delay per step. */
  speedUp(): void {
    this.shiftSpeed(1);
  }

  speedDown(): void {
    this.shiftSpeed(-1);
  }

  private shiftSpeed(by: number): void {
    const i = (REPLAY_SPEEDS as readonly number[]).indexOf(useReplayStore.getState().speed);
    const next =
      REPLAY_SPEEDS[Math.max(0, Math.min(REPLAY_SPEEDS.length - 1, (i < 0 ? 1 : i) + by))];
    if (next !== undefined) this.set({ speed: next });
  }

  /**
   * Choose the tick interval ('auto', 'bars' or an interval like "5m"). While
   * replaying it restarts at the newest chart bar (the partial bar is revealed whole).
   */
  async setUpdate(text: string): Promise<void> {
    this.set({ update: text });
    const chart = this.deps.getChart();
    if (!chart || this.deps.feed.mode !== 'replay' || !this.running) return;
    const n = chart.store.length;
    if (n === 0) return;
    this.pause();
    await this.start(chart.store.time[n - 1]!);
  }

  // ------------------------------------------------------------------ exit

  /** Back to live data: the chart reloads full history and resubscribes. */
  realtime(): void {
    const chart = this.deps.getChart();
    this.generation++;
    this.clearTimer();
    this.leave(chart, true);
  }

  exit(): void {
    this.realtime();
  }

  /** The chart is going away: stop everything without touching it (no reload). */
  detach(): void {
    if (useReplayStore.getState().status === 'off' && this.offs.length === 0) return;
    this.leave(null, false);
  }

  private leave(chart: ReplayChart | null, reload: boolean): void {
    this.generation++;
    this.clearTimer();
    this.offs.forEach((off) => off());
    this.offs = [];
    this.each((s) => s.end?.());
    this.each((s) => s.reset());
    // Read before the caller unpins the replay chart (status 'off' below).
    const others = reload ? this.deps.getOtherCharts() : [];
    this.deps.feed.stop();
    this.set({ status: 'off', last: NaN, next: NaN, tick: null, warning: null });
    if (reload && chart) {
      for (const c of [chart, ...others])
        c.reload().catch((err: unknown) => this.onError(`Replay: ${errText(err)}`));
    }
  }

  // ---------------------------------------------------------------- wiring

  private attach(chart: ReplayChart): void {
    if (this.offs.length) return;
    const { feed } = this.deps;
    this.offs.push(
      // Sync, before the chart's getBars: layouts and interval changes re-point the clock.
      chart.on('symbolResolved', () => {
        if (feed.mode !== 'replay') return;
        let interval: Interval;
        try {
          interval = parseInterval(chart.getInterval());
        } catch {
          return;
        }
        feed.setPrimary(chart.getSymbol(), interval).then(
          (info) => this.applyInfo(info),
          (err: unknown) => this.onError(`Replay: ${errText(err)}`),
        );
      }),
      feed.on('clock', ({ last, next }) => this.set({ last, next })),
      feed.on('end', () => {
        if (this.running) this.onEnd();
      }),
      feed.on('warning', (warning) => this.set({ warning })),
    );
  }

  private applyInfo(info: ReplayInfo): void {
    const { last, next } = this.deps.feed.clock;
    this.set({
      last,
      next,
      tick: info.tick ? formatInterval(info.tick) : null,
      warning: info.warning,
    });
  }

  /** Run `fn` on every session add-on; one failing never breaks replay. */
  private each(fn: (s: ReplaySession) => void): void {
    for (const s of this.deps.sessions ?? []) {
      try {
        fn(s);
      } catch (err) {
        this.onError(`Replay: ${errText(err)}`);
      }
    }
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private set(patch: Parameters<ReturnType<typeof useReplayStore.getState>['set']>[0]): void {
    useReplayStore.getState().set(patch);
  }
}
