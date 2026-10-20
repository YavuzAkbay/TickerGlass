/**
 * Typed calls for the user-data endpoints (docs/persistence.md): layouts,
 * drawings, templates, settings, notes, user scripts, import/export, plus helpers that read
 * 409 conflict bodies.
 */
import { ApiError, requestJson, type RequestOptions } from './client';
import type {
  Bundle,
  ChartTemplate,
  ChartTemplateIn,
  DrawingBatch,
  DrawingBatchResult,
  DrawingConflict,
  DrawingTemplate,
  DrawingTemplateIn,
  ImportMode,
  ImportSummary,
  IndicatorTemplate,
  IndicatorTemplateIn,
  Layout,
  LayoutFile,
  LayoutSummary,
  Flag,
  Note,
  Settings,
  StoredDrawing,
  UserScript,
  UserScriptIn,
  Watchlist,
} from './types';
import type { FlagColor, WatchlistItem } from '../watchlist/types';

type Opts = Pick<RequestOptions, 'signal' | 'keepalive'>;
const seg = encodeURIComponent;

// ------------------------------------------------------------ layouts

export const listLayouts = (o?: Opts) =>
  requestJson<LayoutSummary[]>('GET', '/layouts', undefined, o);

export const getLayout = <S = Record<string, unknown>>(id: string, o?: Opts) =>
  requestJson<Layout<S>>('GET', `/layouts/${seg(id)}`, undefined, o);

/** Create a layout (also "save as": the current state under a new name). */
export const createLayout = <S>(
  body: { name: string; state: S; schemaVersion?: number },
  o?: Opts,
) => requestJson<Layout<S>>('POST', '/layouts', body, o);

/** Save the state. Rejects with ApiError 409 (see `layoutConflict`) unless `revision` is current. */
export const saveLayout = <S>(
  id: string,
  body: { state: S; revision: number; schemaVersion?: number },
  o?: Opts,
) => requestJson<Layout<S>>('PUT', `/layouts/${seg(id)}`, body, o);

/** Rename (does not change `revision`). */
export const renameLayout = (id: string, name: string, o?: Opts) =>
  requestJson<LayoutSummary>('PATCH', `/layouts/${seg(id)}`, { name }, o);

/** Copy the stored state under a new name. */
export const duplicateLayout = <S = Record<string, unknown>>(id: string, name: string, o?: Opts) =>
  requestJson<Layout<S>>('POST', `/layouts/${seg(id)}/duplicate`, { name }, o);

export const deleteLayout = (id: string, o?: Opts) =>
  requestJson<void>('DELETE', `/layouts/${seg(id)}`, undefined, o);

/** The layout to restore on startup, or null. */
export const getLastUsedLayout = <S = Record<string, unknown>>(o?: Opts) =>
  requestJson<Layout<S> | null>('GET', '/layouts/last-used', undefined, o);

export const setLastUsedLayout = (id: string, o?: Opts) =>
  requestJson<void>('PUT', '/layouts/last-used', { id }, o);

export const exportLayout = <S = Record<string, unknown>>(id: string, o?: Opts) =>
  requestJson<LayoutFile<S>>('GET', `/layouts/${seg(id)}/export`, undefined, o);

/** Create a new layout from an export file (`name` overrides the file's). */
export const importLayout = <S>(file: LayoutFile<S>, name?: string, o?: Opts) =>
  requestJson<Layout<S>>('POST', '/layouts/import', file, { ...o, query: { name } });

// ------------------------------------------------------------ drawings

/** All drawings, or those of `symbol` plus (unless `synced: false`) the synced ones. */
export const getDrawings = <D = Record<string, unknown>>(
  q: { symbol?: string; synced?: boolean } = {},
  o?: Opts,
) =>
  requestJson<{ drawings: StoredDrawing<D>[] }>('GET', '/drawings', undefined, {
    ...o,
    query: { symbol: q.symbol, synced: q.synced },
  }).then((r) => r.drawings);

/** Upserts + deletes in one all-or-nothing transaction. 409: see `drawingConflicts`. */
export const batchDrawings = <D>(batch: DrawingBatch<D>, o?: Opts) =>
  requestJson<DrawingBatchResult<D>>('POST', '/drawings/batch', batch, o);

// ------------------------------------------------------------ templates

export const listIndicatorTemplates = <I = unknown>(o?: Opts) =>
  requestJson<IndicatorTemplate<I>[]>('GET', '/indicator-templates', undefined, o);
export const getIndicatorTemplate = <I = unknown>(id: string, o?: Opts) =>
  requestJson<IndicatorTemplate<I>>('GET', `/indicator-templates/${seg(id)}`, undefined, o);
/** Create, or replace the template with the same name. */
export const saveIndicatorTemplate = <I>(body: IndicatorTemplateIn<I>, o?: Opts) =>
  requestJson<IndicatorTemplate<I>>('POST', '/indicator-templates', body, o);
