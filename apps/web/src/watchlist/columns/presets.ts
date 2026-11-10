/** Column presets: built-in layouts and the user's saved ones (watchlist page prefs, synced). */
import { isObj } from '../../persist/net';
import type { MessageKey } from '../../i18n/en';
import type { ColumnId } from '../types';
import { isColumnId, normalizeColumns, type Surface } from './registry';

export type ColumnWidths = Partial<Record<ColumnId, number>>;

/** A saved layout: the visible columns in display order plus any custom widths (page). */
export interface ColumnPreset {
  name: string;
  columns: ColumnId[];
  widths: ColumnWidths;
  /** Where it was saved; absent on presets from older clients (treated as the page). */
  surface?: Surface;
}

export const MAX_PRESETS = 20;
export const MAX_PRESET_NAME = 40;
/** Page column width bounds in px (user resize). */
export const WIDTH_MIN = 44;
export const WIDTH_MAX = 600;

export const clampWidth = (px: number): number =>
  Math.max(WIDTH_MIN, Math.min(WIDTH_MAX, Math.round(px)));

/** Default column sets (the first-run prefs of each surface). */
export const DEFAULT_COLUMNS: Record<Surface, ColumnId[]> = {
  sidebar: ['last', 'changePercent', 'trend'],
  page: ['name', 'last', 'change', 'changePercent', 'volume', 'dayRange', 'trend'],
};

export interface BuiltinPreset {
  id: 'default' | 'performance' | 'fundamentals' | 'technical' | 'minimal';
  label: MessageKey;
  columns: Record<Surface, ColumnId[]>;
}

export const BUILTIN_PRESETS: readonly BuiltinPreset[] = [
  { id: 'default', label: 'wlp.presetDefault', columns: DEFAULT_COLUMNS },
  {
    id: 'performance',
    label: 'wlp.presetPerformance',
    columns: {
      sidebar: ['last', 'changePercent', 'gapPercent', 'relVolume', 'week52Range'],
      page: ['name', 'last', 'changePercent', 'gapPercent', 'relVolume', 'week52Range'],
    },
  },
  {
    id: 'fundamentals',
    label: 'wlp.presetFundamentals',
    columns: {
      sidebar: ['last', 'changePercent', 'marketCap', 'avgVolume', 'week52Range'],
      page: ['name', 'last', 'changePercent', 'marketCap', 'avgVolume', 'week52Range'],
    },
  },
  {
    id: 'technical',
    label: 'wlp.presetTechnical',
    columns: {
      sidebar: ['last', 'changePercent', 'perf1m', 'rsi14', 'pctVsSma200', 'nextEarnings'],
      page: ['name', 'last', 'changePercent', 'perf1m', 'rsi14', 'pctVsSma200', 'nextEarnings'],
    },
  },
  {
    id: 'minimal',
    label: 'wlp.presetMinimal',
    columns: { sidebar: ['last', 'changePercent'], page: ['name', 'last', 'changePercent'] },
  },
];

/** Validate stored widths: known columns, finite px within bounds (clamped). */
export function parseWidths(v: unknown): ColumnWidths {
  const out: ColumnWidths = {};
  if (!isObj(v)) return out;
  for (const [k, w] of Object.entries(v))
    if (isColumnId(k) && typeof w === 'number' && Number.isFinite(w)) out[k] = clampWidth(w);
  return out;
}

const cleanName = (v: unknown): string =>
  typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, MAX_PRESET_NAME) : '';

/**
 * Validate the stored preset list. A preset keeps its columns of either
 * surface (it is filtered to the surface it is applied on); empty, unnamed and
 * repeated (case-insensitive) names are dropped and the list is capped.
 */
export function parsePresets(v: unknown): ColumnPreset[] {
  if (!Array.isArray(v)) return [];
  const out: ColumnPreset[] = [];
  const names = new Set<string>();
  for (const p of v) {
    if (!isObj(p)) continue;
    const name = cleanName(p.name);
    const key = name.toLowerCase();
    if (!name || names.has(key)) continue;
    const columns = Array.isArray(p.columns) ? [...new Set(p.columns.filter(isColumnId))] : [];
    if (!columns.length) continue;
    names.add(key);
    out.push({
      name,
      columns,
      widths: parseWidths(p.widths),
      ...(p.surface === 'sidebar' || p.surface === 'page' ? { surface: p.surface } : {}),
    });
    if (out.length >= MAX_PRESETS) break;
  }
  return out;
}

/** Add or replace (by case-insensitive name) a preset; null when the list is full. */
export function upsertPreset(
  list: readonly ColumnPreset[],
  preset: ColumnPreset,
): ColumnPreset[] | null {
  const key = preset.name.toLowerCase();
  const at = list.findIndex((p) => p.name.toLowerCase() === key);
  if (at >= 0) return list.map((p, i) => (i === at ? preset : p));
  if (list.length >= MAX_PRESETS) return null;
  return [...list, preset];
}

export const removePreset = (list: readonly ColumnPreset[], name: string): ColumnPreset[] =>
  list.filter((p) => p.name !== name);

/** Columns and widths a preset gives a surface (foreign columns dropped; widths are page-only). */
export function presetFor(
  preset: ColumnPreset,
  surface: Surface,
): { columns: ColumnId[]; widths: ColumnWidths } {
  const columns = normalizeColumns(preset.columns, surface);
  const widths: ColumnWidths = {};
  if (surface === 'page')
    for (const c of columns) if (preset.widths[c]) widths[c] = preset.widths[c];
  return { columns, widths };
}

export const sameColumns = (a: readonly ColumnId[], b: readonly ColumnId[]): boolean =>
  a.length === b.length && a.every((c, i) => c === b[i]);
