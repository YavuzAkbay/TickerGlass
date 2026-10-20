import type { ChartEvents, ReplayInfo, ReplayStartOptions } from '@investopen/engine';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReplayController, type ReplayChart, type ReplayFeedLike } from './controller';
import { DEFAULT_SPEED, useReplayStore } from './store';

type Handler = (p: never) => void;

class FakeFeed implements ReplayFeedLike {
  mode: 'live' | 'replay' = 'live';
  clock = { last: NaN, next: NaN } as ReplayFeedLike['clock'];
  startCalls: ReplayStartOptions[] = [];
  primaryCalls: [string, string][] = [];
  stepCalls = 0;
  stops = 0;
  /** Steps left before 'end'. */
  stepsLeft = 100;
  /** Resolvers of in-flight steps when `manual` is set. */
  manual = false;
  pending: (() => void)[] = [];
  inFlight = 0;
  maxInFlight = 0;
  rejectStart: Error | null = null;
  /** Holds `start` open (loading) until resolved. */
  gate: Promise<void> | null = null;
  info: ReplayInfo = { tick: { unit: 'minute', count: 1 }, warning: null };
  private handlers = new Map<string, Set<Handler>>();

  async start(opts: ReplayStartOptions): Promise<ReplayInfo> {
    this.startCalls.push(opts);
    if (this.rejectStart && typeof opts.update === 'object') throw this.rejectStart;
    this.mode = 'replay';
    if (this.gate) await this.gate;
    this.clock = { last: opts.lastVisible, next: opts.lastVisible + 60 } as typeof this.clock;
    return this.info;
  }
  async setPrimary(symbol: string, interval: { unit: string; count: number }): Promise<ReplayInfo> {
    this.primaryCalls.push([symbol, `${interval.count}${interval.unit}`]);
    return this.info;
  }
  step(): Promise<'ok' | 'end'> {
    this.stepCalls++;
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    const finish = (): 'ok' | 'end' => {
      this.inFlight--;
      if (this.stepsLeft <= 0) {
        this.emit('end', undefined);
        return 'end';
      }
      this.stepsLeft--;
      this.clock = { last: this.clock.next, next: this.clock.next + 60 } as typeof this.clock;
      this.emit('clock', this.clock);
      return 'ok';
    };
    if (!this.manual) return Promise.resolve(finish());
    return new Promise((resolve) => this.pending.push(() => resolve(finish())));
  }
  revealedBar(): null {
    return null;
  }
  stop(): void {
    this.stops++;
    this.mode = 'live';
  }
  on(event: string, handler: Handler): () => void {
    const set = this.handlers.get(event) ?? new Set();
    this.handlers.set(event, set);
    set.add(handler);
    return () => set.delete(handler);
  }
  emit(event: string, payload: unknown): void {
    for (const h of this.handlers.get(event) ?? []) h(payload as never);
  }
  listenerCount(): number {
    let n = 0;
    for (const s of this.handlers.values()) n += s.size;
    return n;
  }
}

class FakeChart implements ReplayChart {
  symbol = 'AAPL';
  interval = '5m';
  reloads = 0;
  store = { length: 3, time: Float64Array.from([60, 120, 180]) };
  private resolved = new Set<(p: never) => void>();
  getSymbol() {
    return this.symbol;
  }
  getInterval() {
    return this.interval;
  }
  async reload(): Promise<void> {
    this.reloads++;
  }
  on<K extends keyof ChartEvents>(event: K, fn: (p: ChartEvents[K]) => void): () => void {
    if (event !== 'symbolResolved') return () => undefined;
    this.resolved.add(fn as (p: never) => void);
    return () => this.resolved.delete(fn as (p: never) => void);
  }
  resolve(): void {
    for (const fn of this.resolved) fn({} as never);
  }
  listeners(): number {
    return this.resolved.size;
  }
}

function setup() {
  const feed = new FakeFeed();
  const chart = new FakeChart();
  const onError = vi.fn();
  const ctl = new ReplayController({ feed, getChart: () => chart, prepost: () => false, onError });
  return { feed, chart, ctl, onError };
}

const status = () => useReplayStore.getState().status;
/** Let promise continuations run (fake timers do not touch the microtask queue). */
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