/** Edit by id (409 if renamed onto another template's name). */
export const updateIndicatorTemplate = <I>(id: string, body: IndicatorTemplateIn<I>, o?: Opts) =>
  requestJson<IndicatorTemplate<I>>('PUT', `/indicator-templates/${seg(id)}`, body, o);
export const deleteIndicatorTemplate = (id: string, o?: Opts) =>
  requestJson<void>('DELETE', `/indicator-templates/${seg(id)}`, undefined, o);

export const listDrawingTemplates = <S = Record<string, unknown>>(toolType?: string, o?: Opts) =>
  requestJson<DrawingTemplate<S>[]>('GET', '/drawing-templates', undefined, {
    ...o,
    query: { toolType },
  });
export const getDrawingTemplate = <S = Record<string, unknown>>(id: string, o?: Opts) =>
  requestJson<DrawingTemplate<S>>('GET', `/drawing-templates/${seg(id)}`, undefined, o);
/** Create, or replace by (toolType, name). `isDefault` clears the tool's other default. */
export const saveDrawingTemplate = <S>(body: DrawingTemplateIn<S>, o?: Opts) =>
  requestJson<DrawingTemplate<S>>('POST', '/drawing-templates', body, o);
export const updateDrawingTemplate = <S>(id: string, body: DrawingTemplateIn<S>, o?: Opts) =>
  requestJson<DrawingTemplate<S>>('PUT', `/drawing-templates/${seg(id)}`, body, o);
export const deleteDrawingTemplate = (id: string, o?: Opts) =>
  requestJson<void>('DELETE', `/drawing-templates/${seg(id)}`, undefined, o);

export const listChartTemplates = <T = Record<string, unknown>>(o?: Opts) =>
  requestJson<ChartTemplate<T>[]>('GET', '/chart-templates', undefined, o);
export const getChartTemplate = <T = Record<string, unknown>>(id: string, o?: Opts) =>
  requestJson<ChartTemplate<T>>('GET', `/chart-templates/${seg(id)}`, undefined, o);
/** Create, or replace the template with the same name. */
export const saveChartTemplate = <T>(body: ChartTemplateIn<T>, o?: Opts) =>
  requestJson<ChartTemplate<T>>('POST', '/chart-templates', body, o);
export const updateChartTemplate = <T>(id: string, body: ChartTemplateIn<T>, o?: Opts) =>
  requestJson<ChartTemplate<T>>('PUT', `/chart-templates/${seg(id)}`, body, o);
export const deleteChartTemplate = (id: string, o?: Opts) =>
  requestJson<void>('DELETE', `/chart-templates/${seg(id)}`, undefined, o);

// ------------------------------------------------------------ settings

export const getSettings = (o?: Opts) => requestJson<Settings>('GET', '/settings', undefined, o);
/** Rejects with ApiError 404 when the key is not set. */
export const getSetting = <V = unknown>(key: string, o?: Opts) =>
  requestJson<V>('GET', `/settings/${seg(key)}`, undefined, o);
/** `value` must not be null (use deleteSetting). */
export const putSetting = (key: string, value: unknown, o?: Opts) =>
  requestJson<void>('PUT', `/settings/${seg(key)}`, { value }, o);
/** Set several keys; null deletes a key. Resolves to all settings. */
export const patchSettings = (patch: Settings, o?: Opts) =>
  requestJson<Settings>('PATCH', '/settings', patch, o);
export const deleteSetting = (key: string, o?: Opts) =>
  requestJson<void>('DELETE', `/settings/${seg(key)}`, undefined, o);

// ------------------------------------------------------------ notes

export const listNotes = (symbol?: string, o?: Opts) =>
  requestJson<Note[]>('GET', '/notes', undefined, { ...o, query: { symbol } });
export const getNote = (id: string, o?: Opts) =>
  requestJson<Note>('GET', `/notes/${seg(id)}`, undefined, o);
export const createNote = (body: { text: string; symbol?: string | null }, o?: Opts) =>
  requestJson<Note>('POST', '/notes', body, o);
/** With `revision`, rejects with 409 (see `noteConflict`) if the note changed elsewhere. */
export const updateNote = (
  id: string,
  body: { text: string; symbol?: string | null; revision?: number },
  o?: Opts,
) => requestJson<Note>('PUT', `/notes/${seg(id)}`, body, o);
export const deleteNote = (id: string, o?: Opts) =>
  requestJson<void>('DELETE', `/notes/${seg(id)}`, undefined, o);

// ------------------------------------------------------------ user scripts

export const listUserScripts = (o?: Opts) =>
  requestJson<UserScript[]>('GET', '/user-scripts', undefined, o);
export const getUserScript = (id: string, o?: Opts) =>
  requestJson<UserScript>('GET', `/user-scripts/${seg(id)}`, undefined, o);
