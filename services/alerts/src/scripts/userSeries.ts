/**
 * The user-script instances of one series. They live in the script isolates
 * (one runtime per series inside each), not in the series' built-in
 * `IndicatorRuntime`: scripts are leaves (they read only the series' own bars
 * and nothing reads them). The plot values the isolate returns are cached
 * here, so reading an operand never crosses into the isolate.
 */
import { scriptIdOf, type BarInput } from '@tickerglass/indicators/core';
import { errText } from '../log';
import {
  ScriptCallError,
  ScriptStrike,
  ScriptSuperseded,
  ScriptUnavailable,
  type ScriptHost,
} from './host';
import type { CheckResult, Columns, InstanceReq, SeriesContext, SeriesResult } from './protocol';

/** Live bars the Check feeds as ticks (same as the editor's Check). */
const CHECK_LIVE_BARS = 50;

interface ScriptState {
  epoch: number;
  hashes: Set<string>;
  /** The instances, to rebuild the series' state in the isolate. */
  insts: Map<string, InstanceReq>;
  /** Bars the isolate holds for this series (as of the last call that reached it). */
  synced: number;
  /** A live update timed out: the state in the isolate may be half-written, rebuild it before use. */
  stale: boolean;
  /** The newest live update that could not go out at once, to send when the isolate is free. */
  pending: { index: number; bar: BarInput; full: boolean } | null;
  flushing: Promise<void> | null;
}

export interface UserSeriesSource {
  /** Current bars as columns (copies the host may keep). */
  columns(): Columns;
  context(): SeriesContext;
  /** Open time of bar `i` (messages). */
  time(i: number): number;
  /** Number of bars the series holds now (the bound of every range the isolate may return). */
  length(): number;
}

export class UserSeries {
  private readonly states = new Map<string, ScriptState>();
  private readonly scriptOf = new Map<string, string>();
  private readonly values = new Map<string, Map<string, number[]>>();
  /** Last error of each instance's computation (script threw, script unavailable for good). */
  private readonly runErrors = new Map<string, string>();
  /** Instances whose script is out for now (fault hold, isolate replaced): why. Not an error. */
  private readonly holds = new Map<string, string>();
  /** Instances whose Check failed. */
  private readonly checkErrors = new Map<string, string>();
  /** Bumped by `reset`: an operation that finds it changed after an await drops its result. */
  private gen = 0;
  /** Full recomputes under way (`setBars`). */
  private readonly running = new Set<Promise<void>>();

  constructor(
    private readonly key: string,
    private readonly scripts: ScriptHost,
    private readonly src: UserSeriesSource,
  ) {}

  get size(): number {
    return this.scriptOf.size;
  }

  has(hash: string): boolean {
    return this.scriptOf.has(hash);
  }

  /** Script ids with instances here. */
  scriptIds(): string[] {
    return [...this.states.keys()];
  }

  value(hash: string, outputId: string, i: number): number {
    return this.values.get(hash)?.get(outputId)?.[i] ?? NaN;
  }

  /** Why the instance cannot give values for good, or null. */
  error(hash: string): string | null {
    return this.checkErrors.get(hash) ?? this.runErrors.get(hash) ?? null;
  }

  /** Why the instance cannot give values for now (its alerts wait), or null. */
  held(hash: string): string | null {
    return this.holds.get(hash) ?? null;
  }

  /**
   * Resolves when no live update is waiting for a script isolate any more (updates the
   * isolate could not take at once because it was busy with another series). Await it
   * before sampling, or the sample reads values older than the bar.
   */
  async settled(): Promise<void> {
    for (;;) {
      const running = [
        ...[...this.states.values()].flatMap((st) => st.flushing ?? []),
        ...this.running,
      ];
      if (running.length === 0) return;
      await Promise.all(running);
    }
  }

  /**
   * Add instances (`type` = `user:<id>`), computing them over the series' bars
   * and running Check. Failures are recorded per instance (`error`, `held`).
   */
  async add(
    instances: readonly { hash: string; type: string; inputs: InstanceReq['inputs'] }[],
  ): Promise<void> {
    const groups = new Map<string, InstanceReq[]>();
    for (const inst of instances) {
      const id = scriptIdOf(inst.type);
      if (id === undefined || this.scriptOf.has(inst.hash)) continue;
      this.scriptOf.set(inst.hash, id);
      const g = groups.get(id) ?? [];
      g.push({ hash: inst.hash, inputs: inst.inputs });
      groups.set(id, g);
    }
    for (const [id, insts] of groups) await this.addGroup(id, insts);
  }

