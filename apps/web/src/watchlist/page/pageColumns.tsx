import { COLUMN_DEFS, PAGE_COLUMN_IDS, sortableFor, type ColumnCtx } from '../columns/registry';
import type { CellValue } from '../columns/registry';
import type { ColumnWidths } from '../columns/presets';
import type { ColumnId, SortKey } from '../types';

export interface PageColumnDef {
  id: ColumnId;
  /** Header text. */
  label: string;
  /** Long name for tooltips and the columns menu. */
  title: string;
  /** Default grid track. */
  width: string;
  align: 'left' | 'right';
  /** `dayRange`/`week52Range` bars and `trend` draw themselves in the table. */
  render: (ctx: Omit<ColumnCtx, 'surface'>) => CellValue;
  sortable: boolean;
}

/** Column catalog of the full-screen table: a view over the shared registry. */
export const PAGE_COLUMNS = Object.fromEntries(
  PAGE_COLUMN_IDS.map((id): [ColumnId, PageColumnDef] => {
    const d = COLUMN_DEFS[id];
    return [
      id,
      {
        id,
        label: d.short,
        title: d.label,
        width: d.width.page,
        align: d.align,
        render: (ctx) => d.cell({ ...ctx, surface: 'page' }),
        sortable: d.sortable,
      },
    ];
  }),
) as Record<ColumnId, PageColumnDef>;

/** Sortable page keys (the table header only offers these). */
export const PAGE_SORT_KEYS: readonly SortKey[] = ['symbol', ...sortableFor('page')];

/** Grid track of a column: the user's width in px, else the default. */
export const pageTrack = (id: ColumnId, widths: ColumnWidths): string => {
  const w = widths[id];
  return w ? `${w}px` : PAGE_COLUMNS[id].width;
};

/** `grid-template-columns` of the page table (symbol + columns + gutter). */
export const pageTemplate = (columns: readonly ColumnId[], widths: ColumnWidths): string =>
  `minmax(84px, 1.6fr) ${columns.map((c) => pageTrack(c, widths)).join(' ')} 28px`;
