import { Search, Trash2 } from 'lucide-react';
import { useEffect, useState, type KeyboardEvent } from 'react';
import { errorMessage } from '../api/client';
import type { LayoutSummary } from '../api/types';
import { getPersistence } from '../persist/bootstrap';
import { deleteLayout, loadLayout } from '../persist/commands';
import { useLayoutStatus } from '../persist/layouts';
import { Modal } from '../ui/Modal';
import './dialogs.css';
import './persist.css';

function formatWhen(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** Saved layouts: search, open (click/Enter), delete. Newest first. */
export default function LoadLayoutDialog({ onClose }: { onClose: () => void; arg?: unknown }) {
  const [layouts, setLayouts] = useState<LayoutSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const currentId = useLayoutStatus((s) => s.current?.id ?? null);

  const refresh = () => {
    const p = getPersistence();
    return (p ? p.layouts.list() : Promise.reject(new Error('Persistence is not running')))
      .then((list) => {
        setLayouts(list);
        setError(null);
      })
      .catch((err) => setError(errorMessage(err)));
  };
  useEffect(() => {
    void refresh();
    // Load once on open; later refreshes follow deletes.
  }, []);

  const q = query.trim().toLowerCase();
  const rows = (layouts ?? []).filter((l) => !q || l.name.toLowerCase().includes(q));
  const idx = Math.max(0, Math.min(active, rows.length - 1));

  const open = async (l: LayoutSummary) => {
    if (await loadLayout(l.id)) onClose();
  };
  const remove = async (l: LayoutSummary) => {
    if (await deleteLayout(l.id, l.name)) await refresh();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const n = rows.length;
    if (e.key === 'ArrowDown') setActive(n ? (idx + 1) % n : 0);
    else if (e.key === 'ArrowUp') setActive(n ? (idx - 1 + n) % n : 0);
    else if (e.key === 'Enter') {
      const l = rows[idx];
      if (l) void open(l);
    } else return;
    e.preventDefault();
  };

  return (
    <Modal title="Load layout" onClose={onClose} width={520} className="dlg-layouts" top>
      <div className="dlg-search dlg-search-boxed">
        <Search size={16} strokeWidth={1.8} className="dlg-search-icon" />
        <input
          className="dlg-search-input"
          value={query}
          placeholder="Search"
          aria-label="Search layouts"
          spellCheck={false}
          autoComplete="off"
          autoFocus
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
        />
      </div>
      <div className="lay-list" role="listbox" aria-label="Layouts">
        {error ? <div className="lay-empty">Layouts could not be loaded: {error}</div> : null}
        {!error && !layouts ? <div className="lay-empty">Loading…</div> : null}
        {layouts && !rows.length ? (
          <div className="lay-empty">{q ? `No layouts match "${query.trim()}"` : 'No layouts'}</div>
        ) : null}
        {rows.map((l, i) => (
          <div
            key={l.id}
            role="option"
            aria-selected={i === idx}
            aria-current={l.id === currentId ? 'true' : undefined}
            className={`lay-row${i === idx ? ' active' : ''}${l.id === currentId ? ' current' : ''}`}
            onPointerEnter={() => setActive(i)}
            onClick={() => void open(l)}
          >
            <span className="lay-name">{l.name}</span>
            <span className="lay-when">{formatWhen(l.updatedAt)}</span>
            <button
              type="button"
              className="io-icon-btn lay-delete"
              aria-label={`Delete layout ${l.name}`}
              onClick={(e) => {
                e.stopPropagation();
                void remove(l);
              }}
            >
              <Trash2 size={15} />
            </button>
          </div>
        ))}
      </div>
    </Modal>
  );
}
