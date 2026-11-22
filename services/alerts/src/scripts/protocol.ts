/**
 * Messages between the script host (Node) and the isolate entry
 * (`isolate-entry.ts`). Everything crossing the boundary is a plain,
 * structured-cloneable value (numbers, strings, plain objects, Float64Array):
 * no host object or function ever enters an isolate.
 */
import type {
  CheckMismatch,
  InputValueMap,
  UserScriptManifest,
} from '@tickerglass/indicators/core';

export interface Columns {
  time: Float64Array;
  open: Float64Array;
  high: Float64Array;
  low: Float64Array;
  close: Float64Array;
  volume: Float64Array;
}

export interface BarMsg {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Facts about the series' bars (the built-in runtime gets the same). */
export interface SeriesContext {
  timezone: string;
  session: string | null;
  intervalSeconds: number;
}

/** One instance of the script on a series; `hash` is its content hash (operand key). */
export interface InstanceReq {
  hash: string;
  inputs: InputValueMap;
}

/** Plot values of one instance for chart indices `from`.. (copies). */
export interface ValueUpdate {
  hash: string;
  from: number;
  values: Record<string, Float64Array>;
}

export interface SeriesResult {
  updates: ValueUpdate[];
  /** Instances in the error state (script threw, bad inputs): message per hash. */
  errors: Record<string, string>;
}

export type LoadResult =
  | { ok: true; manifest: UserScriptManifest }
  | { ok: false; message: string; line?: number; col?: number };

export type CheckResult =
  { ok: true } | { ok: false; mismatch: CheckMismatch } | { ok: false; error: string };

/**
 * What every call into the isolate returns. The entry catches everything a
 * script (or a builtin it replaced) can throw and reports it here, so an error
 * that escapes `apply` is one the isolate itself caused (timeout, memory) and
 * the host can classify it without trusting message text.
 */
export type Envelope<T> = { ok: true; value: T } | { ok: false; error: string };

/** Functions of the isolate's API object (inside the isolate; the host sees `Envelope`s). */
export interface IsolateApi {
  load(scriptId: string, source: string): LoadResult;
  open(key: string, context: SeriesContext, bars: Columns, instances: InstanceReq[]): SeriesResult;
  addInstances(key: string, instances: InstanceReq[]): SeriesResult;
  removeInstance(key: string, hash: string): void;
  setBars(key: string, bars: Columns): SeriesResult;
  updateBar(key: string, index: number, bar: BarMsg): SeriesResult;
  check(key: string, hash: string, liveBars: number): CheckResult;
  close(key: string): void;
}

export const API_NAMES: readonly (keyof IsolateApi)[] = [
  'load',
  'open',
  'addInstances',
  'removeInstance',
  'setBars',
  'updateBar',
  'check',
  'close',
];
