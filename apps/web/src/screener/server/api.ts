/**
 * Typed client of `/api/screener/*` (docs/design/server-screener.md section 4).
 * Scan and universe responses carry an ETag; their last answer is kept in memory
 * and revalidated with `If-None-Match` (304 -> the cached body). Everything else
 * goes through `requestJson`.
 */
import { ApiError, requestJson, type RequestOptions } from '../../api/client';
import type { Universe as ClassUniverse } from '../universe/types';
import type {
  FieldsResponse,
  ListInfo,
  Preset,
  RunResponse,
  ScanErrorDetail,
  ScanRequest,
  ScanResponse,
  Screen,
  ScreenAlert,
  ScreenSpec,
  StatusResponse,
} from './types';
import type { ScreenerClass } from '../universe/types';

type Opts = Pick<RequestOptions, 'signal'>;
const seg = encodeURIComponent;

// ------------------------------------------------------------ ETag-cached requests

interface EtagEntry {
  etag: string;
  data: unknown;
}

/** Newest-last LRU of ETag-validated responses. */
class EtagCache {
  private readonly map = new Map<string, EtagEntry>();
  constructor(private readonly max: number) {}

  get(key: string): EtagEntry | undefined {
    const hit = this.map.get(key);
    if (hit) {
      this.map.delete(key);
      this.map.set(key, hit);
    }
    return hit;
  }

  set(key: string, entry: EtagEntry): void {
    this.map.delete(key);
    this.map.set(key, entry);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
    }
  }

  clear(): void {
    this.map.clear();
  }
}

const scanCache = new EtagCache(64);
const universeCache = new EtagCache(8);

/** Test hook: forget every cached scan / universe answer. */
export function clearScreenerCache(): void {
  scanCache.clear();
  universeCache.clear();
  fieldsPromise = null;
}

/**
 * `requestJson` that also sends/stores the ETag. `requestJson` hides response headers,
 * so this issues the fetch itself; any non-OK answer (other than a matching 304) is
 * replayed through `requestJson`, which owns the error mapping (ApiError, 401 handling).
 */
async function etagJson<T>(
  cache: EtagCache,
  key: string,
  method: 'GET' | 'POST',
  path: string,
  body: unknown,
  opts: Opts,
): Promise<T> {
  const hit = cache.get(key);
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (hit) headers['If-None-Match'] = hit.etag;
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new ApiError('Network error: API unreachable', 0);
  }
  if (res.status === 304 && hit) return hit.data as T;
  if (!res.ok || res.status === 304) return requestJson<T>(method, path, body, opts);
  const data = (await res.json()) as T;
  const etag = res.headers.get('ETag');
  if (etag) cache.set(key, { etag, data });
  return data;
}

// ------------------------------------------------------------ read endpoints

let fieldsPromise: Promise<FieldsResponse> | null = null;

/** The field catalog (immutable per session, shared by all callers so not abortable; a failure is not cached). */
export function getFields(): Promise<FieldsResponse> {
  if (!fieldsPromise) {
    const p = requestJson<FieldsResponse>('GET', '/screener/fields');
    fieldsPromise = p;
    p.catch(() => {
      if (fieldsPromise === p) fieldsPromise = null;
    });
  }
  return fieldsPromise;
}

/** Canonical request body (stable key order) so equal scans share one ETag cache slot. */
export function scanKey(req: ScanRequest): string {
  return JSON.stringify(canonical(req));
}

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .filter(([, x]) => x !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, x]) => [k, canonical(x)]),
    );
  }
  return v;
}

/** Scan the snapshot table (DB only, never upstream). Revalidated with the last ETag. */
export function scan(req: ScanRequest, opts: Opts = {}): Promise<ScanResponse> {
  return etagJson<ScanResponse>(scanCache, scanKey(req), 'POST', '/screener/scan', req, opts);
}

/** `detail` of a 422 scan error, when the server sent the contract's shape. */
export function scanErrorDetail(err: unknown): ScanErrorDetail | null {
  if (!(err instanceof ApiError) || err.status !== 422) return null;
  const d = (err.body as { detail?: unknown } | undefined)?.detail;
  if (d && typeof d === 'object' && typeof (d as { code?: unknown }).code === 'string')
    return d as ScanErrorDetail;
  return null;
}

export const getStatus = (opts: Opts = {}) =>
  requestJson<StatusResponse>('GET', '/screener/status', undefined, opts);

export const getLists = (opts: Opts = {}) =>
  requestJson<ListInfo[]>('GET', '/screener/lists', undefined, opts);

export const getPresets = (opts: Opts = {}) =>
  requestJson<Preset[]>('GET', '/screener/presets', undefined, opts);

