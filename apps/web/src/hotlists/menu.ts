import { Bell, ChartLine, Copy, ExternalLink, FolderPlus } from 'lucide-react';
import { commands } from '../commands/registry';
import type { MessageKey, MessageParams } from '../i18n';
import { openContextMenu } from '../ui/ContextMenu';
import { toast } from '../ui/Toast';
import { sortedLists } from '../watchlist/model';
import { useWatchlistStore } from '../watchlist/store';

type T = (key: MessageKey, params?: MessageParams) => string;

/** Context menu of a hotlist row: open, add to a watchlist, add alert, copy. */
export function hotlistRowMenu(symbol: string, x: number, y: number, t: T): void {
  const lists = sortedLists(useWatchlistStore.getState().lists);
  openContextMenu(x, y, [
    {
      label: t('hl.menu.open'),
      icon: ChartLine,
      onSelect: () => commands.execute('chart.setSymbol', symbol),
    },
    {
      label: t('hl.menu.addWatchlist'),
      icon: FolderPlus,
      submenu: lists.length
        ? lists.map((l) => ({
            label: l.name,
            onSelect: () => {
              const added = useWatchlistStore.getState().addSymbols(l.id, [symbol]);
              toast(
                t(added.length ? 'hl.menu.added' : 'hl.menu.already', { symbol, list: l.name }),
                added.length ? 'success' : 'info',
              );
            },
          }))
        : [{ label: t('hl.menu.noLists'), onSelect: () => commands.execute('watchlist.create') }],
    },
    {
      label: t('hl.menu.addAlert'),
      icon: Bell,
      onSelect: () => commands.execute('alert.create', { symbol }),
    },
    {
      label: t('hl.menu.openNew'),
      icon: ExternalLink,
      onSelect: () => commands.execute('watchlist.openInNewChart', symbol),
    },
    {
      label: t('hl.menu.copy'),
      icon: Copy,
      onSelect: () =>
        navigator.clipboard.writeText(symbol).then(
          () => toast(t('hl.menu.copied', { symbol }), 'success'),
          () => toast(t('hl.menu.copyFail'), 'error'),
        ),
    },
  ]);
}