/** Rejects with 409 (see `userScriptConflict`) if the client `id` exists. */
export const createUserScript = (body: { id: string } & UserScriptIn, o?: Opts) =>
  requestJson<UserScript>('POST', '/user-scripts', body, o);
/** With `revision`, rejects with 409 (see `userScriptConflict`) if the script changed elsewhere. */
export const updateUserScript = (
  id: string,
  body: UserScriptIn & { revision?: number },
  o?: Opts,
) => requestJson<UserScript>('PUT', `/user-scripts/${seg(id)}`, body, o);
export const deleteUserScript = (id: string, o?: Opts) =>
  requestJson<void>('DELETE', `/user-scripts/${seg(id)}`, undefined, o);

// ------------------------------------------------------------ watchlists and flags

export const listWatchlists = (o?: Opts) =>
  requestJson<Watchlist[]>('GET', '/watchlists', undefined, o);
export const getWatchlist = (id: string, o?: Opts) =>
  requestJson<Watchlist>('GET', `/watchlists/${seg(id)}`, undefined, o);
/** With a client `id`, rejects with 409 (see `watchlistConflict`) if it exists. */
export const createWatchlist = (
  body: { id?: string; name: string; items: WatchlistItem[] },
  o?: Opts,
) => requestJson<Watchlist>('POST', '/watchlists', body, o);
/** With `revision`, rejects with 409 (see `watchlistConflict`) if the list changed elsewhere. */
export const updateWatchlist = (
  id: string,
  body: { name: string; items: WatchlistItem[]; revision?: number },
  o?: Opts,
) => requestJson<Watchlist>('PUT', `/watchlists/${seg(id)}`, body, o);
export const deleteWatchlist = (id: string, o?: Opts) =>
  requestJson<void>('DELETE', `/watchlists/${seg(id)}`, undefined, o);
export const getFlags = (o?: Opts) => requestJson<Flag[]>('GET', '/flags', undefined, o);
/** Set (color) or remove (null) flags; resolves to all flags. */
export const patchFlags = (patch: Record<string, FlagColor | null>, o?: Opts) =>
  requestJson<Flag[]>('PATCH', '/flags', patch, o);

// ------------------------------------------------------------ import/export

export const exportAll = (o?: Opts) => requestJson<Bundle>('GET', '/export', undefined, o);

/**
 * Validate and apply a bundle; `dryRun` only reports what would change.
 * `replace` deletes all user data first and needs `confirm: true` (the server
 * rejects it otherwise): dry-run first and show the summary before confirming.
 */
export const importAll = (
  bundle: Partial<Bundle> & Pick<Bundle, 'version' | 'app'>,
  opts: { mode?: ImportMode; dryRun?: boolean; confirm?: boolean } = {},
  o?: Opts,
) =>
  requestJson<ImportSummary>('POST', '/import', bundle, {
    ...o,
    query: {
      mode: opts.mode,
      dryRun: opts.dryRun,
      confirm: opts.mode === 'replace' && opts.confirm ? true : undefined,
    },
  });

// ------------------------------------------------------------ conflicts

/** True for a 409 (revision conflict / name taken). */
export const isConflict = (e: unknown): e is ApiError => e instanceof ApiError && e.status === 409;

const detailOf = (e: unknown): Record<string, unknown> | null => {
  if (!isConflict(e)) return null;
  const d = (e.body as { detail?: unknown } | undefined)?.detail;
  return d && typeof d === 'object' ? (d as Record<string, unknown>) : null;
};

/** The stored layout from a `saveLayout` 409, else null. */
export function layoutConflict<S = Record<string, unknown>>(e: unknown): Layout<S> | null {
  const cur = detailOf(e)?.current;
  return cur && typeof cur === 'object' ? (cur as Layout<S>) : null;
}

/** The conflicting drawings from a `batchDrawings` 409, else null. */
export function drawingConflicts<D = Record<string, unknown>>(
  e: unknown,
): DrawingConflict<D>[] | null {
  const c = detailOf(e)?.conflicts;
  return Array.isArray(c) ? (c as DrawingConflict<D>[]) : null;
}

/** The stored note from an `updateNote` 409, else null. */
export function noteConflict(e: unknown): Note | null {
  const cur = detailOf(e)?.current;
  return cur && typeof cur === 'object' ? (cur as Note) : null;
}

/** The stored watchlist from a create/update 409, else null. */
export function watchlistConflict(e: unknown): Watchlist | null {
  const cur = detailOf(e)?.current;
  return cur && typeof cur === 'object' ? (cur as Watchlist) : null;
}

/** The stored script from a create/update 409, else null. */
export function userScriptConflict(e: unknown): UserScript | null {
  const cur = detailOf(e)?.current;
  return cur && typeof cur === 'object' ? (cur as UserScript) : null;
}
