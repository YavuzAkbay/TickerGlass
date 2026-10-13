import { BarStore } from './bars';
import { DEFAULT_ENV, IndicatorInstance, type RefResolver } from './instance';
import { defaultRegistry, type AnyIndicatorDefinition, type IndicatorRegistry } from './registry';
import { resolveInputs, sourceRefs, timeframeInputValue, waitsForTimeframeClose } from './resolve';
import type {
  BarArrays,
  BarInput,
  BarsEnv,
  IndicatorResult,
  InputValueMap,
  InstanceStatus,
} from './types';

/** Serialisable description of one indicator on a chart (persisted in layouts). */
export interface InstanceSpec {
  /** Unique per chart; also the engine study id. Not 'main'/'volume*'. */
  id: string;
  /** Definition id in the registry. */
  type: string;
  inputs?: InputValueMap;
}

/** Outputs of instance `id` changed for chart indices >= `from`. */
export interface Change {
  id: string;
  from: number;
}

export interface RuntimeOptions {
  registry?: IndicatorRegistry;
  /**
   * Map a timeframe input value to the series to request. Return '' to compute
   * on chart bars (the value is '' already, equals the chart interval, or is
   * lower than it). Resolves 'auto'. Default: identity.
   */
  resolveTimeframe?: (tf: string) => string;
  /** Initial bars context (see `setContext`). */
  context?: RuntimeContext;
}

/**
 * Host facts about the chart's bars (all optional; omitted fields keep their
 * value). `timeframeSeconds` maps a resolved timeframe ('1W') to its interval
 * for timeframe instances' `env.intervalSeconds` (0 when missing).
 */
export interface RuntimeContext extends Partial<BarsEnv> {
  timeframeSeconds?: Record<string, number>;
}

interface Node {
  spec: InstanceSpec;
  inst: IndicatorInstance;
  /** Resolved timeframe; '' = chart bars. */
  tf: string;
  deps: Set<string>;
  /** Chart-aligned outputs for timeframe instances. */
  aligned: IndicatorResult | null;
}

type BarChange = 'none' | 'full' | 'update' | 'append';

/**
 * All indicator instances of one chart: owns the chart bars and any timeframe
 * series, orders instances by their indicator-on-indicator dependencies, and
 * recomputes only what changed. Pure and synchronous: the web app runs it in a
 * Worker, the alerts service runs it directly.
 *
 * Every mutating method returns the changes to forward to the display.
 */
export class IndicatorRuntime {
  private readonly bars = new BarStore();
  private readonly tfBars = new Map<string, BarStore>();
  private readonly nodes = new Map<string, Node>();
  private order: Node[] = [];
  private readonly registry: IndicatorRegistry;
  private resolveTf: (tf: string) => string;
  private env: Readonly<BarsEnv> = DEFAULT_ENV;
  private tfSeconds: Record<string, number> = {};

  constructor(opts: RuntimeOptions = {}) {
    this.registry = opts.registry ?? defaultRegistry;
    this.resolveTf = opts.resolveTimeframe ?? ((tf) => tf);
    if (opts.context) this.applyContext(opts.context);
  }

  /** Current bars context of chart instances. */
  get context(): Readonly<BarsEnv> {
    return this.env;
  }

  /**
   * Exchange timezone/session and bar interval (symbol or interval change).
   * Instances whose context changed recompute fully.
   */
  setContext(ctx: RuntimeContext): Change[] {
    this.applyContext(ctx);
    const changed = new Set<string>();
    for (const node of this.order) if (this.syncEnv(node)) changed.add(node.spec.id);
    return changed.size ? this.recompute(changed) : [];
  }

  private applyContext(ctx: RuntimeContext): void {
    this.env = Object.freeze({
      timezone: ctx.timezone ?? this.env.timezone,
      session: ctx.session !== undefined ? ctx.session : this.env.session,
      intervalSeconds: ctx.intervalSeconds ?? this.env.intervalSeconds,
    });
    if (ctx.timeframeSeconds) this.tfSeconds = { ...ctx.timeframeSeconds };
  }

