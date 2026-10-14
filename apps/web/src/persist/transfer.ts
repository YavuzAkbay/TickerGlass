/**
 * Import of a full backup (Import data dialog). The running persistence is
 * stopped first, so no autosave, pagehide flush or recovery copy pushes the
 * old local state over the imported data; local caches are dropped and the
 * page reloads from the server.
 */
import * as persistence from '../api/persistence';
import type { Bundle, ImportMode } from '../api/types';
import { STORAGE_KEY as DRAWINGS_CACHE_KEY } from '../drawings/store';
import type { Persistence } from './bootstrap';
import { DRAWING_SYNC_KEY } from './drawingSync';
import { DRAWING_TEMPLATES_SYNC_KEY } from './drawingTemplatesSync';
import { LAYOUT_CACHE_KEY, useLayoutStatus } from './layouts';
import { LOCAL_BUNDLE_KEY, LOCAL_MIGRATION_KEY, MIGRATION_SETTING } from './migration';
import type { SafeStorage } from './net';
import { SETTINGS_SYNC_KEY } from './settingsSync';

export type ImportBundle = Partial<Bundle> & Pick<Bundle, 'version' | 'app'>;

/** Every section of a full backup: "Replace" is only offered for a full bundle. */
export const BUNDLE_SECTIONS = [
  'layouts',
  'drawings',
  'indicatorTemplates',
  'drawingTemplates',
  'chartTemplates',
  'settings',
  'notes',
  'watchlists',
  'flags',
] as const;

/** Sections every full backup has (Phase 7); older backups lack the later ones. */
export const REQUIRED_SECTIONS = [
  'layouts',
  'drawings',
  'indicatorTemplates',
  'drawingTemplates',
  'chartTemplates',
  'settings',
  'notes',
] as const;

export const isFullBundle = (b: ImportBundle): boolean =>
  REQUIRED_SECTIONS.every((k) => b[k] !== undefined);

/** Local caches the server data replaces after an import. */
export const CACHE_KEYS = [
  LAYOUT_CACHE_KEY,
  DRAWING_SYNC_KEY,
  DRAWINGS_CACHE_KEY,
  SETTINGS_SYNC_KEY,
  DRAWING_TEMPLATES_SYNC_KEY,
  'investopen-notes',
  'investopen-watchlists',
  'investopen-watchlist-prefs',
  LOCAL_BUNDLE_KEY,
];

export type TransferApi = Pick<typeof persistence, 'importAll' | 'putSetting'>;

export interface ImportDeps {
  api?: TransferApi;
  storage: SafeStorage;
  persistence: Pick<Persistence, 'flushAll' | 'halt' | 'drawings' | 'layouts'> | null;
  reload: () => void;
  now?: number;
}

/**
 * Apply `bundle`: save pending local changes, stop persistence, import, keep
 * the migration marker (a replace of the settings section would delete it and
 * the next start would re-import this browser's old data), drop local caches,
 * reload. Throws (persistence stopped: reload to continue) if the import fails;
 * throws before stopping anything if local changes could not be saved.
 */
export async function importBundle(
  bundle: ImportBundle,
  mode: ImportMode,
  deps: ImportDeps,
): Promise<void> {
  const api = deps.api ?? persistence;
  const p = deps.persistence;
  if (p) {
    await p.flushAll();
    if (p.drawings.hasPending || useLayoutStatus.getState().dirty)
      throw new Error('Local changes could not be saved first; nothing was imported');
    await p.halt();
  }
  await api.importAll(bundle, { mode, ...(mode === 'replace' ? { confirm: true } : {}) });
  const at = new Date(deps.now ?? Date.now()).toISOString();
  await api.putSetting(MIGRATION_SETTING, { version: 1, at, imported: false, via: 'import' });
  for (const key of CACHE_KEYS) deps.storage.remove(key);
  // This browser's pre-API data was superseded by the import: don't offer it.
  deps.storage.set(LOCAL_MIGRATION_KEY, JSON.stringify({ outcome: 'dismissed', at }));
  deps.reload();
}

/**
 * Keep only the latest of overlapping async requests (dry runs on mode switch):
 * `begin()` returns a check that is true while no newer request began.
 */
export function latestOnly(): { begin: () => () => boolean; invalidate: () => void } {
  let seq = 0;
  return {
    begin: () => {
      const n = ++seq;
      return () => n === seq;
    },
    invalidate: () => void ++seq,
  };
}