  private async addGroup(id: string, insts: InstanceReq[]): Promise<void> {
    const gen = this.gen;
    let st = this.states.get(id);
    if (st && st.epoch !== this.scripts.epoch(id)) {
      // The isolate was replaced: what it held is gone.
      for (const h of st.hashes) this.dropCache(h);
      this.states.delete(id);
      st = undefined;
    }
    const state: ScriptState = st ?? {
      epoch: 0,
      hashes: new Set(),
      insts: new Map(),
      synced: 0,
      stale: false,
      pending: null,
      flushing: null,
    };
    for (const i of insts) {
      state.hashes.add(i.hash);
      state.insts.set(i.hash, i);
    }
    this.states.set(id, state);
    try {
      if (st && !st.stale) {
        const r = await this.scripts.callAsync<SeriesResult>(
          id,
          'addInstances',
          [this.key, insts],
          { hashes: state.hashes, barCount: this.src.length() },
          st.epoch,
        );
        if (gen !== this.gen) return;
        this.apply(state, r.value);
      } else {
        // A new series state, or one to rebuild after a timed-out update (all its instances).
        await this.open(id, state);
        if (gen !== this.gen) return this.release(id, state);
      }
    } catch (err) {
      if (gen === this.gen) this.fail(state, err);
      return;
    }
    for (const i of insts) {
      if (gen !== this.gen) return;
      if (state.hashes.has(i.hash) && !this.runErrors.has(i.hash))
        await this.check(id, state, i.hash);
    }
  }

  /** (Re)build the series' state in the isolate from the current bars; applies the values. */
  private async open(id: string, state: ScriptState): Promise<void> {
    const cols = this.src.columns();
    const r = await this.scripts.callAsync<SeriesResult>(
      id,
      'open',
      [this.key, this.src.context(), cols, [...state.insts.values()]],
      { hashes: state.hashes, barCount: cols.time.length },
    );
    state.epoch = r.epoch;
    state.synced = cols.time.length;
    state.stale = false;
    this.apply(state, r.value);
  }

  private async check(id: string, state: ScriptState, hash: string): Promise<void> {
    const gen = this.gen;
    this.checkErrors.delete(hash);
    let res: CheckResult;
    try {
      res = (
        await this.scripts.callAsync<CheckResult>(
          id,
          'check',
          [this.key, hash, CHECK_LIVE_BARS],
          undefined,
          state.epoch,
        )
      ).value;
    } catch (err) {
      if (gen === this.gen) this.fail(state, err);
      return;
    }
    if (gen !== this.gen || !state.hashes.has(hash)) return;
    if (res.ok) return;
    if ('error' in res) {
      this.checkErrors.set(hash, res.error);
      return;
    }
    const m = res.mismatch;
    const t = this.src.time(m.index);
    const at = Number.isFinite(t) ? new Date(t * 1000).toISOString() : `bar ${m.index}`;
    this.checkErrors.set(
      hash,
      `script output '${m.outputId}' differs between a full recompute and live updates at ${at} ` +
        `(full ${m.full}, live ${m.live}): keep state in ta, see Check`,
    );
  }

  remove(hash: string): void {
    const id = this.scriptOf.get(hash);
    if (id === undefined) return;
    this.scriptOf.delete(hash);
    this.dropCache(hash);
    const st = this.states.get(id);
    if (!st) return;
    st.hashes.delete(hash);
    st.insts.delete(hash);
    if (st.hashes.size === 0) {
      this.states.delete(id);
      this.release(id, st);
    } else {
      this.releaseCall(id, st, 'removeInstance', [this.key, hash]);
    }
  }

  /** All bars were replaced (history reload, trim, restated bars). `settled` covers it. */
  setBars(cols: Columns): Promise<void> {
    const p: Promise<void> = this.replaceBars(cols).finally(() => this.running.delete(p));
    this.running.add(p);
    return p;
  }

  private async replaceBars(cols: Columns): Promise<void> {
    const gen = this.gen;
    for (const [id, st] of [...this.states]) {
      if (gen !== this.gen) return;
      st.pending = null;
      try {
        if (st.stale) {
          await this.open(id, st);
          continue;
        }
        const r = await this.scripts.callAsync<SeriesResult>(
          id,
          'setBars',
          [this.key, cols],
          { hashes: st.hashes, barCount: cols.time.length },
          st.epoch,
        );
        if (gen !== this.gen) return;
        st.synced = cols.time.length;
        this.apply(st, r.value);
      } catch (err) {
        if (gen !== this.gen) return;
        this.fail(st, err, true);
      }
    }
  }

  /**
   * The last bar changed (`index` = its index) or a bar was appended. Always asynchronous:
   * the update is kept (the newest per series) and sent when the script's isolate is free;
   * await `settled` before sampling.
   */
  updateBar(index: number, bar: BarInput): void {
    for (const [id, st] of this.states) this.defer(id, st, index, bar);
  }

