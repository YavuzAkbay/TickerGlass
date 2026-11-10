import type { ScreenerSort } from './model';

/**
 * One-click screens (Finviz-style signals): they only set the sort (the
 * user's filters stay), so a preset is always exactly what the header click
 * means. Rendered as a chip row above the table.
 */
export type PresetId = 'gainers' | 'losers' | 'movers' | 'active' | 'volatile';

export interface ScreenerPreset {
  id: PresetId;
  sort: ScreenerSort;
}

/** Chip order of the preset row. */
export const PRESETS: readonly ScreenerPreset[] = [
  { id: 'gainers', sort: { key: 'changePercent', dir: 'desc' } },
  { id: 'losers', sort: { key: 'changePercent', dir: 'asc' } },
  // |change %| — the biggest moves in either direction.
  { id: 'movers', sort: { key: 'absChangePercent', dir: 'desc' } },
  { id: 'active', sort: { key: 'volume', dir: 'desc' } },
  { id: 'volatile', sort: { key: 'dayRangePct', dir: 'desc' } },
];

/** The sort a preset applies (null id → universe rank order). */
export function presetSort(id: PresetId | null): ScreenerSort | null {
  return PRESETS.find((p) => p.id === id)?.sort ?? null;
}

/** Preset whose sort matches `sort`, if any (header sorts keep it in sync). */
export function presetOf(sort: ScreenerSort | null): PresetId | null {
  return PRESETS.find((p) => p.sort.key === sort?.key && p.sort.dir === sort.dir)?.id ?? null;
}