  /** Give the node's instance the env for its series; true when it changed. */
  private syncEnv(node: Node): boolean {
    const want = node.tf
      ? { ...this.env, intervalSeconds: this.tfSeconds[node.tf] ?? 0 }
      : this.env;
    const cur = node.inst.env;
    if (
      cur.timezone === want.timezone &&
      cur.session === want.session &&
      cur.intervalSeconds === want.intervalSeconds
    )
      return false;
    node.inst.setEnv(Object.freeze({ ...want }));
    return true;
  }

  get length(): number {
    return this.bars.length;
  }

  // ------------------------------------------------------------ instances

  /** Throws for an unknown type, invalid inputs, a cycle or an MTF+ref mix. */
  add(spec: InstanceSpec): Change[] {
    if (this.nodes.has(spec.id)) throw new Error(`Instance "${spec.id}" already exists`);
    const def = this.definition(spec.type);
    const inputs = resolveInputs(def, spec.inputs);
    const node: Node = {
      spec: { ...spec, inputs },
      inst: new IndicatorInstance(def, inputs),
      tf: '',
      deps: new Set(),
      aligned: null,
    };
    this.configure(node, inputs);
    this.syncEnv(node);
    this.nodes.set(spec.id, node);
    this.reorder();
    return this.recompute(new Set([spec.id]));
  }

  setInputs(id: string, inputs: InputValueMap): Change[] {
    const node = this.node(id);
    const resolved = resolveInputs(node.inst.def, inputs);
    const prev = { spec: node.spec, tf: node.tf, deps: node.deps };
    try {
      this.configure(node, resolved);
      this.reorder();
    } catch (err) {
      Object.assign(node, prev);
      throw err;
    }
    node.spec = { ...node.spec, inputs: resolved };
    node.inst.setInputs(resolved);
    this.syncEnv(node);
    return this.recompute(new Set([id]));
  }

  /** Dependents of a removed instance switch to the error state. */
  remove(id: string): Change[] {
    if (!this.nodes.delete(id)) return [];
    const dependents = this.order.filter((n) => n.deps.has(id)).map((n) => n.spec.id);
    this.reorder();
    return this.recompute(new Set(dependents));
  }

  ids(): string[] {
    return this.order.map((n) => n.spec.id);
  }

  spec(id: string): InstanceSpec | undefined {
    return this.nodes.get(id)?.spec;
  }

  /** Chart-aligned outputs, or null for an unknown id. */
  result(id: string): IndicatorResult | null {
    const node = this.nodes.get(id);
    if (!node) return null;
    return node.tf ? (node.aligned ?? this.emptyResult(node)) : node.inst.result();
  }

  status(id: string): InstanceStatus | null {
    return this.result(id)?.status ?? null;
  }

  // ----------------------------------------------------------- chart bars

  /** Replace all chart bars (load, history prepend, chart type change, brick rebuild). */
  setBars(cols: BarArrays): Change[] {
    this.bars.setAll(cols);
    return this.recompute(new Set(), 'full');
  }

  /**
   * Live change of the displayed series at `index` (last bar = update, next =
   * append). Throws RangeError for any other index: resend with `setBars`.
   */
  updateBar(index: number, bar: BarInput): Change[] {
    const kind = this.bars.setBar(index, bar);
    return this.recompute(new Set(), kind);
  }

  /** Drop all bar data (symbol change); instances stay. */
  clearData(): Change[] {
    this.bars.clear();
    this.tfBars.clear();
    return this.recompute(new Set(), 'full');
  }

  // ---------------------------------------------------------- timeframes

  /** Timeframe series the host must provide via `setTimeframeBars`. */
  requiredTimeframes(): string[] {
    return [...new Set(this.order.map((n) => n.tf).filter((tf) => tf !== ''))];
  }

  /** Change the timeframe resolver (e.g. after a chart interval change). */
  setResolveTimeframe(fn: (tf: string) => string): Change[] {
    this.resolveTf = fn;
    const changed = new Set<string>();
    for (const node of this.order) {
      const tf = this.resolveTf(timeframeInputValue(node.inst.def, node.spec.inputs ?? {}));
      if (tf !== node.tf) {
        node.tf = tf;
        changed.add(node.spec.id);
      }
      if (this.syncEnv(node)) changed.add(node.spec.id);
    }
    return changed.size ? this.recompute(changed) : [];
  }

