import { useEffect, useState, type ReactNode } from 'react';
import type { SymbolSearchResult } from '@investopen/engine';
import { feed } from '../chart/feed';

export type SymbolTab = 'all' | 'stocks' | 'funds' | 'crypto' | 'forex' | 'indices' | 'futures';

export const SYMBOL_TABS: { id: SymbolTab; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'stocks', label: 'Stocks' },
  { id: 'funds', label: 'Funds/ETF' },
  { id: 'crypto', label: 'Crypto' },
  { id: 'forex', label: 'Forex' },
  { id: 'indices', label: 'Indices' },
  { id: 'futures', label: 'Futures' },
];

/** Yahoo quote types per tab. */
const TAB_TYPES: Record<Exclude<SymbolTab, 'all'>, string[]> = {
  stocks: ['equity'],
  funds: ['etf', 'mutualfund'],
  crypto: ['cryptocurrency'],
  forex: ['currency'],
  indices: ['index'],
  futures: ['future'],
};

const TYPE_BADGE: Record<string, string> = {
  equity: 'stock',
  etf: 'fund',
  mutualfund: 'fund',
  cryptocurrency: 'crypto',
  currency: 'forex',
  index: 'index',
  future: 'futures',
};

export function matchesTab(r: SymbolSearchResult, tab: SymbolTab): boolean {
  if (tab === 'all') return true;
  return TAB_TYPES[tab].includes((r.type ?? '').toLowerCase());
}

export function typeBadge(r: SymbolSearchResult): string {
  const t = (r.type ?? '').toLowerCase();
  return TYPE_BADGE[t] ?? (r.typeDisplay ?? r.type ?? '').toLowerCase();
}

interface SearchState {
  query: string;
  items: SymbolSearchResult[];
  error: string | null;
}

export interface SymbolSearch {
  items: SymbolSearchResult[];
  loading: boolean;
  error: string | null;
  /** True when `items` belong to the current query (not stale). */
  fresh: boolean;
}

/** Debounced (200ms) symbol search against the data feed. */
export function useSymbolSearch(query: string, limit = 30): SymbolSearch {
  const q = query.trim();
  const [state, setState] = useState<SearchState>({ query: '', items: [], error: null });

  useEffect(() => {
    if (q === '') return;
    let cancelled = false;
    const timer = setTimeout(() => {
      feed.searchSymbols(q, limit).then(
        (items) => {
          if (!cancelled) setState({ query: q, items, error: null });
        },
        (err: unknown) => {
          if (!cancelled) {
            const message = err instanceof Error ? err.message : String(err);
            setState({ query: q, items: [], error: message });
          }
        },
      );
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [q, limit]);

  if (q === '') return { items: [], loading: false, error: null, fresh: true };
  const fresh = state.query === q;
  return { items: state.items, loading: !fresh, error: fresh ? state.error : null, fresh };
}

/** Bold the leading part of the ticker that matches the query. */
export function highlight(text: string, query: string): ReactNode {
  const q = query.trim().toUpperCase();
  if (q && text.toUpperCase().startsWith(q)) {
    return (
      <>
        <mark>{text.slice(0, q.length)}</mark>
        {text.slice(q.length)}
      </>
    );
  }
  return text;
}

export function SymbolTabs({
  tab,
  onChange,
}: {
  tab: SymbolTab;
  onChange: (t: SymbolTab) => void;
}) {
  return (
    <div className="dlg-tabs" role="tablist" aria-label="Symbol type">
      {SYMBOL_TABS.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={tab === t.id}
          className={`dlg-tab${tab === t.id ? ' active' : ''}`}
          onClick={() => onChange(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

interface RowProps {
  result: SymbolSearchResult;
  query: string;
  active: boolean;
  onSelect: () => void;
  onHover: () => void;
  /** Trailing action (e.g. compare "+"). */
  action?: ReactNode;
}

export function SymbolRow({ result, query, active, onSelect, onHover, action }: RowProps) {
  const badge = typeBadge(result);
  return (
    <div
      role="option"
      aria-selected={active}
      data-active={active || undefined}
      className={`dlg-symrow${active ? ' active' : ''}`}
      onPointerMove={onHover}
      onClick={onSelect}
    >
      <span className="dlg-symlogo" aria-hidden="true">
        {result.symbol.replace(/[^A-Za-z0-9]/g, '').charAt(0) || '?'}
      </span>
      <span className="dlg-symticker">{highlight(result.symbol, query)}</span>
      <span className="dlg-symname">{result.name}</span>
      {badge ? <span className="dlg-symbadge">{badge}</span> : null}
      <span className="dlg-symexch">{result.exchange ?? ''}</span>
      {action}
    </div>
  );
}
