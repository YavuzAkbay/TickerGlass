import { ChartLine, Copy, FolderPlus } from 'lucide-react';
import { commands } from '../../commands/registry';
import type { MessageKey, MessageParams } from '../../i18n';
import { useUiStore } from '../../store/ui';
import { openContextMenu } from '../../ui/ContextMenu';
import { toast } from '../../ui/Toast';
import { MAX_WATCHLIST_ITEMS, sortedLists } from '../../watchlist/model';
import { useWatchlistStore } from '../../watchlist/store';

type T = (key: MessageKey, params?: MessageParams) => string;

/** Open `symbol` in the chart and leave the screener. */
export function openInChart(symbol: string): void {
  commands.execute('chart.setSymbol', symbol);
  useUiStore.getState().closeScreen();
}

/** Context menu of a result row (open, add to a watchlist, copy). */
export function openRowMenu(symbol: string, x: number, y: number, t: T): void {
  const lists = sortedLists(useWatchlistStore.getState().lists);
  openContextMenu(x, y, [
    { label: t('scr.openChart'), icon: ChartLine, onSelect: () => openInChart(symbol) },
    {
      label: t('scr.addWatchlist'),
      icon: FolderPlus,
      submenu: lists.length
        ? lists.map((l) => ({
            label: l.name,
            onSelect: () => {
              const added = useWatchlistStore.getState().addSymbols(l.id, [symbol]);
              if (added.length)
                toast(
                  t('scr.addedTo').replace('{symbol}', symbol).replace('{list}', l.name),
                  'success',
                );
              else toast(t('scr.alreadyIn').replace('{symbol}', symbol).replace('{list}', l.name));
            },
          }))
        : [{ label: t('scr.noLists'), onSelect: () => commands.execute('watchlist.create') }],
    },
    {
      label: t('scr.copySymbol'),
      icon: Copy,
      onSelect: () =>
        navigator.clipboard.writeText(symbol).then(
          () => toast(t('scr.copied').replace('{symbol}', symbol), 'success'),
          () => toast(t('scr.copyFail'), 'error'),
        ),
    },
  ]);
}

/** Add every symbol to watchlist `listId` and say what happened (added, duplicates, over the limit). */
export function addAllToList(listId: string, symbols: string[], t: T): void {
  const store = useWatchlistStore.getState();
  const list = store.lists[listId];
  if (!list || !symbols.length) return;
  const have = new Set(list.items.flatMap((i) => (i.type === 'symbol' ? [i.symbol] : [])));
  const dupes = symbols.filter((sym) => have.has(sym)).length;
  const added = store.addSymbols(listId, symbols).length;
  const over = symbols.length - dupes - added;
  const vars = (m: string) =>
    m
      .replace('{added}', String(added))
      .replace('{total}', String(symbols.length))
      .replace('{list}', list.name)
      .replace('{max}', String(MAX_WATCHLIST_ITEMS));
  if (added === 0) {
    toast(vars(over > 0 ? t('scr.listFull') : t('scr.allAlreadyIn')), over > 0 ? 'error' : 'info');
    return;
  }
  const notes = [
    dupes > 0 ? t('scr.skippedDupes').replace('{n}', String(dupes)) : '',
    over > 0 ? vars(t('scr.skippedLimit').replace('{n}', String(over))) : '',
  ].filter(Boolean);
  toast(vars(t('scr.addedMany')) + (notes.length ? ` (${notes.join(', ')})` : ''), 'success');
}
