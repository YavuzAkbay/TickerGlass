import { ChevronRight } from 'lucide-react';
import { memo, type HTMLAttributes } from 'react';
import { openContextMenu } from '../../ui/ContextMenu';
import { promptName } from '../../ui/Prompt';
import { moveStepTarget } from './moveStep';
import { useLongPress } from '../../ui/useLongPress';
import { removeSectionWithUndo } from '../../watchlist/actions';
import { useWatchlistStore } from '../../watchlist/store';
import type { Row, WatchlistItem } from '../../watchlist/types';

type SectionRowData = Extract<Row, { kind: 'section' }>;

async function renameSection(listId: string, section: SectionRowData): Promise<void> {
  const title = await promptName({
    title: 'Rename section',
    label: 'Section name',
    initial: section.title,
  });
  if (title) useWatchlistStore.getState().renameSection(listId, section.id, title);
}

/** Index of section `id` in the stored items, or -1. */
function sectionIndex(items: readonly WatchlistItem[], id: string): number {
  return items.findIndex((i) => i.type === 'section' && i.id === id);
}

interface Props {
  listId: string;
  row: SectionRowData;
  /** 1-based `aria-rowindex` (the table is virtualized, so the DOM can't tell). */
  rowIndex: number;
  dnd: HTMLAttributes<HTMLDivElement>;
  dropPos: 'above' | 'below' | null;
}

/** Section header: chevron collapses, double-click renames, context menu removes. */
export const SectionRow = memo(
  function SectionRow({ listId, row, rowIndex, dnd, dropPos }: Props) {
    const store = useWatchlistStore.getState;
    const menu = (x: number, y: number) => {
      // `row.index` is relative to the (possibly filtered) displayed items; moves act on the stored ones.
      const items = useWatchlistStore.getState().lists[listId]?.items ?? [];
      const at = sectionIndex(items, row.id);
      const up = at < 0 ? null : moveStepTarget(items, at, -1);
      const down = at < 0 ? null : moveStepTarget(items, at, 1);
      openContextMenu(x, y, [
        {
          label: 'Move up',
          disabled: up === null,
          onSelect: () => up !== null && store().moveItem(listId, at, up),
        },
        {
          label: 'Move down',
          disabled: down === null,
          onSelect: () => down !== null && store().moveItem(listId, at, down),
        },
        { type: 'separator' },
        { label: 'Rename…', onSelect: () => void renameSection(listId, row) },
        {
          label: 'Remove section',
          onSelect: () => removeSectionWithUndo(listId, row.id, true),
        },
        {
          label: 'Remove section and symbols',
          danger: true,
          onSelect: () => removeSectionWithUndo(listId, row.id, false),
        },
      ]);
    };
    const press = useLongPress(menu);
    return (
      <div
        role="row"
        id={`wl-s-${row.id}`}
        aria-rowindex={rowIndex}
        aria-expanded={!row.collapsed}
        data-wl-index={row.index}
        data-testid={`wl-section-${row.id}`}
        className={`wl-section${dropPos ? ` drop-${dropPos}` : ''}`}
        {...dnd}
        onDoubleClick={() => void renameSection(listId, row)}
        onContextMenu={(e) => {
          e.preventDefault();
          menu(e.clientX, e.clientY);
        }}
        {...press}
      >
        <div role="gridcell" className="wl-section-cell">
          <button
            type="button"
            className="wl-section-toggle"
            aria-label={`${row.collapsed ? 'Expand' : 'Collapse'} ${row.title}`}
            onClick={() => store().toggleSection(listId, row.id)}
          >
            <ChevronRight size={14} className={`wl-chevron${row.collapsed ? '' : ' open'}`} />
          </button>
          <span className="wl-section-title">{row.title}</span>
          <span className="wl-section-count">{row.count}</span>
        </div>
        {dropPos ? <i className="wl-drop-line" aria-hidden="true" /> : null}
      </div>
    );
  },
  (a, b) =>
    a.listId === b.listId &&
    a.rowIndex === b.rowIndex &&
    a.dnd === b.dnd &&
    a.dropPos === b.dropPos &&
    a.row.id === b.row.id &&
    a.row.title === b.row.title &&
    a.row.collapsed === b.row.collapsed &&
    a.row.count === b.row.count &&
    a.row.index === b.row.index,
);
