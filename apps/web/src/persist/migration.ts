/**
 * One-time import of pre-API localStorage data (docs/persistence.md §6).
 * Guarded by the setting MIGRATION_SETTING; idempotent (fixed ids, merge by
 * id/name/key), so a run interrupted before the marker is written can repeat.
 * The original keys are never deleted; a copy is kept under `<key>.premigration`.
 */
import { resolveDrawingType } from '@tickerglass/engine';
import * as persistence from '../api/persistence';
import { BUNDLE_VERSION, type Bundle } from '../api/types';
import { parseStoredDrawings, STORAGE_KEY as DRAWINGS_KEY } from '../drawings/store';
import { migrateNavigator, migrateToolIds } from '../store/ui';
import { LAYOUT_SCHEMA_VERSION, type LayoutState } from './layoutState';
import { DEFAULT_TEMPLATE_NAME } from './drawingTemplatesSync';
import { isNotFound, isObj, readJson, type SafeStorage } from './net';

export const MIGRATION_SETTING = 'migration.localStorage';
/** Fixed ids: re-running the import overwrites instead of duplicating. */
export const MIGRATED_LAYOUT_ID = 'migrated-default-layout';
export const MIGRATED_NOTE_ID = 'migrated-general-note';
export const MIGRATED_LAYOUT_NAME = 'Default';

export const LEGACY_KEYS = [
  DRAWINGS_KEY,
  'tickerglass-indicators',
  'tickerglass-app',
  'tickerglass-indicator-prefs',
  'tickerglass-drawing-templates',
  'tickerglass-ui',
] as const;

export const backupKeyOf = (key: string) => `${key}.premigration`;

export type MigrationApi = Pick<typeof persistence, 'getSetting' | 'putSetting' | 'importAll'>;

/** zustand `persist` value: `{ state, version }`. */
function persisted(storage: SafeStorage, key: string): Record<string, unknown> | null {
  const raw = readJson<unknown>(storage.get(key));
  return isObj(raw) && isObj(raw.state) ? raw.state : null;
}

function pick(src: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (src[k] !== undefined) out[k] = src[k];
  return out;
}

/**
 * The bundle to import, or null when localStorage holds no user data.
 * `layoutState` is the current layout (the stores were loaded from the same keys).
 */
export function buildMigrationBundle(
  storage: SafeStorage,
  layoutState: LayoutState,
): (Partial<Bundle> & Pick<Bundle, 'version' | 'app'>) | null {
  if (!LEGACY_KEYS.some((k) => storage.get(k) !== null)) return null;
  const bundle: Partial<Bundle> & Pick<Bundle, 'version' | 'app'> = {
    version: BUNDLE_VERSION,
    app: 'tickerglass',
    layouts: [],
    drawings: [],
    drawingTemplates: [],
    settings: {},
    notes: [],
  };

  const drawingsRaw = storage.get(DRAWINGS_KEY);
  if (drawingsRaw !== null) {
    const { data } = parseStoredDrawings(drawingsRaw);
    const push = (d: object) =>
      bundle.drawings!.push({ data: d as Record<string, unknown>, schemaVersion: 1 });
    for (const d of data.synced) push(d);
    // The server requires a symbol on symbol-scoped drawings: older data may
    // only have it as the bucket key.
    for (const [sym, list] of Object.entries(data.bySymbol))
      for (const d of list) push(d.symbol.trim() ? d : { ...d, symbol: sym });
  }

  if (storage.get('tickerglass-indicators') !== null || storage.get('tickerglass-app') !== null)
    bundle.layouts!.push({
      id: MIGRATED_LAYOUT_ID,
      name: MIGRATED_LAYOUT_NAME,
      state: layoutState as unknown as Record<string, unknown>,
      schemaVersion: LAYOUT_SCHEMA_VERSION,
      isLastUsed: true,
    });

  const prefs = persisted(storage, 'tickerglass-indicator-prefs');
  if (prefs) {
    if (Array.isArray(prefs.favorites)) bundle.settings!['indicators.favorites'] = prefs.favorites;
    if (isObj(prefs.defaults)) bundle.settings!['indicators.defaults'] = prefs.defaults;
  }

  const templates = persisted(storage, 'tickerglass-drawing-templates');
  if (templates) {
    if (isObj(templates.byType))
      for (const [toolType, list] of Object.entries(templates.byType)) {
        if (!Array.isArray(list)) continue;
        for (const t of list)
          if (isObj(t) && typeof t.name === 'string' && isObj(t.style))
            bundle.drawingTemplates!.push({
              toolType: resolveDrawingType(toolType),
              // The default's name is reserved.
              name: t.name === DEFAULT_TEMPLATE_NAME ? `${t.name} (1)` : t.name,
              style: t.style,
              isDefault: false,
            });
      }
    if (isObj(templates.defaults))
      for (const [toolType, style] of Object.entries(templates.defaults))
        if (isObj(style))
          bundle.drawingTemplates!.push({
            toolType: resolveDrawingType(toolType),
            name: DEFAULT_TEMPLATE_NAME,
            style,
            isDefault: true,
          });
  }

  const app = persisted(storage, 'tickerglass-app');
  if (app)
    bundle.settings!['app.prefs'] = pick(app, [
      'theme',
      'favoriteIntervals',
      'customIntervals',
      'recentSymbols',
      'crosshair',
      'magnet',
    ]);

  const ui = persisted(storage, 'tickerglass-ui');
  if (ui) {
    bundle.settings!['ui.prefs'] = migrateToolIds(
      migrateNavigator(
        pick(ui, [
          'rightPanel',
          'dockTab',
          'rightWidth',
          'navOpen',
          'navSection',
          'navWidth',
          'inspectorWidth',
          'groupTools',
          'favoriteTools',
          'showFavoritesBar',
          'stayInDrawingMode',
          'syncNewDrawings',
          'lockAll',
          'hideAll',
        ]),
      ),
    );
    if (typeof ui.notes === 'string' && ui.notes)
      bundle.notes!.push({ id: MIGRATED_NOTE_ID, symbol: null, text: ui.notes });
  }
  return bundle;
}