  /** Keep the newest update to send later; a gap in the bars (or a rebuild) needs all of them. */
  private defer(id: string, st: ScriptState, index: number, bar: BarInput): void {
    const p = st.pending;
    const full =
      st.stale || (p ? p.full || p.index !== index : index > st.synced || index < st.synced - 1);
    st.pending = { index, bar, full };
    st.flushing ??= this.flush(id, st).finally(() => {
      st.flushing = null;
    });
  }

  private async flush(id: string, st: ScriptState): Promise<void> {
    const gen = this.gen;
    while (st.pending && gen === this.gen && this.states.get(id) === st) {
      const p = st.pending;
      st.pending = null;
      try {
        await this.scripts.idle(id);
        if (gen !== this.gen) return;
        if (p.full || st.stale) {
          if (st.stale) await this.open(id, st);
          else {
            const cols = this.src.columns();
            const r = await this.scripts.callAsync<SeriesResult>(
              id,
              'setBars',
              [this.key, cols],
              { hashes: st.hashes, barCount: cols.time.length },
              st.epoch,
            );
            st.synced = cols.time.length;
            if (gen === this.gen) this.apply(st, r.value);
          }
        } else {
          const r = await this.scripts.callAsync<SeriesResult>(
            id,
            'updateBar',
            [this.key, p.index, p.bar],
            { hashes: st.hashes, barCount: this.src.length() },
            st.epoch,
            true,
          );
          st.synced = Math.max(st.synced, p.index + 1);
          if (gen === this.gen) this.apply(st, r.value);
        }
      } catch (err) {
        if (gen !== this.gen) return;
        this.fail(st, err, true);
      }
    }
  }

  /** Release everything (series reload or dispose). Running operations drop their results. */
  reset(): void {
    this.gen++;
    for (const [id, st] of this.states) this.release(id, st);
    this.states.clear();
    this.scriptOf.clear();
    this.values.clear();
    this.runErrors.clear();
    this.holds.clear();
    this.checkErrors.clear();
  }

  /** Free the series' state in the isolate (best effort). */
  private release(id: string, st: ScriptState): void {
    this.releaseCall(id, st, 'close', [this.key]);
  }

  /** A quick call that frees state in the isolate: nobody waits for it. */
  private releaseCall(
    id: string,
    st: ScriptState,
    name: 'close' | 'removeInstance',
    args: string[],
  ): void {
    if (st.epoch !== this.scripts.epoch(id) || st.epoch === 0) return;
    this.scripts.callAsync(id, name, args, undefined, st.epoch).catch(() => undefined);
  }

  private dropCache(hash: string): void {
    this.values.delete(hash);
    this.runErrors.delete(hash);
    this.holds.delete(hash);
    this.checkErrors.delete(hash);
  }

  private apply(st: ScriptState, res: SeriesResult): void {
    for (const u of res.updates) {
      if (!st.hashes.has(u.hash)) continue;
      let outs = this.values.get(u.hash);
      if (!outs) {
        outs = new Map();
        this.values.set(u.hash, outs);
      }
      for (const [id, arr] of Object.entries(u.values)) {
        let cur = outs.get(id);
        if (!cur) {
          cur = [];
          outs.set(id, cur);
        }
        cur.length = u.from;
        for (let k = 0; k < arr.length; k++) cur[u.from + k] = arr[k]!;
      }
    }
    for (const hash of st.hashes) {
      this.holds.delete(hash);
      const msg = res.errors[hash];
      if (msg === undefined) this.runErrors.delete(hash);
      else this.runErrors.set(hash, msg);
    }
  }

  /**
   * A call failed: every instance of the script reports why. A script that is
   * out for now (fault hold, replaced isolate) only holds its instances back;
   * a timed-out live update only marks the series' state for a rebuild (the
   * instances keep their last values); anything else is an error of the instance.
   */
  private fail(st: ScriptState, err: unknown, rebuild = false): void {
    // A timed-out update, or (`rebuild`: the series already had its state) an isolate that is
    // gone without a fault (its process was restarted): rebuild the state on the next bar.
    if (err instanceof ScriptStrike || (rebuild && err instanceof ScriptSuperseded)) {
      st.stale = true;
      return;
    }
    if (err instanceof ScriptUnavailable && err.transient) {
      for (const h of st.hashes) {
        this.holds.set(h, err.reason);
        this.values.delete(h);
      }
      return;
    }
    const reason =
      err instanceof ScriptUnavailable
        ? err.reason
        : err instanceof ScriptCallError
          ? `script failed: ${err.message}`
          : `script failed: ${errText(err)}`;
    for (const h of st.hashes) {
      this.runErrors.set(h, reason);
      this.holds.delete(h);
      this.values.delete(h);
    }
  }
}
