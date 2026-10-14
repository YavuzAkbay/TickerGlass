/**
 * User preferences <-> `/settings` (last writer wins per key). The zustand
 * stores keep their localStorage copies (offline cache); changed keys are
 * remembered as dirty (persisted) until the server has them, so edits made
 * offline are pushed on the next start instead of being overwritten.
 */
import { createAutosaver, type Autosaver } from '../api/autosave';
import { errorMessage } from '../api/client';
import * as persistence from '../api/persistence';
import type { Settings } from '../api/types';
import { parseAlertPrefs, readAlertPrefs, useAlertPrefs } from '../alerts/prefs';
import { useIndicatorPrefs } from '../indicators/store';
import { useAppStore } from '../store/app';
import { useUiStore, type RightPanel } from '../store/ui';
import { parsePrefs, useWatchlistPrefs } from '../watchlist/prefs';

const PANELS: (RightPanel | null)[] = [
  'watchlist',
  'alerts',
  'objectTree',
  'dataWindow',
  'details',
  'news',
  'notes',
];
import { isObj, isTransient, readJson, safeStorage, type SafeStorage } from './net';

export const SETTINGS_SYNC_KEY = 'investopen-settings-sync';

export type SettingsApi = Pick<typeof persistence, 'getSettings' | 'patchSettings'>;

export interface SettingDef {
  key: string;
  read: () => unknown;
  /** Apply a server value (validate: it may come from an import or another version). */
  write: (value: unknown) => void;
  /** Store subscription that fires when the value may have changed. */
  subscribe: (fn: () => void) => () => void;
}

/** Copy fields of `value` whose type matches the current one (arrays stay arrays). */
export function pickTyped<T extends object>(current: T, value: unknown): Partial<T> {
  if (!isObj(value)) return {};
  const out: Partial<T> = {};
  for (const k of Object.keys(current) as (keyof T)[]) {
    const v = value[k as string];
    const c = current[k];
    if (v === undefined) continue;
    if (
      Array.isArray(c) ? Array.isArray(v) : typeof v === typeof c && (c === null) === (v === null)
    )
      out[k] = v as T[keyof T];
  }
  return out;
}

const APP_PREFS = [
  'theme',
  'favoriteIntervals',
  'customIntervals',
  'recentSymbols',
  'crosshair',
  'magnet',
] as const;

const UI_PREFS = [
  'rightPanel',
  'rightWidth',
  'groupTools',
  'favoriteTools',
  'showFavoritesBar',
  'stayInDrawingMode',
  'syncNewDrawings',
  'lockAll',
  'hideAll',
] as const;

function pickKeys<T extends object, K extends keyof T>(obj: T, keys: readonly K[]): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const k of keys) out[k] = obj[k];
  return out;
}

/** The synced preference keys (docs/persistence.md §6). */
export const SETTING_DEFS: SettingDef[] = [
  {
    key: 'app.prefs',
    read: () => pickKeys(useAppStore.getState(), APP_PREFS),
    write: (v) => {
      const cur = pickKeys(useAppStore.getState(), APP_PREFS);
      // Theme must be a known value.
      const patch = pickTyped(cur, v);
      if (patch.theme && patch.theme !== 'dark' && patch.theme !== 'light') delete patch.theme;
      useAppStore.getState().set(patch);
    },
    subscribe: (fn) => useAppStore.subscribe(fn),
  },
  {
    key: 'ui.prefs',
    read: () => pickKeys(useUiStore.getState(), UI_PREFS),
    write: (v) => {
      const { rightPanel: _p, ...cur } = pickKeys(useUiStore.getState(), UI_PREFS);
      const patch: Partial<ReturnType<typeof useUiStore.getState>> = pickTyped(cur, v);
      // Nullable: validated against the known panels.
      if (isObj(v) && (v.rightPanel === null || typeof v.rightPanel === 'string'))
        patch.rightPanel = PANELS.includes(v.rightPanel as RightPanel)
          ? (v.rightPanel as RightPanel)
          : null;
      useUiStore.getState().set(patch);
    },
    subscribe: (fn) => useUiStore.subscribe(fn),
  },
  {
    key: 'indicators.favorites',
    read: () => useIndicatorPrefs.getState().favorites,
    write: (v) => {
      if (Array.isArray(v))
        useIndicatorPrefs.setState({ favorites: v.filter((x) => typeof x === 'string') });
    },
    subscribe: (fn) => useIndicatorPrefs.subscribe(fn),
  },
  {
    key: 'indicators.defaults',
    read: () => useIndicatorPrefs.getState().defaults,
    write: (v) => {
      if (isObj(v))
        useIndicatorPrefs.setState({
          defaults: v as ReturnType<typeof useIndicatorPrefs.getState>['defaults'],
        });
    },
    subscribe: (fn) => useIndicatorPrefs.subscribe(fn),
  },
  {
    key: 'watchlist.prefs',
    read: () => {
      const { activeId, columns, sort } = useWatchlistPrefs.getState();
      return { activeId, columns, sort };
    },
    write: (v) => useWatchlistPrefs.setState(parsePrefs(v)),
    subscribe: (fn) => useWatchlistPrefs.subscribe(fn),
  },
  {
    key: 'alerts.prefs',
    read: readAlertPrefs,
    write: (v) => useAlertPrefs.setState(parseAlertPrefs(v)),
    subscribe: (fn) => useAlertPrefs.subscribe(fn),
  },
];

