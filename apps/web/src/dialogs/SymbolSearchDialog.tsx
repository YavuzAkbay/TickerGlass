import { Clock, Search, X } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { SymbolSearchResult } from '@investopen/engine';
import { commands } from '../commands/registry';
import { useAppStore } from '../store/app';
import { Modal } from '../ui/Modal';
import { SymbolRow, SymbolTabs, matchesTab, useSymbolSearch, type SymbolTab } from './symbolSearch';
import './dialogs.css';

function initialText(arg: unknown): string {
  if (arg && typeof arg === 'object' && 'initial' in arg) {
    const v = (arg as { initial?: unknown }).initial;
    if (typeof v === 'string') return v;
  }
  return '';
}

/** standard symbol search: debounced results, type tabs, recents, keyboard. */
export default function SymbolSearchDialog({
  onClose,
  arg,
}: {
  onClose: () => void;
  arg?: unknown;
}) {
  const [query, setQuery] = useState(() => initialText(arg));
  const [tab, setTab] = useState<SymbolTab>('all');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const recent = useAppStore((s) => s.recentSymbols);
  const search = useSymbolSearch(query);

  const q = query.trim();
  const rows: SymbolSearchResult[] =
    q === ''
      ? recent.map((s) => ({ symbol: s, name: '', exchange: null, type: null }))
      : search.items.filter((r) => matchesTab(r, tab));
  const idx = Math.max(0, Math.min(active, rows.length - 1));

  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  useEffect(() => {
    list.current?.querySelector('[data-active]')?.scrollIntoView({ block: 'nearest' });
  }, [idx, rows.length]);

  const select = (ticker: string) => {
    const t = ticker.trim().toUpperCase();
    if (!t) return;
    commands.execute('chart.setSymbol', t);
    onClose();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') setActive(rows.length ? (idx + 1) % rows.length : 0);
    else if (e.key === 'ArrowUp')
      setActive(rows.length ? (idx - 1 + rows.length) % rows.length : 0);
    else if (e.key === 'Enter') {
      // While results are loading the typed ticker wins, so fast typists get what they typed.
      const row = search.fresh || q === '' ? rows[idx] : undefined;
      select(row ? row.symbol : q);
    } else return;
    e.preventDefault();
  };

  let body: ReactNode;
  if (q === '' && rows.length === 0) {
    body = (
      <div className="dlg-empty">Type a ticker or company name, e.g. AAPL, BTC-USD, EURUSD=X</div>
    );
  } else if (search.error) {
    body = (
      <div className="dlg-empty dlg-error" role="alert">
        Search failed: {search.error}
        <div className="dlg-empty-hint">
          Press <kbd>Enter</kbd> to open <b>{q.toUpperCase()}</b> anyway
        </div>
      </div>
    );
  } else if (rows.length === 0 && search.fresh) {
    body = (
      <div className="dlg-empty">
        No symbols match <b>{q}</b>
        {tab !== 'all' ? ' in this category' : ''}
        <div className="dlg-empty-hint">
          Press <kbd>Enter</kbd> to open <b>{q.toUpperCase()}</b>
        </div>
      </div>
    );
  } else if (rows.length === 0) {
    body = <div className="dlg-empty">Searching…</div>;
  } else {
    body = rows.map((r, i) => (
      <SymbolRow
        key={`${r.symbol}-${i}`}
        result={r}
        query={q}
        active={i === idx}
        onHover={() => setActive(i)}
        onSelect={() => select(r.symbol)}
      />
    ));
  }

  return (
    <Modal title="Symbol search" onClose={onClose} width={640} top className="dlg-symsearch">
      <div className="dlg-search">
        <Search size={18} strokeWidth={1.8} className="dlg-search-icon" />
        <input
          ref={input}
          className="dlg-search-input"
          value={query}
          placeholder="Symbol, ISIN, or company"
          aria-label="Search symbols"
          role="combobox"
          aria-expanded
          aria-controls="dlg-symsearch-list"
          aria-autocomplete="list"
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
        />
        {search.loading ? <span className="dlg-spinner" aria-label="Loading" /> : null}
        {query ? (
          <button
            type="button"
            className="io-icon-btn dlg-clear"
            aria-label="Clear"
            onClick={() => {
              setQuery('');
              setActive(0);
              input.current?.focus();
            }}
          >
            <X size={16} />
          </button>
        ) : null}
      </div>
      {q !== '' ? (
        <SymbolTabs
          tab={tab}
          onChange={(t) => {
            setTab(t);
            setActive(0);
            input.current?.focus();
          }}
        />
      ) : rows.length > 0 ? (
        <div className="dlg-section-title">
          <Clock size={13} /> Recent
        </div>
      ) : null}
      <div
        ref={list}
        id="dlg-symsearch-list"
        className={`dlg-list${search.loading && rows.length ? ' stale' : ''}`}
        role="listbox"
        aria-label={q === '' ? 'Recent symbols' : 'Search results'}
      >
        {body}
      </div>
      <div className="dlg-hints">
        <span>
          <kbd>↑</kbd>
          <kbd>↓</kbd> navigate
        </span>
        <span>
          <kbd>Enter</kbd> select
        </span>
        <span>
          <kbd>Esc</kbd> close
        </span>
      </div>
    </Modal>
  );
}