beforeEach(() => {
  vi.useFakeTimers();
  useReplayStore.setState({
    status: 'off',
    last: NaN,
    next: NaN,
    tick: null,
    warning: null,
    speed: DEFAULT_SPEED,
    update: 'auto',
  });
});
afterEach(() => vi.useRealTimers());

describe('ReplayController', () => {
  it('start loads through the feed, reloads the chart once and pauses', async () => {
    const { feed, chart, ctl } = setup();
    const p = ctl.start(1000);
    expect(status()).toBe('loading');
    await p;
    expect(status()).toBe('paused');
    expect(feed.startCalls).toHaveLength(1);
    expect(feed.startCalls[0]).toMatchObject({
      symbol: 'AAPL',
      interval: { unit: 'minute', count: 5 },
      lastVisible: 1000,
      update: 'auto',
      prepost: false,
    });
    expect(chart.reloads).toBe(1);
    expect(useReplayStore.getState()).toMatchObject({ last: 1000, next: 1060, tick: '1m' });
  });

  it('passes the saved update interval and falls back to auto when it does not fit', async () => {
    const { feed, ctl } = setup();
    useReplayStore.setState({ update: '1m' });
    await ctl.start(1000);
    expect(feed.startCalls[0]!.update).toEqual({ unit: 'minute', count: 1 });

    useReplayStore.setState({ update: '3m' });
    feed.rejectStart = new Error('invalid');
    await ctl.start(1000);
    expect(feed.startCalls.at(-1)!.update).toBe('auto');
    expect(useReplayStore.getState().update).toBe('auto');
    expect(status()).toBe('paused');
  });

  it('a failed start leaves replay with an error and no reload loop', async () => {
    const { feed, chart, ctl, onError } = setup();
    feed.start = () => Promise.reject(new Error('boom'));
    await ctl.start(1000);
    expect(status()).toBe('off');
    expect(onError).toHaveBeenCalledWith('Replay: boom');
    expect(chart.reloads).toBe(0);
  });

  it('plays one step per delay without reloading the chart', async () => {
    const { feed, chart, ctl } = setup();
    await ctl.start(1000);
    ctl.play();
    expect(status()).toBe('playing');
    await flush();
    expect(feed.stepCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(DEFAULT_SPEED - 1);
    expect(feed.stepCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(feed.stepCalls).toBe(2);
    await vi.advanceTimersByTimeAsync(3 * DEFAULT_SPEED);
    expect(feed.stepCalls).toBe(5);
    expect(chart.reloads).toBe(1);
    expect(useReplayStore.getState().last).toBe(1000 + 5 * 60);
  });

  it('applies speed changes to the next delay', async () => {
    const { feed, ctl } = setup();
    await ctl.start(1000);
    ctl.play();
    await flush();
    ctl.setSpeed(30);
    await vi.advanceTimersByTimeAsync(DEFAULT_SPEED);
    expect(feed.stepCalls).toBe(2);
    await vi.advanceTimersByTimeAsync(30);
    expect(feed.stepCalls).toBe(3);
    ctl.setSpeed(12345); // not a known speed: ignored
    expect(useReplayStore.getState().speed).toBe(30);
  });

  it('speedUp / speedDown walk the speed table and clamp', async () => {
    const { ctl } = setup();
    const speed = () => useReplayStore.getState().speed;
    ctl.speedUp();
    expect(speed()).toBe(500);
    for (let i = 0; i < 10; i++) ctl.speedUp();
    expect(speed()).toBe(30);
    for (let i = 0; i < 10; i++) ctl.speedDown();
    expect(speed()).toBe(3000);
  });

  it('never overlaps steps: a slow step holds the loop (backpressure)', async () => {
    const { feed, ctl } = setup();
    await ctl.start(1000);
    feed.manual = true;
    ctl.play();
    await flush();
    expect(feed.stepCalls).toBe(1);
    // Far longer than the delay: the step has not resolved, so no second step starts.
    await vi.advanceTimersByTimeAsync(10 * DEFAULT_SPEED);
    expect(feed.stepCalls).toBe(1);
    feed.pending.shift()!();
    await flush();
    expect(feed.stepCalls).toBe(1); // the delay starts only now
    await vi.advanceTimersByTimeAsync(DEFAULT_SPEED);
    expect(feed.stepCalls).toBe(2);
    expect(feed.maxInFlight).toBe(1);
  });

  it('pause stops the loop, also while a step is in flight', async () => {
    const { feed, ctl } = setup();
    await ctl.start(1000);
    ctl.play();
    await flush();
    ctl.pause();
    expect(status()).toBe('paused');
    await vi.advanceTimersByTimeAsync(5 * DEFAULT_SPEED);
    expect(feed.stepCalls).toBe(1);

    feed.manual = true;
    ctl.play();
    await flush();
    expect(feed.stepCalls).toBe(2);
    ctl.pause();
    feed.pending.shift()!();
    await flush();
    await vi.advanceTimersByTimeAsync(5 * DEFAULT_SPEED);
    expect(feed.stepCalls).toBe(2);
    expect(status()).toBe('paused');
  });

  it('step reveals one tick while paused and is ignored while playing', async () => {
    const { feed, ctl } = setup();
    await ctl.start(1000);
    await ctl.step();
    expect(feed.stepCalls).toBe(1);
    expect(useReplayStore.getState().last).toBe(1060);
    ctl.play();
    await flush();
    const n = feed.stepCalls;
    await ctl.step();
    expect(feed.stepCalls).toBe(n);
  });

  it('end of data ends playback and then stepping does nothing', async () => {
    const { feed, ctl } = setup();
    feed.stepsLeft = 2;
    await ctl.start(1000);
    ctl.play();
    await flush();
    await vi.advanceTimersByTimeAsync(5 * DEFAULT_SPEED);
    expect(status()).toBe('ended');
    expect(feed.stepCalls).toBe(3);
    await vi.advanceTimersByTimeAsync(5 * DEFAULT_SPEED);
    expect(feed.stepCalls).toBe(3);
    await ctl.step();
    expect(feed.stepCalls).toBe(3);
    ctl.play(); // not paused: no-op
    expect(status()).toBe('ended');
  });

  it('a manual step reaching the end sets ended', async () => {
    const { feed, ctl } = setup();
    feed.stepsLeft = 0;
    await ctl.start(1000);
    await ctl.step();
    expect(status()).toBe('ended');
  });

  it('seek restarts at another bar and stops playing', async () => {
    const { feed, chart, ctl } = setup();
    await ctl.start(1000);
    ctl.play();
    await flush();
    await ctl.seek(500);
    expect(status()).toBe('paused');
    expect(feed.startCalls.at(-1)!.lastVisible).toBe(500);
    expect(chart.reloads).toBe(2);
    const n = feed.stepCalls;
    await vi.advanceTimersByTimeAsync(5 * DEFAULT_SPEED);
    expect(feed.stepCalls).toBe(n);
    expect(chart.listeners()).toBe(1); // not subscribed twice
  });

  it('realtime stops the feed, reloads once and releases listeners', async () => {
    const { feed, chart, ctl } = setup();
    await ctl.start(1000);
    ctl.play();
    await flush();
    ctl.realtime();
    expect(status()).toBe('off');
    expect(feed.stops).toBe(1);
    await flush();
    expect(chart.reloads).toBe(2);
    expect(chart.listeners()).toBe(0);
    expect(feed.listenerCount()).toBe(0);
    const n = feed.stepCalls;
    await vi.advanceTimersByTimeAsync(5 * DEFAULT_SPEED);
    expect(feed.stepCalls).toBe(n);
    expect(useReplayStore.getState().last).toBeNaN();
  });

  it('exit during loading wins over the pending start', async () => {
    const { feed, chart, ctl } = setup();
    const p = ctl.start(1000);
    ctl.exit();
    await p;
    expect(status()).toBe('off');
    expect(feed.stops).toBe(1);
    expect(chart.reloads).toBeLessThanOrEqual(1);
  });

  it('re-points the feed when the chart symbol or interval changes during replay', async () => {
    const { feed, chart, ctl } = setup();
    chart.resolve(); // not replaying yet: ignored
    expect(feed.primaryCalls).toHaveLength(0);
    await ctl.start(1000);
    chart.symbol = 'MSFT';
    chart.interval = '1h';
    chart.resolve();
    expect(feed.primaryCalls).toEqual([['MSFT', '1hour']]);
    // Back to live: ignored and unsubscribed.
    ctl.exit();
    chart.resolve();
    expect(feed.primaryCalls).toHaveLength(1);
  });

  it('mirrors clock and warning events into the store', async () => {
    const { feed, ctl } = setup();
    await ctl.start(1000);
    feed.emit('warning', 'only whole bars');
    expect(useReplayStore.getState().warning).toBe('only whole bars');
    feed.emit('clock', { last: 7, next: 9 });
    expect(useReplayStore.getState()).toMatchObject({ last: 7, next: 9 });
  });

  it('picking: beginPick/cancelPick return to the previous state', async () => {
    const { ctl } = setup();
    ctl.beginPick();
    expect(status()).toBe('picking');
    ctl.cancelPick();
    expect(status()).toBe('off');
    await ctl.start(1000);
    ctl.beginPick();
    expect(status()).toBe('picking');
    ctl.cancelPick();
    expect(status()).toBe('paused');
  });

  it('changing the update interval while replaying restarts at the newest chart bar', async () => {
    const { feed, ctl } = setup();
    await ctl.start(1000);
    await ctl.setUpdate('bars');
    expect(useReplayStore.getState().update).toBe('bars');
    expect(feed.startCalls.at(-1)).toMatchObject({ update: 'bars', lastVisible: 180 });
    expect(status()).toBe('paused');
  });

  it('drives session add-ons: reset, prime after load, step per step, end then reset on exit', async () => {
    const feed = new FakeFeed();
    const chart = new FakeChart();
    const calls: string[] = [];
    const session = {
      reset: () => calls.push('reset'),
      prime: () => calls.push('prime'),
      step: () => calls.push('step'),
      end: () => calls.push('end'),
    };
    const ctl = new ReplayController({
      feed,
      getChart: () => chart,
      prepost: () => false,
      sessions: [session],
    });
    await ctl.start(1000);
    expect(calls).toEqual(['reset', 'prime']);
    await ctl.step();
    ctl.play();
    await flush();
    expect(calls.slice(2)).toEqual(['step', 'step']);
    ctl.exit();
    expect(calls.slice(-2)).toEqual(['end', 'reset']);
  });

  it('a symbol change while loading reaches setPrimary', async () => {
    const { feed, chart, ctl } = setup();
    let release!: () => void;
    feed.gate = new Promise((r) => (release = r));
    const p = ctl.start(1000);
    await flush();
    expect(status()).toBe('loading');
    chart.symbol = 'MSFT';
    chart.resolve();
    expect(feed.primaryCalls).toEqual([['MSFT', '5minute']]);
    release();
    await p;
    expect(status()).toBe('paused');
  });

  it('detach (chart unmount) stops the loop and listeners without reloading; replay can start again', async () => {
    const { feed, chart, ctl } = setup();
    await ctl.start(1000);
    ctl.play();
    await flush();
    const reloads = chart.reloads;
    const steps = feed.stepCalls;
    ctl.detach();
    expect(status()).toBe('off');
    expect(feed.stops).toBe(1);
    expect(chart.listeners()).toBe(0);
    expect(feed.listenerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5 * DEFAULT_SPEED);
    expect(feed.stepCalls).toBe(steps);
    expect(chart.reloads).toBe(reloads);
    // A remounted chart attaches again.
    await ctl.start(1000);
    expect(chart.listeners()).toBe(1);
    expect(status()).toBe('paused');
    ctl.detach();
    ctl.detach(); // idempotent
    expect(feed.stops).toBe(2);
  });

  it('every completed feed step reaches the sessions exactly once, also when play() interleaves', async () => {
    const feed = new FakeFeed();
    const chart = new FakeChart();
    const step = vi.fn();
    const ctl = new ReplayController({
      feed,
      getChart: () => chart,
      prepost: () => false,
      sessions: [{ reset: () => undefined, prime: () => undefined, step }],
    });
    await ctl.start(1000);
    feed.manual = true;
    const manual = ctl.step(); // in flight
    await flush();
    ctl.play(); // bumps the generation while the manual step is pending
    await flush();
    expect(feed.stepCalls).toBe(2);
    feed.pending.shift()!(); // the manual step completes
    await manual;
    await flush();
    expect(step).toHaveBeenCalledTimes(1);
    feed.pending.shift()!(); // the loop's step completes
    await flush();
    expect(step).toHaveBeenCalledTimes(2);
    ctl.pause();
    expect(feed.stepCalls).toBe(2);
  });
});
