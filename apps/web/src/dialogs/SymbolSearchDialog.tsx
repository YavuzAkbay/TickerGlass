import { Check, Clock, Search, X } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { SymbolSearchResult } from '@tickerglass/engine';
import { MAX_CHART_SYMBOL, TOO_LONG_FOR_CHART } from '../commands/core';
import { commands } from '../commands/registry';
import { ExpressionErrorBox, ExpressionRow, classifyQuery } from '../compare/ExpressionRow';
import { useAppStore } from '../store/app';
import { flagRows, isFlagRef, resolveActive } from '../watchlist/model';
import { useWatchlistPrefs } from '../watchlist/prefs';
import { useWatchlistStore, validSymbol } from '../watchlist/store';
import type { FlagColor } from '../watchlist/types';
import { Modal } from '../ui/Modal';
import { toast } from '../ui/Toast';
import { SymbolRow, SymbolTabs, matchesTab, useSymbolSearch, type SymbolTab } from './symbolSearch';
import './dialogs.css';

function initialText(arg: unknown): string {
  if (arg && typeof arg === 'object' && 'initial' in arg) {
    const v = (arg as { initial?: unknown }).initial;
    if (typeof v === 'string') return v;
  }
  return '';
}

/** Opened by `watchlist.searchAdd`: picking a result adds it to the list and keeps the dialog open. */
function isAddMode(arg: unknown): boolean {
  return !!arg && typeof arg === 'object' && (arg as { mode?: unknown }).mode === 'watchlist';
}

/** Symbols in the active watchlist (or flag list). */
function useActiveSymbols(): Set<string> {
  const lists = useWatchlistStore((s) => s.lists);
  const flags = useWatchlistStore((s) => s.flags);
  const activeId = useWatchlistPrefs((s) => s.activeId);
  const ref = resolveActive(activeId, lists);
  if (!ref) return new Set();
  if (isFlagRef(ref))
    return new Set(
      flagRows(flags, ref.slice(5) as FlagColor).flatMap((r) =>
        r.kind === 'symbol' ? [r.symbol] : [],
      ),
    );
  return new Set((lists[ref]?.items ?? []).flatMap((i) => (i.type === 'symbol' ? [i.symbol] : [])));
}

/** Symbol search: debounced results, type tabs, recents, keyboard. */
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
  const addMode = isAddMode(arg);
  const q = query.trim();
  const kind = addMode ? ({ kind: 'plain' } as const) : classifyQuery(q);
  // Operator queries are expressions, not names to look up.
  const search = useSymbolSearch(kind.kind === 'plain' ? query : '');
  const inList = useActiveSymbols();

  const rows: SymbolSearchResult[] =
    q === ''
      ? recent.map((s) => ({ symbol: s, name: '', exchange: null, type: null }))
      : kind.kind === 'plain'
        ? search.items.filter((r) => matchesTab(r, tab))
        : [];
  const expr = kind.kind === 'expression' ? kind.canonical : null;
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
    if (!addMode && t.length > MAX_CHART_SYMBOL) {
      toast(TOO_LONG_FOR_CHART, 'error');
      return;
    }
    if (addMode) {
      if (!validSymbol(t)) {
        toast(`“${t}” is not a valid symbol`, 'error');
        return;
      }
      commands.execute('watchlist.addSymbol', t);
      setQuery('');
      setActive(0);
      input.current?.focus();
      return;
    }
    commands.execute('chart.setSymbol', t);
    onClose();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') setActive(rows.length ? (idx + 1) % rows.length : 0);
    else if (e.key === 'ArrowUp')
      setActive(rows.length ? (idx - 1 + rows.length) % rows.length : 0);
    else if (e.key === 'Enter') {
      if (kind.kind === 'error') {
        e.preventDefault();
        return;
      }
      if (expr) {
        select(expr);
        e.preventDefault();
        return;
      }
      // While results are loading the typed ticker wins, so fast typists get what they typed.
      const row = search.fresh || q === '' ? rows[idx] : undefined;
      select(row ? row.symbol : q);
    } else return;
    e.preventDefault();
  };

  let body: ReactNode;
  if (kind.kind === 'error') {
    body = <ExpressionErrorBox query={q} error={kind.error} />;
  } else if (expr) {
    body = (
      <ExpressionRow
        canonical={expr}
        active
        onHover={() => undefined}
        onSelect={() => select(expr)}
      />
    );
  } else if (q === '' && rows.length === 0) {
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
        {...(addMode && inList.has(r.symbol.toUpperCase())
          ? { action: <Check size={16} className="dlg-row-added" aria-label="In list" /> }
          : {})}
      />
    ));
  }

  return (
    <Modal
      title={addMode ? 'Add symbol to watchlist' : 'Symbol search'}
      onClose={onClose}
      width={640}
      top
      className="dlg-symsearch"
    >
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
      {q !== '' && kind.kind === 'plain' ? (
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
