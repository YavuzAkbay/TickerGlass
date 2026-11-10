import { Plus, Trash2 } from 'lucide-react';
import { openContextMenu } from '../../ui/ContextMenu';
import { toast } from '../../ui/Toast';
import type { MenuItem } from '../../ui/Menu';
import { t } from '../../i18n';
import { shareSymbols } from '../../share/open';
import { promptName } from '../../ui/Prompt';
import { moveWithReport, removeWithUndo } from '../actions';
import { isFlagRef, sortedLists } from '../model';
import { useWatchlistStore } from '../store';
import { type ListRef } from '../types';
import { useWatchlistPrefs } from '../prefs';

/**
 * Context menu for a multi-selection: move every selected symbol to another
 * list, copy them, or remove them all. `onDone` runs after a change (clears
 * the selection of removed symbols).
 */
export function bulkRowMenu(
  symbols: string[],
  listRef: ListRef,
  x: number,
  y: number,
  onDone?: () => void,
): void {
  const inFlagList = isFlagRef(listRef);
  const { lists } = useWatchlistStore.getState();
  const entry = inFlagList ? undefined : lists[listRef];

  const remove = () => {
    removeWithUndo(listRef, symbols); // toasts with "Undo"
    onDone?.();
  };

  const moveTo = (toId: string, toName: string) => {
    if (!entry) return;
    moveWithReport(entry.id, toId, toName, symbols);
    onDone?.();
  };

  const items: MenuItem[] = [];
  if (entry) {
    const others = sortedLists(lists).filter((l) => l.id !== entry.id);
    items.push({
      label: 'Move to list',
      submenu: [
        ...others.map((l): MenuItem => ({ label: l.name, onSelect: () => moveTo(l.id, l.name) })),
        ...(others.length ? [{ type: 'separator' } as MenuItem] : []),
        {
          label: 'New list…',
          icon: Plus,
          onSelect: () => {
            void promptName({
              title: 'Create watchlist',
              label: 'List name',
              okLabel: 'Create',
            }).then((name) => {
              if (!name) return;
              const id = useWatchlistStore.getState().createList(name);
              moveWithReport(entry.id, id, name, symbols);
              useWatchlistPrefs.getState().setActive(id);
              onDone?.();
            });
          },
        },
      ],
    });
  }
  items.push(
    {
      label: 'Copy symbols',
      onSelect: () => {
        navigator.clipboard.writeText(symbols.join(', ')).then(
          () => toast(`Copied ${symbols.length} symbols`, 'success'),
          () => toast('Could not copy to clipboard', 'error'),
        );
      },
    },
    {
      label: t('share.menu.shareSelection'),
      onSelect: () => shareSymbols(entry ? `${entry.name} (selection)` : 'Selection', symbols),
    },
    { type: 'separator' },
    {
      label: inFlagList ? 'Remove flags' : `Remove ${symbols.length} from list`,
      icon: Trash2,
      danger: true,
      onSelect: remove,
    },
  );
  openContextMenu(x, y, items);
}
