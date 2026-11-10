/** A list screen shows its symbols as a table or as a heatmap. */
export type ViewMode = 'table' | 'heatmap';
export const VIEW_MODES: readonly ViewMode[] = ['table', 'heatmap'];
export const isViewMode = (v: unknown): v is ViewMode => v === 'table' || v === 'heatmap';