/** The class universe in the shape of the bundled datasets (`Universe` of `universe/types`). */
export function getClassUniverse(cls: ScreenerClass, opts: Opts = {}): Promise<ClassUniverse> {
  return etagJson<ClassUniverse>(
    universeCache,
    cls,
    'GET',
    `/screener/universe?cls=${seg(cls)}`,
    undefined,
    opts,
  );
}

// ------------------------------------------------------------ runs

/** 202 `{runId}`; a 409 means a run is already in progress (`isRunConflict`). */
export const triggerRun = (kind: 'snapshot' | 'fundamentals' = 'snapshot', opts: Opts = {}) =>
  requestJson<RunResponse>('POST', '/screener/runs', { kind }, opts);

export const isRunConflict = (e: unknown): boolean => e instanceof ApiError && e.status === 409;

/** The server's own wording of a 409 (`{detail:{message}}`: a run going, or a cooldown), if any. */
export function runConflictMessage(e: unknown): string | null {
  if (!isRunConflict(e)) return null;
  const d = ((e as ApiError).body as { detail?: unknown } | undefined)?.detail;
  const m = d && typeof d === 'object' ? (d as { message?: unknown }).message : null;
  return typeof m === 'string' && m.trim() ? m.trim() : null;
}

// ------------------------------------------------------------ saved screens

export const listScreens = (opts: Opts = {}) =>
  requestJson<Screen[]>('GET', '/screener/screens', undefined, opts);

export const createScreen = (
  body: { id: string; name: string; spec: ScreenSpec; alert?: ScreenAlert },
  opts: Opts = {},
) => requestJson<Screen>('POST', '/screener/screens', body, opts);

/** With `revision`, rejects with 409 (see `screenConflict`) if the screen changed elsewhere. */
export const updateScreen = (
  id: string,
  body: { name: string; spec: ScreenSpec; alert: ScreenAlert; revision?: number },
  opts: Opts = {},
) => requestJson<Screen>('PUT', `/screener/screens/${seg(id)}`, body, opts);

export const deleteScreen = (id: string, opts: Opts = {}) =>
  requestJson<void>('DELETE', `/screener/screens/${seg(id)}`, undefined, opts);

/** The stored screen from a create/update 409, else null. */
export function screenConflict(e: unknown): Screen | null {
  if (!(e instanceof ApiError) || e.status !== 409) return null;
  const d = (e.body as { detail?: unknown } | undefined)?.detail;
  const cur = d && typeof d === 'object' ? (d as { current?: unknown }).current : null;
  return cur && typeof cur === 'object' ? (cur as Screen) : null;
}

export interface SavedScreen {
  screen: Screen;
  /** The server held a newer revision and this save replaced it (last writer wins). */
  overwrote: boolean;
}

/**
 * Update a screen, last writer wins: on a 409 the same change is re-sent on top
 * of the server's revision (once). The caller toasts `overwrote`.
 */
export async function saveScreen(
  base: Screen,
  patch: { name?: string; spec?: ScreenSpec; alert?: ScreenAlert },
  opts: Opts = {},
): Promise<SavedScreen> {
  const body = {
    name: patch.name ?? base.name,
    spec: patch.spec ?? base.spec,
    alert: patch.alert === undefined ? base.alert : patch.alert,
  };
  try {
    return {
      screen: await updateScreen(base.id, { ...body, revision: base.revision }, opts),
      overwrote: false,
    };
  } catch (err) {
    const current = screenConflict(err);
    if (!current) throw err;
    return {
      screen: await updateScreen(base.id, { ...body, revision: current.revision }, opts),
      overwrote: true,
    };
  }
}

/** Server limit per scan page. */
export const MAX_LIMIT = 500;
/** CSV export cap. */
export const EXPORT_MAX_ROWS = 5000;

/** All rows of a scan, fetched page by page (sequentially, at most `max`); `truncated` when more exist. */
export async function scanAll(
  req: Omit<ScanRequest, 'limit' | 'offset'>,
  max = EXPORT_MAX_ROWS,
  opts: Opts = {},
): Promise<{ rows: ScanResponse['rows']; total: number; truncated: boolean; asOf: string | null }> {
  const rows: ScanResponse['rows'] = [];
  let total = Infinity;
  let asOf: string | null = null;
  while (rows.length < Math.min(total, max)) {
    const limit = Math.min(MAX_LIMIT, max - rows.length);
    const page = await scan({ ...req, limit, offset: rows.length }, opts);
    total = page.total;
    asOf = page.asOf;
    if (page.rows.length === 0) break;
    rows.push(...page.rows);
  }
  return {
    rows,
    total: Number.isFinite(total) ? total : rows.length,
    truncated: rows.length < total,
    asOf,
  };
}
