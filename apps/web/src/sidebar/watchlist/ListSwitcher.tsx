import { ChevronDown, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { commands } from '../../commands/registry';
import { DropdownMenu, type MenuItem } from '../../ui/Menu';
import { isFlagRef, resolveActive, sortedLists } from '../../watchlist/model';
import { useWatchlistPrefs } from '../../watchlist/prefs';
import { useWatchlistStore } from '../../watchlist/store';
import { FLAG_COLORS, flagRef, type FlagColor, type ListRef } from '../../watchlist/types';
import { FLAG_ICONS, flagLabel } from './rowMenu';

const SEARCH_THRESHOLD = 8;

/** Rename / copy / export / delete of the active list (empty for flag lists). */
export function listActionItems(ref: ListRef | null): MenuItem[] {
  if (!ref) return [];
  const real = !isFlagRef(ref);
  return [
    ...(real
      ? [
          { label: 'Rename…', onSelect: () => commands.execute('watchlist.rename') },
          { label: 'Make a copy…', onSelect: () => commands.execute('watchlist.duplicate') },
        ]
      : []),
    { label: 'Export list (.txt)', onSelect: () => commands.execute('watchlist.export') },
    ...(real
      ? [
          { type: 'separator' } as MenuItem,
          { label: 'Delete…', danger: true, onSelect: () => commands.execute('watchlist.delete') },
        ]
      : []),
  ];
}

/** Display name of the active list. */
export function useActiveName(): { ref: ListRef | null; name: string } {
  const lists = useWatchlistStore((s) => s.lists);
  const activeId = useWatchlistPrefs((s) => s.activeId);
  const ref = resolveActive(activeId, lists);
  if (!ref) return { ref, name: 'No list' };
  return {
    ref,
    name: isFlagRef(ref)
      ? `${flagLabel(ref.slice(5) as FlagColor)} flag`
      : (lists[ref]?.name ?? ''),
  };
}

export function ListSwitcher() {
  const [btn, setBtn] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const lists = useWatchlistStore((s) => s.lists);
  const flags = useWatchlistStore((s) => s.flags);
  const setActive = useWatchlistPrefs((s) => s.setActive);
  const { ref: active, name } = useActiveName();

  const close = () => {
    setOpen(false);
    setFilter('');
  };

  const items = useMemo(() => {
    const all = sortedLists(lists);
    const q = filter.trim().toLowerCase();
    const shown = q ? all.filter((l) => l.name.toLowerCase().includes(q)) : all;
    const counts = new Map<string, number>();
    for (const f of Object.values(flags)) counts.set(f.color, (counts.get(f.color) ?? 0) + 1);
    const flagItem = (c: (typeof FLAG_COLORS)[number]): MenuItem => ({
      label: `${flagLabel(c)} (${counts.get(c) ?? 0})`,
      icon: FLAG_ICONS[c],
      checked: active === flagRef(c),
      onSelect: () => setActive(flagRef(c)),
    });
    const out: MenuItem[] = [];
    if (all.length > SEARCH_THRESHOLD)
      out.push({
        type: 'custom',
        render: () => (
          <div className="wl-menu-search">
            <Search size={14} />
            <input
              autoFocus
              value={filter}
              placeholder="Search lists"
              aria-label="Search lists"
              spellCheck={false}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Escape') e.stopPropagation();
              }}
            />
          </div>
        ),
      });
    out.push(
      ...shown.map((l): MenuItem => ({
        label: l.name,
        checked: active === l.id,
        onSelect: () => setActive(l.id),
      })),
    );
    if (!shown.length) out.push({ label: 'No lists', disabled: true });
    out.push({ type: 'separator' }, { type: 'header', label: 'Flagged' });
    const used = FLAG_COLORS.filter((c) => (counts.get(c) ?? 0) > 0 || active === flagRef(c));
    out.push(...used.map(flagItem));
    if (used.length < FLAG_COLORS.length)
      out.push({ label: 'Show all flags', submenu: FLAG_COLORS.map(flagItem) });
    out.push(
      { type: 'separator' },
      { label: 'Create new list…', onSelect: () => commands.execute('watchlist.create') },
      { label: 'Import list…', onSelect: () => commands.execute('watchlist.import') },
    );
    const actions = listActionItems(active);
    if (actions.length) out.push({ type: 'separator' }, ...actions);
    return out;
  }, [lists, flags, filter, active, setActive]);

  return (
    <>
      <button
        ref={setBtn}
        type="button"
        className="wl-switcher"
        data-testid="wl-switcher"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Switch watchlist"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="wl-switcher-name">{name}</span>
        <ChevronDown size={14} />
      </button>
      <DropdownMenu anchor={btn} open={open} onClose={close} items={items} />
    </>
  );
}
