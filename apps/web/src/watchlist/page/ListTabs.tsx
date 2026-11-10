import { Plus } from 'lucide-react';
import { useMemo, useRef, type KeyboardEvent } from 'react';
import { commands } from '../../commands/registry';
import { useT } from '../../i18n';
import { flagLabel } from '../../sidebar/watchlist/rowMenu';
import { isFlagRef, sortedLists } from '../model';
import { useWatchlistStore } from '../store';
import { flagRef, type FlagColor, type ListRef } from '../types';
import { listTabMenu } from './listTabActions';
import { tabKeyTarget } from './tabNav';

interface Tab {
  ref: ListRef;
  name: string;
  count: number;
  color: FlagColor | null;
}

interface Props {
  active: ListRef | null;
  onPick: (ref: ListRef) => void;
}

/** Horizontal strip of all lists and used flag lists, with per-list symbol counts. */
export function ListTabs({ active, onPick }: Props) {
  const t = useT();
  const lists = useWatchlistStore((s) => s.lists);
  const flags = useWatchlistStore((s) => s.flags);

  const tabs = useMemo<Tab[]>(() => {
    const out: Tab[] = sortedLists(lists).map((l) => ({
      ref: l.id,
      name: l.name,
      count: l.items.reduce((n, i) => (i.type === 'symbol' ? n + 1 : n), 0),
      color: null,
    }));
    const counts = new Map<FlagColor, number>();
    for (const f of Object.values(flags)) counts.set(f.color, (counts.get(f.color) ?? 0) + 1);
    for (const c of [...counts.keys()].sort() as FlagColor[])
      out.push({ ref: flagRef(c), name: flagLabel(c), count: counts.get(c) ?? 0, color: c });
    return out;
  }, [lists, flags]);

  // Roving tabindex: one tab stop (the active tab, else the first); arrows move within.
  const els = useRef(new Map<ListRef, HTMLButtonElement>());
  const stop = tabs.some((tab) => tab.ref === active) ? active : (tabs[0]?.ref ?? null);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const from = (e.target as HTMLElement).closest('[role="tab"]')?.getAttribute('data-ref');
    const nav = tabKeyTarget(
      tabs.findIndex((tab) => tab.ref === from),
      tabs.length,
      e.key,
    );
    if (nav === null) return;
    e.preventDefault();
    const next = tabs[nav];
    if (!next) return;
    els.current.get(next.ref)?.focus();
    onPick(next.ref);
  };

  return (
    <div className="wlp-tabs" data-testid="wlp-tabs">
      <div
        role="tablist"
        className="wlp-tablist"
        aria-label={t('wlp.listsLabel')}
        onKeyDown={onKeyDown}
      >
        {tabs.map((tab) => (
          <button
            key={tab.ref}
            ref={(el) => {
              if (el) els.current.set(tab.ref, el);
              else els.current.delete(tab.ref);
            }}
            type="button"
            role="tab"
            data-ref={tab.ref}
            tabIndex={tab.ref === stop ? 0 : -1}
            aria-selected={tab.ref === active}
            className={`wlp-tab${tab.ref === active ? ' active' : ''}`}
            data-testid={`wlp-tab-${tab.name}`}
            onClick={() => onPick(tab.ref)}
            onContextMenu={(e) => {
              e.preventDefault();
              listTabMenu(tab, !isFlagRef(tab.ref), e.clientX, e.clientY, onPick);
            }}
          >
            {tab.color ? (
              <span
                className="wlp-tab-dot"
                style={{ background: `var(--wl-flag-${tab.color})` }}
                aria-hidden="true"
              />
            ) : null}
            <span className="wlp-tab-name">{tab.name}</span>
            <span className="wlp-tab-count rs-num">{tab.count}</span>
          </button>
        ))}
      </div>
      <button
        type="button"
        className="wlp-tab wlp-tab-new"
        aria-label={t('wlp.newList')}
        title={t('wlp.newList')}
        onClick={() => commands.execute('watchlist.create')}
      >
        <Plus size={13} />
      </button>
    </div>
  );
}
