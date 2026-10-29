import { useEffect, useState, type ReactNode } from 'react';
import type { SymbolSearchResult } from '@tickerglass/engine';
import { useMetered } from '../api/provider';
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
  /** The query is shorter than the provider's minimum: nothing was searched. */
  tooShort: boolean;
  /** Fewest characters that are searched. */
  minChars: number;
}

export interface SearchPolicy {
  debounceMs: number;
  minChars: number;
}

/**
 * Twelve Data's symbol search costs no credits, but a metered provider rates requests per
 * minute: wait longer for the typist to pause and do not search for a single character, so
 * typing stays fair to the rest of the app's requests.
 */
export function searchPolicy(metered: boolean): SearchPolicy {
  return metered ? { debounceMs: 400, minChars: 2 } : { debounceMs: 200, minChars: 1 };
}

/** Debounced symbol search against the data feed (200 ms; 400 ms and 2+ characters when metered). */
export function useSymbolSearch(query: string, limit = 30): SymbolSearch {
  const q = query.trim();
  const { debounceMs, minChars } = searchPolicy(useMetered());
  const tooShort = q !== '' && q.length < minChars;
  const [state, setState] = useState<SearchState>({ query: '', items: [], error: null });

  useEffect(() => {
    if (q === '' || tooShort) return;
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
    }, debounceMs);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [q, limit, debounceMs, tooShort]);

  if (q === '' || tooShort)
    return { items: [], loading: false, error: null, fresh: true, tooShort, minChars };
  const fresh = state.query === q;
  return {
    items: state.items,
    loading: !fresh,
    error: fresh ? state.error : null,
    fresh,
    tooShort: false,
    minChars,
  };
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
