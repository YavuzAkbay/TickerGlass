import { Layers, Plus, Search } from 'lucide-react';
import { useState, type KeyboardEvent, type ReactNode } from 'react';
import type { SymbolSearchResult } from '@investopen/engine';
import { Modal } from '../ui/Modal';
import { toast } from '../ui/Toast';
import {
  SYMBOL_TABS,
  SymbolRow,
  matchesTab,
  useSymbolSearch,
  type SymbolTab,
} from './symbolSearch';
import './dialogs.css';

const addCompare = (r: SymbolSearchResult) =>
  toast(`Comparing with ${r.symbol} arrives in Phase 9`);

/** Compare/add symbol shell: real search, adding lands in Phase 9. */
export default function CompareDialog({ onClose }: { onClose: () => void; arg?: unknown }) {
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<SymbolTab>('all');
  const [active, setActive] = useState(0);
  const search = useSymbolSearch(query);
  const q = query.trim();
  const rows = search.items.filter((r) => matchesTab(r, tab));
  const idx = Math.max(0, Math.min(active, rows.length - 1));

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const n = rows.length;
    if (e.key === 'ArrowDown') setActive(n ? (idx + 1) % n : 0);
    else if (e.key === 'ArrowUp') setActive(n ? (idx - 1 + n) % n : 0);
    else if (e.key === 'Enter') {
      const r = rows[idx];
      if (r) addCompare(r);
    } else return;
    e.preventDefault();
  };

  let body: ReactNode;
  if (q === '') {
    body = (
      <div className="dlg-emptystate">
        <Layers size={40} strokeWidth={1.2} className="dlg-emptystate-icon" />
        <h3>Compare symbols</h3>
        <p>Overlay other symbols on this chart to compare performance.</p>
        <p className="dlg-emptystate-phase">Compare arrives in Phase 9. Search works already.</p>
      </div>
    );
  } else if (search.error) {
    body = (
      <div className="dlg-empty dlg-error" role="alert">
        Search failed: {search.error}
      </div>
    );
  } else if (rows.length === 0) {
    body = (
      <div className="dlg-empty">
        {search.loading ? (
          'Searching…'
        ) : (
          <>
            No symbols match <b>{q}</b>
          </>
        )}
      </div>
    );
  } else {
    body = rows.map((r, i) => (
      <SymbolRow
        key={`${r.symbol}-${i}`}
        result={r}
        query={q}
        active={i === idx}
        onHover={() => setActive(i)}
        onSelect={() => addCompare(r)}
        action={
          <button
            type="button"
            className="io-icon-btn dlg-row-add"
            aria-label={`Add ${r.symbol}`}
            onClick={(e) => {
              e.stopPropagation();
              addCompare(r);
            }}
          >
            <Plus size={16} />
          </button>
        }
      />
    ));
  }

  return (
    <Modal title="Compare symbol" onClose={onClose} width={720} top className="dlg-compare">
      <div className="dlg-search">
        <Search size={18} strokeWidth={1.8} className="dlg-search-icon" />
        <input
          className="dlg-search-input"
          value={query}
          placeholder="Search"
          aria-label="Search symbols to compare"
          spellCheck={false}
          autoComplete="off"
          autoFocus
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
        />
        {search.loading ? <span className="dlg-spinner" aria-label="Loading" /> : null}
      </div>
      <div className="dlg-picker-body dlg-compare-body">
        <nav
          className="dlg-side"
          role="tablist"
          aria-orientation="vertical"
          aria-label="Symbol type"
        >
          {SYMBOL_TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              className={`dlg-side-item${tab === t.id ? ' active' : ''}`}
              onClick={() => {
                setTab(t.id);
                setActive(0);
              }}
            >
              <span>{t.label}</span>
            </button>
          ))}
        </nav>
        <div
          className={`dlg-list dlg-picker-content${search.loading && rows.length ? ' stale' : ''}`}
          role="listbox"
          aria-label="Search results"
        >
          {body}
        </div>
      </div>
    </Modal>
  );
}
