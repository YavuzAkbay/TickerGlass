/**
 * Offline cache for named templates (indicator and chart templates). The
 * server stays the source of truth: every read refreshes the cache, and a
 * save or delete that cannot reach the API (`isTransient`) is applied to the
 * cache and queued; the queue is pushed by `sync()` on the next contact.
 */
import * as persistence from '../api/persistence';
import type { IndicatorState } from '../indicators/model';
import { isNotFound, isObj, isTransient, readJson, safeStorage, type SafeStorage } from './net';

export const INDICATOR_TEMPLATES_CACHE_KEY = 'investopen-indicator-templates-cache';
export const CHART_TEMPLATES_CACHE_KEY = 'investopen-chart-templates-cache';

/** A template as the UI sees it, whatever the content field is called on the wire. */
export interface TemplateRow<D> {
  /** Server id; `local:<name>` while the template only exists in this browser. */
  id: string;
  name: string;
  data: D;
  schemaVersion: number;
}

export interface TemplateApi<D> {
  list: () => Promise<TemplateRow<D>[]>;
  save: (body: { name: string; data: D; schemaVersion: number }) => Promise<TemplateRow<D>>;
  remove: (id: string) => Promise<void>;
}

interface CacheState<D> {
  items: TemplateRow<D>[];
  /** Names saved offline, not yet on the server. */
  pendingSaves: string[];
  /** Server ids deleted offline. */
  pendingDeletes: string[];
}

export interface TemplateResult {
  /** True when the change is only in this browser so far. */
  offline: boolean;
}

const isLocalId = (id: string) => id.startsWith('local:');

function parseRow<D>(raw: unknown): TemplateRow<D> | null {
  if (!isObj(raw) || typeof raw.id !== 'string' || typeof raw.name !== 'string') return null;
  return {
    id: raw.id,
    name: raw.name,
    data: raw.data as D,
    schemaVersion: typeof raw.schemaVersion === 'number' ? raw.schemaVersion : 1,
  };
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

export class OfflineTemplates<D> {
  constructor(
    private readonly key: string,
    private readonly api: TemplateApi<D>,
    private readonly storage: SafeStorage = safeStorage(),
  ) {}

  private read(): CacheState<D> {
    const raw = readJson<Record<string, unknown>>(this.storage.get(this.key));
    const items: TemplateRow<D>[] = [];
    if (Array.isArray(raw?.items))
      for (const r of raw.items) {
        const row = parseRow<D>(r);
        if (row) items.push(row);
      }
    return {
      items,
      pendingSaves: strings(raw?.pendingSaves),
      pendingDeletes: strings(raw?.pendingDeletes),
    };
  }

  private write(state: CacheState<D>): void {
    this.storage.set(this.key, JSON.stringify(state));
  }

  /** True when changes made offline wait for the server. */
  hasPending(): boolean {
    const s = this.read();
    return s.pendingSaves.length > 0 || s.pendingDeletes.length > 0;
  }

  /** Cached templates with offline changes applied. */
  cached(): TemplateRow<D>[] {
    return this.read().items;
  }

  /** Push queued offline changes. Throws when the API is unreachable (the queue is kept). */
  async sync(): Promise<void> {
    const state = this.read();
    for (const id of [...state.pendingDeletes]) {
      try {
        await this.api.remove(id);
      } catch (err) {
        if (isTransient(err)) throw err;
        // 404 and other permanent errors: nothing left to delete.
      }
      state.pendingDeletes = state.pendingDeletes.filter((x) => x !== id);
      this.write(state);
    }
    for (const name of [...state.pendingSaves]) {
      const row = state.items.find((r) => r.name === name);
      if (row) {
        try {
          const saved = await this.api.save({
            name,
            data: row.data,
            schemaVersion: row.schemaVersion,
          });
          row.id = saved.id;
        } catch (err) {
          if (isTransient(err)) throw err;
          // A permanent rejection (409, 422) would fail again: drop the offline copy.
          state.items = state.items.filter((r) => r !== row);
        }
      }
      state.pendingSaves = state.pendingSaves.filter((x) => x !== name);
      this.write(state);
    }
  }

  /** Server templates (after pushing queued changes); the cache when unreachable. */
  async list(): Promise<{ items: TemplateRow<D>[]; offline: boolean }> {
    try {
      await this.sync();
      const items = await this.api.list();
      this.write({ items, pendingSaves: [], pendingDeletes: [] });
      return { items, offline: false };
    } catch (err) {
      if (!isTransient(err)) throw err;
      return { items: this.read().items, offline: true };
    }
  }

  /** Create or replace by name. Non-transient API errors are thrown. */
  async save(name: string, data: D, schemaVersion: number): Promise<TemplateResult> {
    try {
      await this.sync();
      const row = await this.api.save({ name, data, schemaVersion });
      const cur = this.read();
      cur.items = [...cur.items.filter((r) => r.name !== name), row];
      this.write(cur);
      return { offline: false };
    } catch (err) {
      if (!isTransient(err)) throw err;
    }
    const cur = this.read();
    const old = cur.items.find((r) => r.name === name);
    const row: TemplateRow<D> = { id: old?.id ?? `local:${name}`, name, data, schemaVersion };
    cur.items = [...cur.items.filter((r) => r.name !== name), row];
    if (!cur.pendingSaves.includes(name)) cur.pendingSaves.push(name);
    this.write(cur);
    return { offline: true };
  }

  /** Delete. Non-transient API errors (other than 404) are thrown. */
  async remove(row: TemplateRow<D>): Promise<TemplateResult> {
    const state = this.read();
    let offline = false;
    if (!isLocalId(row.id)) {
      try {
        await this.api.remove(row.id);
      } catch (err) {
        if (isTransient(err)) {
          offline = true;
          if (!state.pendingDeletes.includes(row.id)) state.pendingDeletes.push(row.id);
        } else if (!isNotFound(err)) throw err;
      }
    }
    state.items = state.items.filter((r) => r.id !== row.id);
    state.pendingSaves = state.pendingSaves.filter((n) => n !== row.name);
    this.write(state);
    return { offline };
  }
}

export const indicatorTemplates = new OfflineTemplates<IndicatorState[]>(
  INDICATOR_TEMPLATES_CACHE_KEY,
  {
    list: async () =>
      (await persistence.listIndicatorTemplates<IndicatorState>()).map((t) => ({
        id: t.id,
        name: t.name,
        data: t.instances,
        schemaVersion: t.schemaVersion,
      })),
    save: async (b) => {
      const t = await persistence.saveIndicatorTemplate<IndicatorState>({
        name: b.name,
        instances: b.data,
        schemaVersion: b.schemaVersion,
      });
      return { id: t.id, name: t.name, data: t.instances, schemaVersion: t.schemaVersion };
    },
    remove: (id) => persistence.deleteIndicatorTemplate(id),
  },
);

export const chartTemplates = new OfflineTemplates<Record<string, unknown>>(
  CHART_TEMPLATES_CACHE_KEY,
  {
    list: async () =>
      (await persistence.listChartTemplates()).map((t) => ({
        id: t.id,
        name: t.name,
        data: t.data,
        schemaVersion: t.schemaVersion,
      })),
    save: async (b) => {
      const t = await persistence.saveChartTemplate({
        name: b.name,
        data: b.data,
        schemaVersion: b.schemaVersion,
      });
      return { id: t.id, name: t.name, data: t.data, schemaVersion: t.schemaVersion };
    },
    remove: (id) => persistence.deleteChartTemplate(id),
  },
);
