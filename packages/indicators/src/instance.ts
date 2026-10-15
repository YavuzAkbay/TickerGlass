import type { BarStore } from './bars';
import type { AnyIndicatorDefinition } from './registry';
import { isOutputRef, isValueOutput, resolveInputs } from './resolve';
import { TaScope } from './ta';
import type {
  BarsEnv,
  IndicatorResult,
  InputValueMap,
  InputValues,
  InputsSchema,
  InstanceStatus,
  OutputSourceRef,
  StepContext,
  StepFn,
} from './types';

/** Resolves an indicator-on-indicator source to chart-aligned values. */
export type RefResolver = (ref: OutputSourceRef) => Float64Array | undefined;

const NO_REFS: RefResolver = () => undefined;

/** Defaults when the host provides no context: UTC calendar, unknown interval. */
export const DEFAULT_ENV: Readonly<BarsEnv> = Object.freeze({
  timezone: 'UTC',
  session: null,
  intervalSeconds: 0,
});

/** The single reused per-bar context. */
class StepCtx implements StepContext {
  i = 0;
  time = new Float64Array(0);
  open = new Float64Array(0);
  high = new Float64Array(0);
  low = new Float64Array(0);
  close = new Float64Array(0);
  volume = new Float64Array(0);
  src: Record<string, Float64Array> = {};
  env: Readonly<BarsEnv> = DEFAULT_ENV;
  isLast = false;

  constructor(
    public inputs: InputValues<InputsSchema>,
    private readonly owner: IndicatorInstance,
  ) {}

  set(id: string, value: number, color?: number): void {
    const o = this.owner;
    o.values[id]![this.i] = value;
    if (color !== undefined) {
      const c = o.colors[id];
      if (c) c[this.i] = color;
    }
  }

  setColor(id: string, color: number): void {
    const c = this.owner.colors[id];
    if (c) c[this.i] = color;
  }

  get(id: string, j: number): number {
    if (j < 0 || j >= this.i) return NaN;
    return this.owner.values[id]?.[j] ?? NaN;
  }

  setAt(id: string, j: number, value: number, color?: number): void {
    const o = this.owner;
    if (!o.def.repaints) throw new Error(`${o.def.id}: setAt() requires "repaints: true"`);
    if (!Number.isInteger(j) || j < 0 || j > this.i)
      throw new RangeError(`${o.def.id}: setAt() index ${j} is outside 0..${this.i}`);
    if (j === this.i) this.set(id, value, color);
    else o.writeBack(id, j, value, color);
  }
}

/** Old content of one slot overwritten by `setAt` while stepping the last bar. */
interface UndoEntry {
  id: string;
  j: number;
  value: number;
  /** -1: the output has no palette. */
  color: number;
}

/**
 * One indicator computed over one BarStore. Full compute re-runs `setup` and
 * steps every bar; `computeLast` re-runs or appends only the last bar using
 * the snapshot taken before it, so both paths give identical results.
 */
export class IndicatorInstance {
  /** Output arrays (capacity >= length). Plots, shapes, bgcolor. */
  values: Record<string, Float64Array> = {};
  /** Palette index arrays for outputs with a palette colour (incl. fills). */
  colors: Record<string, Uint8Array> = {};
  length = 0;
  status: InstanceStatus = { state: 'ok' };
  inputs: InputValueMap;

  private scope: TaScope | null = null;
  private step: StepFn | null = null;
  private ctx: StepCtx;
  /**
   * Retroactive writes of the last bar's run (oldest first). Re-running the
   * bar replays them in reverse, so a live tick starts from the state the
   * snapshot describes; committing the bar (append) drops them.
   */
  private undo: UndoEntry[] = [];
  /**
   * During `computeLast`: what the host currently shows in every past slot
   * the rewind or the re-run touched (first value seen), to report the first
   * index that actually differs afterwards.
   */
  private shown: Map<string, UndoEntry> | null = null;

  constructor(
    readonly def: AnyIndicatorDefinition,
    inputs: InputValueMap = {},
  ) {
    this.inputs = resolveInputs(def, inputs);
    this.ctx = new StepCtx(this.inputs as InputValues<InputsSchema>, this);
    for (const o of def.outputs) {
      if (isValueOutput(o)) this.values[o.id] = new Float64Array(0);
      if (
        (o.type === 'plot' || o.type === 'fill' || o.type === 'bgcolor' || o.type === 'shape') &&
        typeof o.color !== 'string'
      )
        this.colors[o.id] = new Uint8Array(0);
    }
  }

  /** New inputs take effect on the next `computeAll`. */
  setInputs(inputs: InputValueMap): void {
    this.inputs = resolveInputs(this.def, inputs);
    this.ctx.inputs = this.inputs as InputValues<InputsSchema>;
    this.step = null;
  }

  /** Bars context for the next `computeAll` (a change needs a full recompute). */
  setEnv(env: Readonly<BarsEnv>): void {
    this.ctx.env = env;
    this.step = null;
  }

  get env(): Readonly<BarsEnv> {
    return this.ctx.env;
  }

  /** Recompute every bar. */
  computeAll(bars: BarStore, refs: RefResolver = NO_REFS): void {
    const n = bars.length;
    this.ensureCapacity(n);
    this.length = n;
    this.status = { state: 'ok' };
    this.undo.length = 0;
    try {
      this.bind(bars, refs);
      this.scope = new TaScope();
      this.step = this.def.setup({
        inputs: this.inputs as InputValues<InputsSchema>,
        ta: this.scope.ta,
        env: this.ctx.env,
      });
      this.scope.open = false;
      for (let i = 0; i < n; i++) {
        if (i === n - 1) this.save();
        this.runBar(i);
      }
      this.shown = null;
    } catch (err) {
      this.fail(err);
    }
  }

