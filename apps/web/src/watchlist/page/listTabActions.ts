import type { MenuItem } from '../../ui/Menu';
import { openContextMenu } from '../../ui/ContextMenu';
import { confirmDialog, promptName } from '../../ui/Prompt';
import { toast } from '../../ui/Toast';
import { downloadBlob } from '../../persist/layouts';
import { t } from '../../i18n';
import { shareWatchlist } from '../../share/open';
import { formatTxt, txtFileName } from '../model';
import { useWatchlistPrefs } from '../prefs';
import { useWatchlistStore } from '../store';
import type { ListRef } from '../types';

interface Tab {
  ref: ListRef;
  name: string;
  count: number;
}

/**
 * Context menu of a list tab: acts on that list (the commands' list actions
 * only ever target the active one). `onPick` switches to a list.
 */
export function listTabMenu(
  tab: Tab,
  real: boolean,
  x: number,
  y: number,
  onPick: (ref: ListRef) => void,
): void {
  const ref = tab.ref;
  const store = () => useWatchlistStore.getState();
  const items: MenuItem[] = [{ label: 'Show', onSelect: () => onPick(ref) }];
  if (real) {
    items.push(
      { type: 'separator' },
      {
        label: 'Rename…',
        onSelect: () => {
          void promptName({
            title: 'Rename watchlist',
            label: 'List name',
            initial: tab.name,
          }).then((name) => {
            if (name) store().renameList(ref, name);
          });
        },
      },
      {
        label: 'Make a copy…',
        onSelect: () => {
          void promptName({
            title: 'Make a copy',
            label: 'List name',
            initial: `${tab.name} copy`,
            okLabel: 'Copy',
          }).then((name) => {
            if (!name) return;
            const id = store().duplicateList(ref, name);
            if (id) useWatchlistPrefs.getState().setActive(id);
          });
        },
      },
      {
        label: 'Export list (.txt)',
        onSelect: () => {
          const entry = store().lists[ref];
          if (!entry) return;
          downloadBlob(
            new Blob([formatTxt(entry.items)], { type: 'text/plain' }),
            txtFileName(entry.name),
          );
        },
      },
      { label: t('share.menu.share'), onSelect: () => shareWatchlist(ref) },
      { type: 'separator' },
      {
        label: 'Delete…',
        danger: true,
        onSelect: () => {
          void confirmDialog({
            title: 'Delete watchlist',
            message: `Delete “${tab.name}”? This cannot be undone.`,
            okLabel: 'Delete',
            danger: true,
          }).then((ok) => {
            if (!ok) return;
            store().deleteList(ref);
            if (useWatchlistPrefs.getState().activeId === ref)
              useWatchlistPrefs.getState().setActive(null);
            toast(`Deleted ${tab.name}`, 'success');
          });
        },
      },
    );
  }
  openContextMenu(x, y, items);
}