  setTimeframeBars(tf: string, cols: BarArrays): Change[] {
    let store = this.tfBars.get(tf);
    if (!store) {
      store = new BarStore();
      this.tfBars.set(tf, store);
    }
    store.setAll(cols);
    const ids = this.order.filter((n) => n.tf === tf).map((n) => n.spec.id);
    return this.recompute(new Set(ids));
  }

  /** Live bar of a timeframe series (time-based upsert). */
  updateTimeframeBar(tf: string, bar: BarInput): Change[] {
    const store = this.tfBars.get(tf);
    if (!store) return [];
    const kind = store.upsert(bar);
    if (kind === 'ignored') return [];
    const seeds = new Map<string, number>();
    // First chart bar inside the (new) last timeframe bar. (Subtracting an
    // epsilon from the start time is a no-op at unix-second magnitudes.)
    const start = store.time[store.length - 1]!;
    let from = this.bars.indexAtOrBefore(start) + 1;
    while (from > 0 && this.bars.time[from - 1]! >= start) from--;
    for (const node of this.order) {
      if (node.tf !== tf) continue;
      node.inst.computeLast(store, kind);
      seeds.set(node.spec.id, from);
    }
    // Only chart bars whose aligned values actually changed propagate (Pivot
    // Points and confirmed alignment ignore ticks of the forming bar).
    return this.propagate(seeds, 'none', true);
  }

  // ------------------------------------------------------------ internals

  private definition(type: string): AnyIndicatorDefinition {
    const def = this.registry.get(type);
    if (!def) throw new Error(`Unknown indicator "${type}"`);
    return def;
  }

  private node(id: string): Node {
    const n = this.nodes.get(id);
    if (!n) throw new Error(`Unknown instance "${id}"`);
    return n;
  }

  private configure(node: Node, inputs: InputValueMap): void {
    const refs = sourceRefs(node.inst.def, inputs);
    const tf = this.resolveTf(timeframeInputValue(node.inst.def, inputs));
    if (tf && refs.length)
      throw new Error('Indicators on another timeframe can only use price sources');
    node.tf = tf;
    node.deps = new Set(refs.map((r) => r.instanceId));
  }

  /** Topological order; throws on a cycle (state is left unchanged). */
  private reorder(): void {
    const out: Node[] = [];
    const mark = new Map<string, 1 | 2>();
    const visit = (node: Node, path: string[]) => {
      const id = node.spec.id;
      if (mark.get(id) === 2) return;
      if (mark.get(id) === 1)
        throw new Error(`Indicator source cycle: ${[...path, id].join(' -> ')}`);
      mark.set(id, 1);
      for (const dep of node.deps) {
        const d = this.nodes.get(dep);
        if (d) visit(d, [...path, id]);
      }
      mark.set(id, 2);
      out.push(node);
    };
    for (const node of this.nodes.values()) visit(node, []);
    this.order = out;
  }

  /** Fully recompute `ids` (and propagate to dependents). */
  private recompute(ids: Set<string>, bars: BarChange = 'none'): Change[] {
    const seeds = new Map<string, number>();
    for (const node of this.order) {
      if (!ids.has(node.spec.id) && bars !== 'full') continue;
      if (node.tf) {
        const store = this.tfBars.get(node.tf);
        if (store && (ids.has(node.spec.id) || node.aligned === null)) node.inst.computeAll(store);
      }
      seeds.set(node.spec.id, 0);
    }
    return this.propagate(seeds, bars);
  }