/**
 * - `done`: already migrated (by this browser, or another one with no local data here)
 * - `migrated` / `empty`: this run imported this browser's data / found none
 * - `local-data`: the server was migrated from another browser, and this one
 *   has its own pre-API data (kept as a pending import, see `importLocalData`)
 */
export type MigrationResult = 'done' | 'migrated' | 'empty' | 'local-data';

/** This browser's migration outcome (localStorage). */
export const LOCAL_MIGRATION_KEY = 'tickerglass-migration.local';
/** Bundle of this browser's own data, offered for import when another browser migrated first. */
export const LOCAL_BUNDLE_KEY = 'tickerglass-migration.local-bundle';

type LocalOutcome = 'migrated' | 'empty' | 'offered' | 'imported' | 'dismissed';

const localOutcome = (storage: SafeStorage): LocalOutcome | null => {
  const raw = readJson<{ outcome?: unknown }>(storage.get(LOCAL_MIGRATION_KEY));
  return typeof raw?.outcome === 'string' ? (raw.outcome as LocalOutcome) : null;
};

const setLocalOutcome = (storage: SafeStorage, outcome: LocalOutcome, now: number) =>
  storage.set(LOCAL_MIGRATION_KEY, JSON.stringify({ outcome, at: new Date(now).toISOString() }));

/** Copy every legacy key to `<key>.premigration` once (never overwritten, never deleted). */
export function backupLegacyKeys(storage: SafeStorage): void {
  for (const key of LEGACY_KEYS) {
    const raw = storage.get(key);
    if (raw !== null && storage.get(backupKeyOf(key)) === null) storage.set(backupKeyOf(key), raw);
  }
}

/**
 * Run the migration unless the marker setting exists. Call it under
 * `withMigrationLock` (see `migrateExclusive`). Legacy keys are backed up
 * first in every case. Throws when the API is unreachable or rejects the
 * data (the next start retries).
 */