export interface SettingsSyncOptions {
  api?: SettingsApi;
  storage?: SafeStorage;
  defs?: SettingDef[];
  delay?: number;
  retryDelay?: number;
  onError: (message: string) => void;
}

export class SettingsSync {
  private readonly api: SettingsApi;
  private readonly storage: SafeStorage;
  private readonly defs: SettingDef[];
  private readonly opts: SettingsSyncOptions;
  /** JSON the server is known to hold, per key. */
  private synced = new Map<string, string>();
  readonly dirty: Set<string>;
  private saver: Autosaver<void>;
  private offs: (() => void)[] = [];
  private applying = false;

  constructor(opts: SettingsSyncOptions) {
    this.opts = opts;
    this.api = opts.api ?? persistence;
    this.storage = opts.storage ?? safeStorage();
    this.defs = opts.defs ?? SETTING_DEFS;
    const raw = readJson<{ dirty?: unknown }>(this.storage.get(SETTINGS_SYNC_KEY));
    this.dirty = new Set(
      Array.isArray(raw?.dirty) ? raw.dirty.filter((k): k is string => typeof k === 'string') : [],
    );
    this.saver = createAutosaver<void>(() => this.flushOnce(), {
      delay: opts.delay ?? 800,
      retryDelay: opts.retryDelay ?? 5000,
    });
  }

  /** Track local changes (before `load`, so offline edits are recorded as dirty). */
  start(): void {
    for (const def of this.defs) {
      this.baseline.set(def.key, JSON.stringify(def.read()));
      this.offs.push(def.subscribe(() => this.onChange(def)));
    }
  }

  /** Values at `start` (before the first load): unchanged ones are not offline edits. */
  private baseline = new Map<string, string>();
  /** Values the server rejected (permanent error), by key. */
  private rejected = new Map<string, string>();
  private loaded = false;

  private saveDirty(): void {
    this.storage.set(SETTINGS_SYNC_KEY, JSON.stringify({ dirty: [...this.dirty] }));
  }

  private onChange(def: SettingDef): void {
    if (this.applying) return;
    const json = JSON.stringify(def.read());
    const known = this.loaded ? this.synced.get(def.key) : this.baseline.get(def.key);
    if (known === json || (this.dirty.has(def.key) && !this.loaded)) return;
    this.dirty.add(def.key);
    this.saveDirty();
    // Before the first load, offline edits are only recorded; `load` pushes them.
    if (this.loaded) this.saver.schedule();
  }

  /**
   * Adopt the server's values, except for keys edited locally while offline
   * (and keys the server lacks), which are pushed. Throws if unreachable.
   */
  async load(server?: Settings): Promise<Settings> {
    const all = server ?? (await this.api.getSettings());
    this.applying = true;
    try {
      for (const def of this.defs) {
        if (this.dirty.has(def.key) || !(def.key in all)) {
          this.dirty.add(def.key);
          continue;
        }
        try {
          def.write(all[def.key]);
        } catch (err) {
          this.opts.onError(`Setting "${def.key}" could not be applied: ${errorMessage(err)}`);
        }
        this.synced.set(def.key, JSON.stringify(def.read()));
      }
    } finally {
      this.applying = false;
    }
    this.loaded = true;
    this.saveDirty();
    if (this.dirty.size) this.saver.schedule();
    return all;
  }

  private async flushOnce(): Promise<void> {
    if (!this.dirty.size) return;
    const patch: Settings = {};
    const sent = new Map<string, string>();
    for (const def of this.defs) {
      if (!this.dirty.has(def.key)) continue;
      const value = def.read();
      const json = JSON.stringify(value);
      if (this.rejected.get(def.key) === json) continue;
      patch[def.key] = value ?? null;
      sent.set(def.key, json);
    }
    if (!sent.size) return;
    try {
      await this.api.patchSettings(patch);
    } catch (err) {
      if (isTransient(err)) throw err;
      // Keep them dirty (the next start pushes them instead of taking the server's),
      // but don't resend these values in this session.
      for (const [k, json] of sent) this.rejected.set(k, json);
      this.opts.onError(`Settings could not be saved: ${errorMessage(err)}`);
      return;
    }
    for (const [k, json] of sent) {
      this.synced.set(k, json);
      // Changed again while in flight: stays dirty for the next round.
      const def = this.defs.find((d) => d.key === k);
      if (def && JSON.stringify(def.read()) === json) this.dirty.delete(k);
    }
    this.saveDirty();
    if (this.dirty.size) this.saver.schedule();
  }

  flush(): Promise<void> {
    if (this.dirty.size && this.loaded) this.saver.schedule();
    return this.saver.flush();
  }

  /** Stop without sending anything more (before an import replaces the server data). */
  async halt(): Promise<void> {
    this.saver.cancel();
    await this.dispose();
  }

  async dispose(): Promise<void> {
    this.offs.forEach((off) => off());
    this.offs = [];
    await this.saver.dispose();
  }
}