  /**
   * Re-run the last bar ('update') or step a newly appended one ('append').
   * Falls back to `computeAll` when the bar count does not match. Returns the
   * first index whose outputs changed: the last bar, or earlier when a
   * repainting definition wrote (or a rewind undid) past values.
   */
  computeLast(bars: BarStore, kind: 'update' | 'append', refs: RefResolver = NO_REFS): number {
    const n = bars.length;
    const expected = kind === 'update' ? this.length : this.length + 1;
    if (!this.step || !this.scope || n !== expected || n === 0) {
      this.computeAll(bars, refs);
      return 0;
    }
    this.ensureCapacity(n);
    this.length = n;
    if (this.status.state === 'error') {
      this.clearBar(n - 1);
      return n - 1;
    }
    this.shown = null;
    try {
      this.bind(bars, refs);
      if (kind === 'update') this.restore();
      else this.save();
      this.runBar(n - 1);
    } catch (err) {
      this.shown = null;
      this.fail(err);
      return 0;
    }
    return Math.min(n - 1, this.retroChangedFrom());
  }

  /** Retroactive write of bar j < i (see StepContext.setAt). */
  writeBack(id: string, j: number, value: number, color?: number): void {
    const vals = this.values[id];
    if (!vals) throw new Error(`${this.def.id}: setAt() on unknown output "${id}"`);
    const cols = this.colors[id];
    if (this.ctx.isLast) {
      const old: UndoEntry = { id, j, value: vals[j]!, color: cols ? cols[j]! : -1 };
      this.undo.push(old);
      this.remember(old);
    }
    vals[j] = value;
    if (cols) cols[j] = color ?? 0;
  }

  /** Record the shown content of a slot the first time this tick touches it. */
  private remember(e: UndoEntry): void {
    const key = `${e.id}\u0000${e.j}`;
    this.shown ??= new Map();
    if (!this.shown.has(key)) this.shown.set(key, e);
  }

  /** First past index whose content differs from what was shown before the tick. */
  private retroChangedFrom(): number {
    const shown = this.shown;
    this.shown = null;
    let from = Infinity;
    if (!shown) return from;
    for (const e of shown.values()) {
      if (e.j >= from) continue;
      const cols = this.colors[e.id];
      if (!Object.is(this.values[e.id]![e.j], e.value) || (cols && cols[e.j] !== e.color))
        from = e.j;
    }
    return from;
  }

  /** Snapshot before stepping the last bar; earlier bars are final. */
  private save(): void {
    this.scope!.save();
    this.undo.length = 0;
  }

  /** Rewind to the snapshot: primitives and retroactive writes. */
  private restore(): void {
    this.scope!.restore();
    for (let k = this.undo.length - 1; k >= 0; k--) {
      const u = this.undo[k]!;
      const vals = this.values[u.id]!;
      const cols = this.colors[u.id];
      this.remember({ id: u.id, j: u.j, value: vals[u.j]!, color: cols ? cols[u.j]! : -1 });
      vals[u.j] = u.value;
      if (cols) cols[u.j] = u.color;
    }
    this.undo.length = 0;
  }

  result(): IndicatorResult {
    return { length: this.length, values: this.values, colors: this.colors, status: this.status };
  }

  /** Put the instance in the error state: all outputs NaN. */
  fail(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.status = { state: 'error', message };
    this.undo.length = 0;
    for (const v of Object.values(this.values)) v.fill(NaN);
    for (const c of Object.values(this.colors)) c.fill(0);
  }

  private runBar(i: number): void {
    this.clearBar(i);
    this.ctx.i = i;
    this.ctx.isLast = i === this.length - 1;
    this.step!(this.ctx);
  }

  private clearBar(i: number): void {
    for (const v of Object.values(this.values)) v[i] = NaN;
    for (const c of Object.values(this.colors)) c[i] = 0;
  }

  private bind(bars: BarStore, refs: RefResolver): void {
    const c = this.ctx;
    c.time = bars.time;
    c.open = bars.open;
    c.high = bars.high;
    c.low = bars.low;
    c.close = bars.close;
    c.volume = bars.volume;
    const src: Record<string, Float64Array> = {};
    for (const [key, d] of Object.entries(this.def.inputs)) {
      if (d.kind !== 'source') continue;
      const v = this.inputs[key];
      if (isOutputRef(v)) {
        const arr = refs(v);
        if (!arr) throw new Error(`Source ${v.instanceId}:${v.outputId} is not available`);
        src[key] = arr;
      } else src[key] = bars.source(v as Parameters<BarStore['source']>[0]);
    }
    c.src = src;
  }

  private ensureCapacity(n: number): void {
    const first = Object.values(this.values)[0] ?? Object.values(this.colors)[0];
    if (first && first.length >= n) return;
    const cap = Math.max(n, Math.ceil((first?.length ?? 0) * 1.5), 64);
    for (const [id, v] of Object.entries(this.values)) {
      const next = new Float64Array(cap).fill(NaN);
      next.set(v.subarray(0, this.length));
      this.values[id] = next;
    }
    for (const [id, c] of Object.entries(this.colors)) {
      const next = new Uint8Array(cap);
      next.set(c.subarray(0, this.length));
      this.colors[id] = next;
    }
  }
}
