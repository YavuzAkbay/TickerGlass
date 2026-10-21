import { describeCondition, type Alert } from '@tickerglass/alerts';
import { AlarmClock, MoreHorizontal, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { commands } from '../../commands/registry';
import { openContextMenu } from '../../ui/ContextMenu';
import { confirmDialog } from '../../ui/Prompt';
import { deleteAlert, setAlertStatus } from '../sync';
import { useAlerts } from '../store';
import { AlertRow } from './AlertRow';

type Filter = 'all' | 'active' | 'inactive';
type Sort = 'created' | 'name' | 'symbol';

export function filterAlerts(alerts: Alert[], filter: Filter, sort: Sort, query: string): Alert[] {
  const q = query.trim().toLowerCase();
  const out = alerts.filter((a) => {
    if (filter === 'active' && a.status !== 'active') return false;
    if (filter === 'inactive' && a.status === 'active') return false;
    if (!q) return true;
    return `${a.name} ${a.symbol} ${describeCondition(a)}`.toLowerCase().includes(q);
  });
  return out.sort((a, b) =>
    sort === 'name'
      ? a.name.localeCompare(b.name)
      : sort === 'symbol'
        ? a.symbol.localeCompare(b.symbol) || a.name.localeCompare(b.name)
        : b.createdAt.localeCompare(a.createdAt),
  );
}

/** Alerts tab: search, filter, sort, bulk menu and the rows. */
export function AlertList() {
  const map = useAlerts((s) => s.alerts);
  const status = useAlerts((s) => s.status);
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<Sort>('created');
  const [query, setQuery] = useState('');
  const all = useMemo(() => Object.values(map), [map]);
  const shown = useMemo(() => filterAlerts(all, filter, sort, query), [all, filter, sort, query]);

  const bulk = (x: number, y: number) =>
    openContextMenu(x, y, [
      {
        label: 'Pause all',
        disabled: !all.some((a) => a.status === 'active'),
        onSelect: () =>
          void Promise.all(
            all.filter((a) => a.status === 'active').map((a) => setAlertStatus(a.id, 'paused')),
          ),
      },
      {
        label: 'Resume all',
        disabled: !all.some((a) => a.status === 'paused'),
        onSelect: () =>
          void Promise.all(
            all.filter((a) => a.status === 'paused').map((a) => setAlertStatus(a.id, 'active')),
          ),
      },
      { type: 'separator' },
      {
        label: 'Delete inactive…',
        danger: true,
        disabled: !all.some((a) => a.status !== 'active' && a.status !== 'paused'),
        onSelect: () => {
          const dead = all.filter((a) => a.status !== 'active' && a.status !== 'paused');
          void confirmDialog({
            title: 'Delete inactive alerts',
            message: `Delete ${dead.length} triggered, expired or failed alert${dead.length === 1 ? '' : 's'}?`,
            okLabel: 'Delete',
            danger: true,
          }).then((ok) => {
            if (ok) void Promise.all(dead.map((a) => deleteAlert(a.id)));
          });
        },
      },
    ]);

  if (!all.length && status !== 'loading')
    return (
      <div className="rs-empty">
        <AlarmClock size={40} strokeWidth={1.2} />
        <div className="rs-empty-title">No alerts yet</div>
        <div className="rs-empty-text">Get notified when a price or indicator hits a level.</div>
        <button
          type="button"
          className="io-btn io-btn-primary rs-empty-btn"
          onClick={() => commands.execute('alert.create', {})}
        >
          <Plus size={16} /> Create alert
        </button>
      </div>
    );

  return (
    <div className="al-list">
      <div className="al-tools">
        <input
          className="io-input al-search"
          type="search"
          placeholder="Search alerts"
          aria-label="Search alerts"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select
          className="io-input"
          aria-label="Filter"
          value={filter}
          onChange={(e) => setFilter(e.target.value as Filter)}
        >
          <option value="all">All</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
        </select>
        <select
          className="io-input"
          aria-label="Sort"
          value={sort}
          onChange={(e) => setSort(e.target.value as Sort)}
        >
          <option value="created">Newest</option>
          <option value="name">Name</option>
          <option value="symbol">Symbol</option>
        </select>
        <button
          type="button"
          className="io-icon-btn"
          aria-label="Bulk actions"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            bulk(r.left, r.bottom);
          }}
        >
          <MoreHorizontal size={16} />
        </button>
      </div>
      {shown.length ? (
        <div className="al-head" aria-hidden="true">
          <span />
          <span>Name</span>
          <span>Condition</span>
          <span>Symbol · Interval · Trigger</span>
          <span />
        </div>
      ) : null}
      {shown.length ? (
        shown.map((a) => <AlertRow key={a.id} alert={a} />)
      ) : (
        <div className="rs-empty-text al-none">No alerts match.</div>
      )}
    </div>
  );
}
