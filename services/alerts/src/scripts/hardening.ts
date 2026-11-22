/**
 * First module of the isolate bundle: runs before any user code and
 *
 * 1. closes the allocation paths `memoryLimit` does not account for: resizable
 *    `ArrayBuffer`, growable `SharedArrayBuffer` and `WebAssembly.Memory` each
 *    reserve memory outside the isolate's heap counter, so a script could
 *    grow the host process without hitting the limit, and the APIs that run
 *    script code in a task the call's time limit does not cover
 *    (`FinalizationRegistry`, `Atomics.waitAsync`; the browser sandbox removes
 *    the same ones);
 * 2. captures the builtins the entry itself relies on, so a script that
 *    replaces `Math.min`, `Map.prototype.get`, `Float64Array.prototype.slice`
 *    ... after `load` cannot steer the entry's own code. The host still
 *    validates every result (`validate.ts`): this only keeps scripts from
 *    breaking the entry for themselves and their neighbours' hashes.
 */

const g = globalThis as unknown as Record<string, unknown>;

// ---------------------------------------------------- allocation lock-down

delete g['WebAssembly'];
delete g['SharedArrayBuffer'];
// A finalization callback runs as a task of its own, outside the time limit of any call: a
// callback that spins would wedge the isolate's thread (and every later call) for good.
delete g['FinalizationRegistry'];
delete (Atomics as unknown as Record<string, unknown>)['waitAsync'];

const NativeArrayBuffer = ArrayBuffer;
const SafeArrayBuffer = function ArrayBuffer(this: unknown, length?: unknown, options?: unknown) {
  if (!new.target) throw new TypeError("Constructor ArrayBuffer requires 'new'");
  if (options !== undefined && options !== null && typeof options === 'object') {
    // Any options bag may carry `maxByteLength` (also behind a Proxy or getter): refuse them all.
    throw new RangeError('resizable ArrayBuffer is not available');
  }
  return Reflect.construct(NativeArrayBuffer, [length], new.target);
} as unknown as ArrayBufferConstructor;
(SafeArrayBuffer as unknown as { prototype: unknown }).prototype = NativeArrayBuffer.prototype;
// `view.buffer.constructor` is the other way to the native constructor: point it at the wrapper.
Object.defineProperty(NativeArrayBuffer.prototype, 'constructor', {
  value: SafeArrayBuffer,
  writable: false,
  configurable: false,
});
Object.defineProperty(SafeArrayBuffer, 'isView', {
  value: NativeArrayBuffer.isView,
  writable: false,
  configurable: false,
});
Object.defineProperty(SafeArrayBuffer, Symbol.species, {
  get() {
    return this;
  },
  configurable: false,
});
Object.freeze(SafeArrayBuffer);
// Resizing only exists for resizable buffers, which can no longer be created.
delete (NativeArrayBuffer.prototype as unknown as Record<string, unknown>)['resize'];
Object.defineProperty(globalThis, 'ArrayBuffer', {
  value: SafeArrayBuffer,
  writable: false,
  configurable: false,
});

/**
 * ICU keeps its objects (`Intl.*` instances, collators, segmenters, formatters) outside the
 * isolate's heap, so `new Intl.Segmenter()` in a loop grows the host process without ever
 * reaching `memoryLimit` (the container hangs instead of being limited). Called by the entry
 * once every module is loaded (the calendar captured `Intl.DateTimeFormat` at load, bounded
 * to a few zones) and before anything a script can run: removes `Intl` and the methods
 * that call into ICU. Scripts that need them still run on the chart, not in alerts.
 */
export function removeLocaleApis(): void {
  const drop = (owner: unknown, names: string[]): void => {
    const o = owner as Record<string, unknown> | undefined;
    if (!o) return;
    for (const n of names) delete o[n];
  };
  delete g['Intl'];
  drop(Date.prototype, ['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString']);
  drop(Number.prototype, ['toLocaleString']);
  // Also the generic one they would fall back to: nothing in a script may reach a toLocaleString.
  drop(Object.prototype, ['toLocaleString']);
  drop(Array.prototype, ['toLocaleString']);
  drop(Object.getPrototypeOf(Float64Array.prototype), ['toLocaleString']);
  if (typeof BigInt !== 'undefined') drop(BigInt.prototype, ['toLocaleString']);
  drop(String.prototype, ['localeCompare', 'normalize', 'toLocaleUpperCase', 'toLocaleLowerCase']);
  // Not in every engine version: also a source of ICU-backed objects.
  delete g['Temporal'];
}

// ------------------------------------------------------- captured builtins

/** `uncurry(fn)(self, ...args)` is `fn.call(self, ...args)` with `call`/`bind` captured now. */
const uncurry = Function.prototype.bind.bind(Function.prototype.call) as (fn: unknown) => unknown;

export const F64 = Float64Array;
export const MapCtor = Map;
export const ArrayCtor = Array;

export const mapGet = uncurry(Map.prototype.get) as <K, V>(m: Map<K, V>, k: K) => V | undefined;
export const mapSet = uncurry(Map.prototype.set) as <K, V>(m: Map<K, V>, k: K, v: V) => void;
export const mapHas = uncurry(Map.prototype.has) as <K, V>(m: Map<K, V>, k: K) => boolean;
export const mapDelete = uncurry(Map.prototype.delete) as <K, V>(m: Map<K, V>, k: K) => boolean;
export const mapForEach = uncurry(Map.prototype.forEach) as <K, V>(
  m: Map<K, V>,
  fn: (v: V, k: K) => void,
) => void;
export const strSlice = uncurry(String.prototype.slice) as (
  s: string,
  from: number,
  to?: number,
) => string;
export const objectKeys = Object.keys;
export const toStr = String;
