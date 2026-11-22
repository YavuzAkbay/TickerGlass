/**
 * Checks of everything an isolate hands back. The isolate runs user code, so
 * its results are untrusted input to the host: every shape and bound is
 * verified here before any value is used (a result is a structured clone, so
 * it can hold anything a script put there, including a huge `length`).
 * Violations throw `ScriptCallError`; they count as a script error for the
 * script's alerts, never as a host crash.
 */
import { parseManifest, type UserScriptManifest } from '@tickerglass/indicators';
import { ScriptCallError } from './errors';
import type { CheckResult, LoadResult, SeriesResult, ValueUpdate } from './protocol';

const MAX_TEXT = 500;

/** What the host knows about the call a result answers. */
export interface SeriesExpect {
  /** Instances the series may have for this script. */
  hashes: ReadonlySet<string>;
  /** Bars the series has (the bound of every returned range). */
  barCount: number;
}

const bad = (what: string): never => {
  throw new ScriptCallError(`malformed result from the script isolate: ${what}`);
};

function plain(v: unknown, what: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v))
    return bad(`${what} is not an object`);
  const proto = Object.getPrototypeOf(v) as unknown;
  if (proto !== Object.prototype && proto !== null) return bad(`${what} is not a plain object`);
  return v as Record<string, unknown>;
}

function text(v: unknown, what: string): string {
  if (typeof v !== 'string') return bad(`${what} is not a string`);
  return v.length > MAX_TEXT ? v.slice(0, MAX_TEXT) : v;
}

/** The value of an `Envelope`; throws `ScriptCallError` with the isolate's message for `ok: false`. */
export function unwrap(raw: unknown): unknown {
  const env = plain(raw, 'envelope');
  if (env['ok'] === true) return env['value'];
  if (env['ok'] === false) throw new ScriptCallError(text(env['error'], 'error'));
  return bad('envelope has no ok flag');
}

export function readLoad(raw: unknown, scriptId: string): LoadResult {
  const r = plain(raw, 'load result');
  if (r['ok'] === false) {
    const out: LoadResult = { ok: false, message: text(r['message'], 'compile message') };
    if (r['line'] !== undefined) {
      const line = r['line'];
      const col = r['col'];
      if (!Number.isSafeInteger(line) || (col !== undefined && !Number.isSafeInteger(col)))
        return bad('compile position');
      out.line = line as number;
      if (col !== undefined) out.col = col as number;
    }
    return out;
  }
  if (r['ok'] !== true) return bad('load result has no ok flag');
  let manifest: UserScriptManifest;
  try {
    manifest = parseManifest(r['manifest']);
  } catch (err) {
    return bad(`manifest: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (manifest.id !== `user:${scriptId}`) return bad('manifest id');
  return { ok: true, manifest };
}

/** `updates` for known instances only, each range inside `[0, barCount]`, each value array a host `Float64Array`. */
export function readSeries(
  raw: unknown,
  expect: SeriesExpect,
  plotIds: ReadonlySet<string>,
): SeriesResult {
  const r = plain(raw, 'series result');
  const rawUpdates = r['updates'];
  if (!Array.isArray(rawUpdates)) return bad('updates is not an array');
  if (rawUpdates.length > expect.hashes.size) return bad('more updates than instances');
  const seen = new Set<string>();
  const updates: ValueUpdate[] = [];
  for (const item of rawUpdates as unknown[]) {
    const u = plain(item, 'update');
    const hash = u['hash'];
    if (typeof hash !== 'string' || !expect.hashes.has(hash))
      return bad('update for an unknown instance');
    if (seen.has(hash)) return bad('duplicate update');
    seen.add(hash);
    const from = u['from'];
    if (!Number.isSafeInteger(from) || (from as number) < 0 || (from as number) > expect.barCount)
      return bad("update range starts outside the series' bars");
    const max = expect.barCount - (from as number);
    const rawValues = plain(u['values'], 'update values');
    const values: Record<string, Float64Array> = {};
    for (const id of Object.keys(rawValues)) {
      if (!plotIds.has(id)) return bad(`'${id}' is not a plot output of the script`);
      const arr = rawValues[id];
      if (!(arr instanceof Float64Array)) return bad(`values of '${id}' are not a Float64Array`);
      if (arr.length > max) return bad(`values of '${id}' run past the series' bars`);
      values[id] = arr;
    }
    updates.push({ hash, from: from as number, values });
  }
  const rawErrors = plain(r['errors'], 'errors');
  const errors: Record<string, string> = {};
  for (const hash of Object.keys(rawErrors)) {
    if (!expect.hashes.has(hash)) return bad('error for an unknown instance');
    errors[hash] = text(rawErrors[hash], 'instance error');
  }
  return { updates, errors };
}

export function readCheck(raw: unknown): CheckResult {
  const r = plain(raw, 'check result');
  if (r['ok'] === true) return { ok: true };
  if (r['ok'] !== false) return bad('check result has no ok flag');
  if (r['error'] !== undefined) return { ok: false, error: text(r['error'], 'check error') };
  const m = plain(r['mismatch'], 'check mismatch');
  const { index, full, live } = m;
  if (!Number.isSafeInteger(index) || (index as number) < 0) return bad('mismatch index');
  if (typeof full !== 'number' || typeof live !== 'number') return bad('mismatch values');
  return {
    ok: false,
    mismatch: {
      outputId: text(m['outputId'], 'mismatch output'),
      index: index as number,
      full,
      live,
    },
  };
}

/** `close` / `removeInstance` answer nothing. */
export function readVoid(raw: unknown): undefined {
  if (raw !== undefined && raw !== null) return bad('unexpected value');
  return undefined;
}