  /**
   * Walk instances in dependency order. `seeds` hold the first index already
   * known to change per instance (timeframe instances: re-align from there;
   * chart instances: 0 forces a full compute).
   */
  private propagate(seeds: Map<string, number>, bars: BarChange, diff = false): Change[] {
    const n = this.bars.length;
    const changed = new Map<string, number>();
    const refs: RefResolver = (ref) => this.result(ref.instanceId)?.values[ref.outputId];
    for (const node of this.order) {
      const id = node.spec.id;
      let from = seeds.get(id) ?? Infinity;
      for (const dep of node.deps) from = Math.min(from, changed.get(dep) ?? Infinity);
      if (node.tf) {
        if (bars === 'append') from = Math.min(from, n - 1);
        if (from === Infinity) continue;
        from = Math.max(0, from);
        const first = this.align(node, from, diff);
        if (first < n || first === 0) changed.set(id, first);
        continue;
      }
      // A change before the last bar (inputs, upstream history) needs a full pass.
      if (bars === 'full' || from < n - 1) {
        node.inst.computeAll(this.bars, refs);
        changed.set(id, 0);
      } else if (bars === 'update' || bars === 'append' || from === n - 1) {
        const kind = bars === 'append' ? 'append' : 'update';
        changed.set(id, node.inst.computeLast(this.bars, kind, refs));
      }
    }
    return [...changed].map(([id, from]) => ({ id, from }));
  }

  /**
   * Map timeframe outputs onto chart bars from index `from`. Returns `from`,
   * or with `diff` the first chart index whose values/colours/status actually
   * changed (Infinity when none did).
   */
  private align(node: Node, from: number, diff = false): number {
    const n = this.bars.length;
    const store = this.tfBars.get(node.tf);
    const src = node.inst.result();
    const res = node.aligned ?? this.emptyResult(node);
    const cap = Math.ceil(Math.max(n, 64) * 1.5);
    for (const id of Object.keys(src.values)) {
      const arr = res.values[id];
      if (arr && arr.length >= n) continue;
      const next = new Float64Array(cap).fill(NaN);
      if (arr) next.set(arr.subarray(0, Math.min(arr.length, from)));
      res.values[id] = next;
    }
    for (const id of Object.keys(src.colors)) {
      const c = res.colors[id];
      if (c && c.length >= n) continue;
      const next = new Uint8Array(cap);
      if (c) next.set(c.subarray(0, Math.min(c.length, from)));
      res.colors[id] = next;
    }
    const prevLength = res.length;
    const prevStatus = JSON.stringify(res.status);
    res.length = n;
    res.status = store ? src.status : { state: 'waiting', timeframe: node.tf };
    node.aligned = res;
    let first =
      diff && JSON.stringify(res.status) === prevStatus ? Math.max(from, prevLength) : from;
    // Confirmed alignment: a chart bar shows the timeframe bar before the one containing it.
    const back = waitsForTimeframeClose(node.inst.def, node.spec.inputs ?? {}) ? 1 : 0;
    // Values hold across every chart bar of a timeframe bar; shapes and
    // background only mark its first chart bar.
    const spanOnly = new Set(
      node.inst.def.outputs
        .filter((o) => o.type === 'shape' || o.type === 'bgcolor')
        .map((o) => o.id),
    );
    let prevK = from > 0 && store ? store.indexAtOrBefore(this.bars.time[from - 1]!) : -1;
    for (let j = from; j < n; j++) {
      const k = store && src.status.state === 'ok' ? store.indexAtOrBefore(this.bars.time[j]!) : -1;
      const startsK = k !== prevK;
      const kv = k - back;
      for (const [id, arr] of Object.entries(res.values)) {
        const v = kv < 0 || (spanOnly.has(id) && !startsK) ? NaN : src.values[id]![kv]!;
        if (j < first && !Object.is(arr[j], v)) first = j;
        arr[j] = v;
      }
      for (const [id, c] of Object.entries(res.colors)) {
        const v = kv < 0 ? 0 : src.colors[id]![kv]!;
        if (j < first && c[j] !== v) first = j;
        c[j] = v;
      }
      prevK = k;
    }
    return first;
  }

  private emptyResult(node: Node): IndicatorResult {
    const values: Record<string, Float64Array> = {};
    const colors: Record<string, Uint8Array> = {};
    for (const id of Object.keys(node.inst.values)) values[id] = new Float64Array(0);
    for (const id of Object.keys(node.inst.colors)) colors[id] = new Uint8Array(0);
    return { length: 0, values, colors, status: { state: 'waiting', timeframe: node.tf } };
  }
}