export async function runMigration(
  api: MigrationApi,
  storage: SafeStorage,
  layoutState: () => LayoutState,
  now = Date.now(),
): Promise<MigrationResult> {
  // First contact on any browser: keep the pre-API data before the server's replaces it.
  backupLegacyKeys(storage);
  let marker = false;
  try {
    await api.getSetting(MIGRATION_SETTING);
    marker = true;
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  const outcome = localOutcome(storage);
  if (marker) {
    // Another browser (or an earlier run here) migrated. This browser's own data
    // is offered once for import instead of being silently dropped.
    if (outcome === 'offered' && storage.get(LOCAL_BUNDLE_KEY) !== null) return 'local-data';
    if (outcome !== null) return 'done';
    const local = buildMigrationBundle(storage, layoutState());
    if (!local) {
      setLocalOutcome(storage, 'empty', now);
      return 'done';
    }
    storage.set(LOCAL_BUNDLE_KEY, JSON.stringify(local));
    setLocalOutcome(storage, 'offered', now);
    return 'local-data';
  }
  const bundle = buildMigrationBundle(storage, layoutState());
  if (bundle) {
    // Validate everything before writing anything.
    await api.importAll(bundle, { mode: 'merge', dryRun: true });
    await api.importAll(bundle, { mode: 'merge' });
  }
  await api.putSetting(MIGRATION_SETTING, {
    version: 1,
    at: new Date(now).toISOString(),
    imported: !!bundle,
  });
  setLocalOutcome(storage, bundle ? 'migrated' : 'empty', now);
  return bundle ? 'migrated' : 'empty';
}

/** What `importLocalData` would add: drawing and layout counts of the pending local bundle. */
export function localDataSummary(
  storage: SafeStorage,
): { drawings: number; layout: boolean } | null {
  const b = readJson<Partial<Bundle>>(storage.get(LOCAL_BUNDLE_KEY));
  if (!b) return null;
  return { drawings: b.drawings?.length ?? 0, layout: !!b.layouts?.length };
}

/**
 * Import this browser's own pre-API data (when another browser migrated
 * first): its layout as a new layout, its drawings and its note. Settings and
 * templates are left out so the server's preferences are not overwritten.
 * Returns the new layout's name, if one was created.
 */
export async function importLocalData(
  api: MigrationApi,
  storage: SafeStorage,
  now = Date.now(),
): Promise<string | null> {
  const local = readJson<Partial<Bundle>>(storage.get(LOCAL_BUNDLE_KEY));
  if (!local) return null;
  const stamp = new Date(now).toISOString().slice(0, 10);
  const name = `From this browser (${stamp})`;
  const suffix = now.toString(36);
  const bundle: Partial<Bundle> & Pick<Bundle, 'version' | 'app'> = {
    version: BUNDLE_VERSION,
    app: 'tickerglass',
    layouts: (local.layouts ?? []).map((l) => ({
      ...l,
      id: `local-${suffix}`,
      name,
      isLastUsed: false,
    })),
    drawings: local.drawings ?? [],
    notes: (local.notes ?? []).map((n) => ({ ...n, id: `local-note-${suffix}` })),
  };
  await api.importAll(bundle, { mode: 'merge', dryRun: true });
  await api.importAll(bundle, { mode: 'merge' });
  storage.remove(LOCAL_BUNDLE_KEY);
  setLocalOutcome(storage, 'imported', now);
  return bundle.layouts!.length ? name : null;
}

/** The user declined importing this browser's data (the `.premigration` backups stay). */
export function dismissLocalData(storage: SafeStorage, now = Date.now()): void {
  storage.remove(LOCAL_BUNDLE_KEY);
  setLocalOutcome(storage, 'dismissed', now);
}

// ------------------------------------------------------------ mutual exclusion

export const MIGRATION_LOCK = 'tickerglass-migration';
export const LEASE_KEY = 'tickerglass-migration.lease';
const LEASE_MS = 30_000;

export interface LockManagerLike {
  request<T>(name: string, options: { signal?: AbortSignal }, fn: () => Promise<T>): Promise<T>;
}

export interface LockOptions {
  /** `navigator.locks` (default); null forces the localStorage lease. */
  locks?: LockManagerLike | null;
  storage: SafeStorage;
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const abortError = () => new DOMException('Aborted', 'AbortError');

/**
 * Run `fn` while holding the migration lock, so only one tab migrates at a
 * time: Web Locks when available, else a localStorage lease with expiry
 * (best effort; an expired lease of a crashed tab is taken over).
 */
export async function withMigrationLock<T>(fn: () => Promise<T>, opts: LockOptions): Promise<T> {
  const locks =
    opts.locks === undefined
      ? ((globalThis.navigator as { locks?: LockManagerLike } | undefined)?.locks ?? null)
      : opts.locks;
  if (locks) return locks.request(MIGRATION_LOCK, opts.signal ? { signal: opts.signal } : {}, fn);
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const owner = `${now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const { storage } = opts;
  for (;;) {
    if (opts.signal?.aborted) throw abortError();
    const lease = readJson<{ owner?: string; until?: number }>(storage.get(LEASE_KEY));
    if (!lease || typeof lease.until !== 'number' || lease.until < now()) {
      storage.set(LEASE_KEY, JSON.stringify({ owner, until: now() + LEASE_MS }));
      // Another tab may have written at the same moment: the last write wins.
      if (readJson<{ owner?: string }>(storage.get(LEASE_KEY))?.owner === owner) break;
    }
    await sleep(250);
  }
  try {
    return await fn();
  } finally {
    if (readJson<{ owner?: string }>(storage.get(LEASE_KEY))?.owner === owner)
      storage.remove(LEASE_KEY);
  }
}

let inflight: Promise<MigrationResult> | null = null;

/**
 * `runMigration` under the lock, once at a time per page: concurrent callers
 * (React StrictMode's double start, reconnects) share one run. `signal` only
 * stops this caller waiting; a run that started finishes.
 */
export function migrateExclusive(
  api: MigrationApi,
  storage: SafeStorage,
  layoutState: () => LayoutState,
  opts: Omit<LockOptions, 'storage' | 'signal'> & { signal?: AbortSignal } = {},
): Promise<MigrationResult> {
  const { signal, ...lockOpts } = opts;
  inflight ??= withMigrationLock(() => runMigration(api, storage, layoutState), {
    ...lockOpts,
    storage,
  }).finally(() => (inflight = null));
  const run = inflight;
  if (!signal) return run;
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    signal.addEventListener('abort', () => reject(abortError()), { once: true });
    run.then(resolve, reject);
  });
}
