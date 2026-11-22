/**
 * Runs inside the isolate (bundled to one IIFE by `isolateBundle.ts`): one
 * user script, compiled with `compileUserScript`, evaluated by the same
 * `IndicatorRuntime` the chart uses, one runtime per series. Pure JS: no Node
 * APIs, no host objects. The host reaches it through `globalThis.__tg`, which
 * it takes a reference to and then deletes, so the script (compiled later)
 * cannot see it.
 *
 * Only plot values cross back: `Float64Array` copies of the changed range.
 * Every function reports through an `Envelope` (see `protocol.ts`), and the
 * code here uses the builtins captured by `hardening.ts` (imported first, so
 * it runs before anything else and before any user code).
 */
import {
  ArrayCtor,
  F64,
  MapCtor,
  mapDelete,
  mapForEach,
  mapGet,
  mapHas,
  mapSet,
  objectKeys,
  removeLocaleApis,
  strSlice,
  toStr,
} from './hardening';
import {
  IndicatorRegistry,
  IndicatorRuntime,
  checkScript,
  compileUserScript,
  isOutputRef,
  probeLineOffset,
  type AnyIndicatorDefinition,
  type Change,
  type InputValueMap,
} from '@tickerglass/indicators/core';
import type {
  BarMsg,
  CheckResult,
  Columns,
  Envelope,
  InstanceReq,
  IsolateApi,
  LoadResult,
  SeriesContext,
  SeriesResult,
} from './protocol';

interface Cols {
  time: number[];
  open: number[];
  high: number[];
  low: number[];
  close: number[];
  volume: number[];
}

interface SeriesState {
  rt: IndicatorRuntime;
  ctx: SeriesContext;
  cols: Cols;
  /** Instances in the runtime (by hash). */
  specs: Map<string, InstanceReq>;
  /** Instances that could not be added: message per hash. */
  addErrors: Map<string, string>;
}

const LOCATION_SUFFIX = / \(line (\d+):(\d+)\)$/;
const MAX_MESSAGE = 500;
const registry = new IndicatorRegistry();
let definition: AnyIndicatorDefinition | null = null;
const series = new MapCtor<string, SeriesState>();

const message = (err: unknown): string => (err instanceof Error ? err.message : toStr(err));

/** Error text safe to send out: bounded, and never throws (getters on a thrown object can). */
function describe(err: unknown): string {
  try {
    return strSlice(message(err), 0, MAX_MESSAGE);
  } catch {
    return 'the script threw a value that cannot be read';
  }
}

function column(src: ArrayLike<number>): number[] {
  const n = src.length;
  const out = new ArrayCtor<number>(n);
  for (let i = 0; i < n; i++) out[i] = src[i]!;
  return out;
}

function toCols(c: Columns): Cols {
  return {
    time: column(c.time),
    open: column(c.open),
    high: column(c.high),
    low: column(c.low),
    close: column(c.close),
    volume: column(c.volume),
  };
}

function need(key: string): SeriesState {
  const s = mapGet(series, key);
  if (!s) throw new Error(`unknown series '${key}'`);
  return s;
}

/** Script instances are leaves: plain input values only (no references to other instances). */
function plainInputs(inputs: InputValueMap): void {
  const keys = objectKeys(inputs);
  for (let i = 0; i < keys.length; i++)
    if (isOutputRef(inputs[keys[i]!]!)) throw new Error('scripts cannot read other indicators');
}

function addAll(s: SeriesState, instances: InstanceReq[]): string[] {
  const added: string[] = [];
  for (let k = 0; k < instances.length; k++) {
    const inst = instances[k]!;
    if (mapHas(s.specs, inst.hash)) continue;
    try {
      if (!definition) throw new Error('script not loaded');
      plainInputs(inst.inputs);
      s.rt.add({ id: inst.hash, type: definition.id, inputs: inst.inputs });
      mapSet(s.specs, inst.hash, inst);
      mapDelete(s.addErrors, inst.hash);
      added[added.length] = inst.hash;
    } catch (err) {
      mapSet(s.addErrors, inst.hash, describe(err));
    }
  }
  return added;
}

function plotIds(): string[] {
  const out: string[] = [];
  const outputs = definition?.outputs;
  if (!outputs) return out;
  for (let i = 0; i < outputs.length; i++) {
    const o = outputs[i]!;
    if (o.type === 'plot') out[out.length] = o.id;
  }
  return out;
}

/** `Float64Array` copy of `arr[from..to)`; the host reads nothing else of the plot. */
function copyRange(arr: ArrayLike<number>, from: number, to: number): Float64Array {
  const n = to > from ? to - from : 0;
  const out = new F64(n);
  for (let k = 0; k < n; k++) out[k] = arr[from + k]!;
  return out;
}

/** Values of the instances in `from` (hash -> first changed index), errors of all. */
function collect(s: SeriesState, from: Map<string, number>): SeriesResult {
  const out: SeriesResult = { updates: [], errors: {} };
  mapForEach(s.addErrors, (msg, hash) => {
    out.errors[hash] = msg;
  });
  const ids = plotIds();
  mapForEach(s.specs, (_spec, hash) => {
    const res = s.rt.result(hash);
    if (!res) return;
    if (res.status.state === 'error') {
      out.errors[hash] = strSlice(res.status.message, 0, MAX_MESSAGE);
      return;
    }
    const f = mapGet(from, hash);
    if (f === undefined) return;
    const len = res.length;
    const start = f < len ? f : len;
    const values: Record<string, Float64Array> = {};
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]!;
      const arr = res.values[id];
      if (arr) values[id] = copyRange(arr, start, len);
    }
    out.updates[out.updates.length] = { hash, from: start, values };
  });
  return out;
}

