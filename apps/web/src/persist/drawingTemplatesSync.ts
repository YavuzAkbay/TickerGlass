/**
 * Per-tool drawing templates and default styles <-> `/drawing-templates`.
 * `useDrawingTemplates` keeps its localStorage copy (offline cache). A saved
 * default is stored as the template named DEFAULT_TEMPLATE_NAME with
 * `isDefault: true` (docs/persistence.md §6).
 */
import { resolveDrawingType, type DrawingStyle } from '@tickerglass/engine';
import { createAutosaver, type Autosaver } from '../api/autosave';
import { errorMessage } from '../api/client';
import * as persistence from '../api/persistence';
import type { DrawingTemplate } from '../api/types';
import { useDrawingTemplates } from '../drawings/store';
import { isNotFound, isObj, isTransient, readJson, safeStorage, type SafeStorage } from './net';

export const DRAWING_TEMPLATES_SYNC_KEY = 'tickerglass-drawing-templates-sync';
/** Server name of a tool's default style (reserved: user templates can't use it). */
export const DEFAULT_TEMPLATE_NAME = 'Default';

export type DrawingTemplateApi = Pick<
  typeof persistence,
  'listDrawingTemplates' | 'saveDrawingTemplate' | 'deleteDrawingTemplate'
>;

interface Entry {
  toolType: string;
  name: string;
  style: DrawingStyle;
  isDefault: boolean;
}

const keyOf = (e: Pick<Entry, 'toolType' | 'name'>) => `${e.toolType}\n${e.name}`;

/** The store as server rows. */
export function localEntries(): Map<string, Entry> {
  const s = useDrawingTemplates.getState();
  const out = new Map<string, Entry>();
  for (const [toolType, list] of Object.entries(s.byType))
    for (const t of list)
      if (t.name !== DEFAULT_TEMPLATE_NAME)
        out.set(keyOf({ toolType, name: t.name }), {
          toolType,
          name: t.name,
          style: t.style,
          isDefault: false,
        });
  for (const [toolType, style] of Object.entries(s.defaults))
    out.set(keyOf({ toolType, name: DEFAULT_TEMPLATE_NAME }), {
      toolType,
      name: DEFAULT_TEMPLATE_NAME,
      style,
      isDefault: true,
    });
  return out;
}

const entryJson = (e: Entry) => JSON.stringify([e.style, e.isDefault]);

export interface DrawingTemplatesSyncOptions {
  api?: DrawingTemplateApi;
  storage?: SafeStorage;
  delay?: number;
  retryDelay?: number;
  onError: (message: string) => void;
}

export class DrawingTemplatesSync {
  private readonly api: DrawingTemplateApi;
  private readonly storage: SafeStorage;
  private readonly opts: DrawingTemplatesSyncOptions;
  /** Server row ids and contents by key, as last known. */
  private ids = new Map<string, string>();
  private synced = new Map<string, string>();
  dirty: boolean;
  private loaded = false;
  private applying = false;
  /** Bumped per local change (edits during a flush keep it dirty). */
  private gen = 0;
  private saver: Autosaver<void>;
  private off: (() => void) | null = null;

  constructor(opts: DrawingTemplatesSyncOptions) {
    this.opts = opts;
    this.api = opts.api ?? persistence;
    this.storage = opts.storage ?? safeStorage();
    this.dirty =
      readJson<{ dirty?: unknown }>(this.storage.get(DRAWING_TEMPLATES_SYNC_KEY))?.dirty === true;
    this.saver = createAutosaver<void>(() => this.flushOnce(), {
      delay: opts.delay ?? 500,
      retryDelay: opts.retryDelay ?? 5000,
    });
  }

  start(): void {
    this.off = useDrawingTemplates.subscribe(() => {
      if (this.applying) return;
      this.gen++;
      this.setDirty(true);
      if (this.loaded) this.saver.schedule();
    });
  }

  private setDirty(dirty: boolean): void {
    this.dirty = dirty;
    this.storage.set(DRAWING_TEMPLATES_SYNC_KEY, JSON.stringify({ dirty }));
  }

  /** Adopt the server's templates, or push local ones edited offline. Throws if unreachable. */
  async load(): Promise<void> {
    const rows = await this.api.listDrawingTemplates<DrawingStyle>();
    this.ids.clear();
    this.synced.clear();
    for (const r of rows) {
      const e: Entry = {
        toolType: r.toolType,
        name: r.name,
        style: r.style,
        isDefault: r.isDefault,
      };
      this.ids.set(keyOf(e), r.id);
      this.synced.set(keyOf(e), entryJson(e));
    }
    this.loaded = true;
    if (this.dirty) {
      this.saver.schedule();
      return;
    }
    this.applyRows(rows);
  }

  private applyRows(rows: DrawingTemplate<DrawingStyle>[]): void {
    const byType: Record<string, { name: string; style: DrawingStyle }[]> = {};
    const defaults: Record<string, DrawingStyle> = {};
    let renamed = false;
    // Rows under the current id first: they win over rows under an old id.
    const ordered = rows.filter((r) => resolveDrawingType(r.toolType) === r.toolType);
    ordered.push(...rows.filter((r) => resolveDrawingType(r.toolType) !== r.toolType));
    for (const r of ordered) {
      if (!isObj(r.style)) continue;
      const toolType = resolveDrawingType(r.toolType);
      if (toolType !== r.toolType) renamed = true;
      if (r.isDefault) {
        if (toolType === r.toolType || !(toolType in defaults)) defaults[toolType] = r.style;
      } else {
        const list = (byType[toolType] ??= []);
        if (toolType === r.toolType || !list.some((t) => t.name === r.name))
          list.push({ name: r.name, style: r.style });
      }
    }
    this.applying = true;
    try {
      useDrawingTemplates.setState({ byType, defaults });
    } finally {
      this.applying = false;
    }
    // Old rows are replaced by rows under the current ids.
    if (renamed) {
      this.setDirty(true);
      this.saver.schedule();
    }
  }

  private async flushOnce(): Promise<void> {
    if (!this.dirty || !this.loaded) return;
    const gen = this.gen;
    const local = localEntries();
    try {
      for (const [key, e] of local) {
        const json = entryJson(e);
        if (this.synced.get(key) === json) continue;
        const row = await this.api.saveDrawingTemplate<DrawingStyle>(e);
        this.ids.set(key, row.id);
        this.synced.set(key, json);
      }
      for (const key of [...this.synced.keys()]) {
        if (local.has(key)) continue;
        const id = this.ids.get(key);
        if (id)
          try {
            await this.api.deleteDrawingTemplate(id);
          } catch (err) {
            if (!isNotFound(err)) throw err;
          }
        this.synced.delete(key);
        this.ids.delete(key);
      }
    } catch (err) {
      if (isTransient(err)) throw err;
      this.opts.onError(`Drawing templates could not be saved: ${errorMessage(err)}`);
    }
    this.setDirty(gen !== this.gen);
    if (this.dirty) this.saver.schedule();
  }

  flush(): Promise<void> {
    if (this.dirty && this.loaded) this.saver.schedule();
    return this.saver.flush();
  }

  /** Stop without sending anything more (before an import replaces the server data). */
  async halt(): Promise<void> {
    this.saver.cancel();
    await this.dispose();
  }

  async dispose(): Promise<void> {
    this.off?.();
    await this.saver.dispose();
  }
}
