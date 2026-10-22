import {
  ArrowDown,
  ArrowUp,
  Bell,
  Copy,
  ExternalLink,
  FolderInput,
  FolderPlus,
  Plus,
  Trash2,
} from 'lucide-react';
import { createElement, type ComponentType } from 'react';
import { commands } from '../../commands/registry';
import { openContextMenu } from '../../ui/ContextMenu';
import { promptName } from '../../ui/Prompt';
import { toast } from '../../ui/Toast';
import { isFlagRef, sortedLists } from '../../watchlist/model';
import { useWatchlistPrefs } from '../../watchlist/prefs';
import { useWatchlistStore } from '../../watchlist/store';
import { FLAG_COLORS, type FlagColor, type ListRef } from '../../watchlist/types';
import type { MenuItem } from '../../ui/Menu';
import { moveStepTarget } from './moveStep';

export const flagLabel = (c: FlagColor): string => c.charAt(0).toUpperCase() + c.slice(1);

type IconType = ComponentType<{ size?: number }>;

/** Colored dot used as a menu icon. */
export const FLAG_ICONS = Object.fromEntries(
  FLAG_COLORS.map((c) => [
    c,
    ({ size = 16 }: { size?: number }) =>
      createElement('span', {
        className: 'wl-swatch',
        style: { width: size * 0.7, height: size * 0.7, background: `var(--wl-flag-${c})` },
        'aria-hidden': true,
      }),
  ]),
) as unknown as Record<FlagColor, IconType>;

/** Context menu of a watchlist row. */
export function rowMenu(symbol: string, listRef: ListRef, x: number, y: number): void {
  const { lists, flags } = useWatchlistStore.getState();
  const inFlagList = isFlagRef(listRef);
  const current = flags[symbol]?.color ?? null;
  const entry = inFlagList ? undefined : lists[listRef];

  const items: MenuItem[] = [
    { label: 'Open', onSelect: () => commands.execute('chart.setSymbol', symbol) },
    {
      label: 'Add alert…',
      icon: Bell,
      onSelect: () => commands.execute('alert.create', { symbol }),
    },
    {
      label: 'Flag',
      submenu: [
        ...FLAG_COLORS.map((c): MenuItem => ({
          label: flagLabel(c),
          icon: FLAG_ICONS[c],
          checked: current === c,
          onSelect: () => commands.execute('watchlist.flag', { symbol, color: c }),
        })),
        { type: 'separator' },
        {
          label: 'Remove flag',
          disabled: !current,
          onSelect: () => commands.execute('watchlist.flag', { symbol, color: null }),
        },
      ],
    },
  ];

  if (entry) {
    const others = sortedLists(lists).filter((l) => l.id !== entry.id);
    items.push({
      label: 'Move to list',
      icon: FolderInput,
      submenu: [
        ...others.map((l): MenuItem => ({
          label: l.name,
          onSelect: () => {
            useWatchlistStore.getState().moveSymbols(entry.id, l.id, [symbol]);
            toast(`Moved ${symbol} to ${l.name}`, 'success');
          },
        })),
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
              const store = useWatchlistStore.getState();
              const id = store.createList(name);
              store.moveSymbols(entry.id, id, [symbol]);
              useWatchlistPrefs.getState().setActive(id);
            });
          },
        },
      ],
    });
  }

  items.push(
    {
      label: 'Open in new chart',
      icon: ExternalLink,
      onSelect: () => commands.execute('watchlist.openInNewChart', symbol),
    },
    {
      label: 'Copy symbol',
      icon: Copy,
      onSelect: () => {
        navigator.clipboard.writeText(symbol).then(
          () => toast(`Copied ${symbol}`, 'success'),
          () => toast('Could not copy to clipboard', 'error'),
        );
      },
    },
  );

  if (entry) {
    const from = entry.items.findIndex((i) => i.type === 'symbol' && i.symbol === symbol);
    const move = (dir: 1 | -1) => {
      const to = moveStepTarget(entry.items, from, dir);
      if (to !== null) useWatchlistStore.getState().moveItem(entry.id, from, to);
    };
    items.push(
      { type: 'separator' },
      {
        label: 'Move up',
        icon: ArrowUp,
        disabled: moveStepTarget(entry.items, from, -1) === null,
        onSelect: () => move(-1),
      },
      {
        label: 'Move down',
        icon: ArrowDown,
        disabled: moveStepTarget(entry.items, from, 1) === null,
        onSelect: () => move(1),
      },
      {
        label: 'Add section above…',
        icon: FolderPlus,
        onSelect: () => {
          const at = entry.items.findIndex((i) => i.type === 'symbol' && i.symbol === symbol);
          commands.execute('watchlist.addSection', { at: at < 0 ? undefined : at });
        },
      },
    );
  }
  items.push(
    { type: 'separator' },
    {
      label: inFlagList ? 'Remove flag' : 'Remove from list',
      icon: Trash2,
      danger: true,
      onSelect: () => commands.execute('watchlist.remove', symbol),
    },
  );
  openContextMenu(x, y, items);
}