function zeroFrom(s: SeriesState): Map<string, number> {
  const m = new MapCtor<string, number>();
  mapForEach(s.specs, (_spec, hash) => {
    mapSet(m, hash, 0);
  });
  return m;
}

function fromChanges(changes: Change[]): Map<string, number> {
  const m = new MapCtor<string, number>();
  for (let i = 0; i < changes.length; i++) mapSet(m, changes[i]!.id, changes[i]!.from);
  return m;
}

const api: IsolateApi = {
  load(scriptId, source): LoadResult {
    if (definition) return { ok: false, message: 'a script is already loaded' };
    try {
      const compiled = compileUserScript(source, { scriptId, lineOffset: probeLineOffset() });
      registry.register(compiled.definition);
      definition = compiled.definition;
      return { ok: true, manifest: compiled.manifest };
    } catch (err) {
      const text = message(err);
      const m = LOCATION_SUFFIX.exec(text);
      if (!m) return { ok: false, message: strSlice(text, 0, MAX_MESSAGE) };
      return {
        ok: false,
        message: strSlice(text, 0, m.index),
        line: Number(m[1]),
        col: Number(m[2]),
      };
    }
  },

  open(key, ctx, bars, instances): SeriesResult {
    mapDelete(series, key);
    const rt = new IndicatorRuntime({ registry, context: ctx });
    const s: SeriesState = {
      rt,
      ctx,
      cols: toCols(bars),
      specs: new MapCtor(),
      addErrors: new MapCtor(),
    };
    mapSet(series, key, s);
    addAll(s, instances);
    rt.setBars(bars);
    return collect(s, zeroFrom(s));
  },

  addInstances(key, instances): SeriesResult {
    const s = need(key);
    const added = addAll(s, instances);
    const from = new MapCtor<string, number>();
    for (let i = 0; i < added.length; i++) mapSet(from, added[i]!, 0);
    return collect(s, from);
  },

  removeInstance(key, hash): void {
    const s = mapGet(series, key);
    if (!s) return;
    s.rt.remove(hash);
    mapDelete(s.specs, hash);
    mapDelete(s.addErrors, hash);
  },

  setBars(key, bars): SeriesResult {
    const s = need(key);
    s.cols = toCols(bars);
    s.rt.setBars(bars);
    return collect(s, zeroFrom(s));
  },

  updateBar(key, index, bar: BarMsg): SeriesResult {
    const s = need(key);
    const c = s.cols;
    c.time[index] = bar.time;
    c.open[index] = bar.open;
    c.high[index] = bar.high;
    c.low[index] = bar.low;
    c.close[index] = bar.close;
    c.volume[index] = bar.volume;
    return collect(s, fromChanges(s.rt.updateBar(index, bar)));
  },

  check(key, hash, liveBars): CheckResult {
    try {
      const s = need(key);
      const spec = mapGet(s.specs, hash);
      if (!spec || !definition) return { ok: false, error: 'Check: instance not found' };
      const outcome = checkScript({
        registry,
        type: definition.id,
        bars: s.cols,
        context: s.ctx,
        inputs: spec.inputs,
        liveBars,
      });
      return outcome.ok
        ? { ok: true }
        : 'error' in outcome
          ? { ok: false, error: strSlice(outcome.error, 0, MAX_MESSAGE) }
          : { ok: false, mismatch: outcome.mismatch };
    } catch (err) {
      return { ok: false, error: `Check: ${describe(err)}` };
    }
  },

  close(key): void {
    mapDelete(series, key);
  },
};

/** Run one API call; whatever it throws becomes an `ok: false` envelope. */
function guard<R>(fn: () => R): Envelope<R> {
  try {
    return { ok: true, value: fn() };
  } catch (err) {
    return { ok: false, error: describe(err) };
  }
}

/** The object the host takes a reference to (and then deletes from the global). */
const guarded = {
  load: (id: string, src: string) => guard(() => api.load(id, src)),
  open: (key: string, ctx: SeriesContext, bars: Columns, instances: InstanceReq[]) =>
    guard(() => api.open(key, ctx, bars, instances)),
  addInstances: (key: string, instances: InstanceReq[]) =>
    guard(() => api.addInstances(key, instances)),
  removeInstance: (key: string, hash: string) => guard(() => api.removeInstance(key, hash)),
  setBars: (key: string, bars: Columns) => guard(() => api.setBars(key, bars)),
  updateBar: (key: string, index: number, bar: BarMsg) =>
    guard(() => api.updateBar(key, index, bar)),
  check: (key: string, hash: string, liveBars: number) =>
    guard(() => api.check(key, hash, liveBars)),
  close: (key: string) => guard(() => api.close(key)),
};

// Every module is loaded: nothing needs ICU from here on, and no user code has run yet.
removeLocaleApis();
(globalThis as Record<string, unknown>)['__tg'] = guarded;
