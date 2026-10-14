import { ChevronRight } from 'lucide-react';
import { memo, type HTMLAttributes } from 'react';
import { openContextMenu } from '../../ui/ContextMenu';
import { promptName } from '../../ui/Prompt';
import { useWatchlistStore } from '../../watchlist/store';
import type { Row } from '../../watchlist/types';

type SectionRowData = Extract<Row, { kind: 'section' }>;

async function renameSection(listId: string, section: SectionRowData): Promise<void> {
  const title = await promptName({
    title: 'Rename section',
    label: 'Section name',
    initial: section.title,
  });
  if (title) useWatchlistStore.getState().renameSection(listId, section.id, title);
}

interface Props {
  listId: string;
  row: SectionRowData;
  dnd: HTMLAttributes<HTMLDivElement>;
  dropPos: 'above' | 'below' | null;
}

/** Section header: chevron collapses, double-click renames, context menu removes. */
export const SectionRow = memo(
  function SectionRow({ listId, row, dnd, dropPos }: Props) {
    const store = useWatchlistStore.getState;
    return (
      <div
        role="row"
        id={`wl-s-${row.id}`}
        aria-expanded={!row.collapsed}
        data-wl-index={row.index}
        data-testid={`wl-section-${row.id}`}
        className={`wl-section${dropPos ? ` drop-${dropPos}` : ''}`}
        {...dnd}
        onDoubleClick={() => void renameSection(listId, row)}
        onContextMenu={(e) => {
          e.preventDefault();
          openContextMenu(e.clientX, e.clientY, [
            { label: 'Rename…', onSelect: () => void renameSection(listId, row) },
            {
              label: 'Remove section',
              onSelect: () => store().removeSection(listId, row.id, true),
            },
            {
              label: 'Remove section and symbols',
              danger: true,
              onSelect: () => store().removeSection(listId, row.id, false),
            },
          ]);
        }}
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
    a.dnd === b.dnd &&
    a.dropPos === b.dropPos &&
    a.row.id === b.row.id &&
    a.row.title === b.row.title &&
    a.row.collapsed === b.row.collapsed &&
    a.row.count === b.row.count &&
    a.row.index === b.row.index,
);
