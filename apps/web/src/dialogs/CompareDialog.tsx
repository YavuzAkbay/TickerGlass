import { Eye, EyeOff, Layers, Search, X } from 'lucide-react';
import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { SymbolSearchResult } from '@tickerglass/engine';
import { Modal } from '../ui/Modal';
import {
  addCompare,
  removeCompare,
  setComparePlacement,
  toggleCompareVisible,
} from '../compare/actions';
import { ExpressionErrorBox, ExpressionRow, classifyQuery } from '../compare/ExpressionRow';
import { PLACEMENT_NAMES } from '../compare/menu';
import { MAX_COMPARES, PLACEMENTS, type ComparePlacement } from '../compare/model';
import { useCompareRuntime, useCompareStore } from '../compare/store';
import {
  SYMBOL_TABS,
  SymbolRow,
  matchesTab,
  useSymbolSearch,
  type SymbolTab,
} from './symbolSearch';
import '../compare/compare.css';
import './dialogs.css';

/** Placement chosen by the Enter modifier: plain = same scale, Shift = new scale, Alt = new pane. */
const placementOf = (e: { shiftKey: boolean; altKey: boolean }): ComparePlacement =>
  e.altKey ? 'pane' : e.shiftKey ? 'own' : 'same';

/** Row buttons, one per placement. */
function AddButtons({
  symbol,
  disabled,
  onAdd,
}: {
  symbol: string;
  disabled: boolean;
  onAdd: (symbol: string, p: ComparePlacement) => void;
}) {
  return (
    <span className="cmp-add">
      {PLACEMENTS.map((p) => (
        <button
          key={p}
          type="button"
          className="cmp-add-btn"
          disabled={disabled}
          aria-label={`${PLACEMENT_NAMES[p]}: ${symbol}`}
          title={PLACEMENT_NAMES[p]}
          onClick={(e) => {
            e.stopPropagation();
            onAdd(symbol, p);
          }}
        >
          {PLACEMENT_NAMES[p]}
        </button>
      ))}
    </span>
  );
}

/** Overlays already on the chart: placement, visibility, remove. */
function CurrentCompares() {
  const items = useCompareStore((s) => s.items);
  const status = useCompareRuntime((s) => s.status);
  if (items.length === 0) return null;
  return (
    <div className="cmp-current" data-testid="compare-current">
      <div className="dlg-section-title">On this chart</div>
      <div className="cmp-current-list">
        {items.map((item) => {
          const st = status[item.id];
          const problem = st && (st.state === 'error' || st.state === 'unavailable') ? st : null;
          return (
            <div key={item.id} className={`cmp-current-row${item.visible ? '' : ' off'}`}>
              <span className="cmp-current-dot" style={{ background: item.color }} />
              <span className="cmp-current-name" title={item.symbol}>
                {item.symbol}
              </span>
              {problem ? (
                <span className="cmp-current-status" title={problem.message}>
                  {problem.message}
                </span>
              ) : null}
              <select
                className="cmp-current-select"
                value={item.placement}
                aria-label={`Placement of ${item.symbol}`}
                onChange={(e) => setComparePlacement(item.id, e.target.value as ComparePlacement)}
              >
                {PLACEMENTS.map((p) => (
                  <option key={p} value={p}>
                    {PLACEMENT_NAMES[p]}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="io-icon-btn"
                aria-label={item.visible ? `Hide ${item.symbol}` : `Show ${item.symbol}`}
                onClick={() => toggleCompareVisible(item.id)}
              >
                {item.visible ? <Eye size={16} /> : <EyeOff size={16} />}
              </button>
              <button
                type="button"
                className="io-icon-btn"
                aria-label={`Remove ${item.symbol}`}
                onClick={() => removeCompare(item.id)}
              >
                <X size={16} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Overlay other symbols, or symbol expressions, on the chart. */
export default function CompareDialog({ onClose }: { onClose: () => void; arg?: unknown }) {
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<SymbolTab>('all');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const count = useCompareStore((s) => s.items.length);
  const atCap = count >= MAX_COMPARES;
  const q = query.trim();
  const kind = classifyQuery(q);
  // Operator queries are expressions, not names to look up.
  const search = useSymbolSearch(kind.kind === 'plain' ? query : '');
  const found = kind.kind === 'plain' ? search.items.filter((r) => matchesTab(r, tab)) : [];
  const rows: { symbol: string; expression: boolean; result?: SymbolSearchResult }[] = [
    ...(kind.kind === 'expression' ? [{ symbol: kind.canonical, expression: true }] : []),
    ...found.map((r) => ({ symbol: r.symbol, expression: false, result: r })),
  ];
  const idx = Math.max(0, Math.min(active, rows.length - 1));

  const add = (symbol: string, p: ComparePlacement) => {
    if (atCap) return;
    addCompare(symbol, p);
    input.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const n = rows.length;
    if (e.key === 'ArrowDown') setActive(n ? (idx + 1) % n : 0);
    else if (e.key === 'ArrowUp') setActive(n ? (idx - 1 + n) % n : 0);
    else if (e.key === 'Enter') {
      if (q !== '' && kind.kind !== 'error') {
        // While results are loading the typed symbol wins, so fast typists get what they typed.
        const row = kind.kind === 'expression' || search.fresh ? rows[idx] : undefined;
        if (row) add(row.symbol, placementOf(e));
        else if (!search.fresh) add(q, placementOf(e));
      }
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
        <p className="dlg-emptystate-hint">
          Type a ticker, or an expression such as <b>AAPL/MSFT</b> or <b>(AAPL+MSFT)/2</b>.
        </p>
      </div>
    );
  } else if (kind.kind === 'error') {
    body = (
      <>
        <ExpressionErrorBox query={q} error={kind.error} />
        <div className="dlg-compare-actions">
          <AddButtons symbol={q} disabled onAdd={add} />
        </div>
      </>
    );
  } else if (kind.kind === 'plain' && search.error) {
    body = (
      <div className="dlg-empty dlg-error" role="alert">
        Search failed: {search.error}
      </div>
    );
  } else if (kind.kind === 'plain' && search.tooShort) {
    body = <div className="dlg-empty">Type at least {search.minChars} characters to search</div>;
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
    body = rows.map((r, i) => {
      const action = <AddButtons symbol={r.symbol} disabled={atCap} onAdd={add} />;
      return r.expression ? (
        <ExpressionRow
          key={`expr-${r.symbol}`}
          canonical={r.symbol}
          active={i === idx}
          onHover={() => setActive(i)}
          onSelect={() => add(r.symbol, 'same')}
          action={action}
        />
      ) : (
        <SymbolRow
          key={`${r.symbol}-${i}`}
          result={r.result!}
          query={q}
          active={i === idx}
          onHover={() => setActive(i)}
          onSelect={() => add(r.symbol, 'same')}
          action={action}
        />
      );
    });
  }

  return (
    <Modal title="Compare symbol" onClose={onClose} width={720} top className="dlg-compare">
      <div className="dlg-search">
        <Search size={18} strokeWidth={1.8} className="dlg-search-icon" />
        <input
          ref={input}
          className="dlg-search-input"
          value={query}
          placeholder="Search, or type an expression like AAPL/MSFT"
          aria-label="Search symbols to compare"
          aria-invalid={kind.kind === 'error' || undefined}
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
      <CurrentCompares />
      <div className="dlg-hints">
        {atCap ? (
          <span role="status">At most {MAX_COMPARES} symbols can be compared</span>
        ) : (
          <>
            <span>
              <kbd>Enter</kbd> same % scale
            </span>
            <span>
              <kbd>Shift</kbd>
              <kbd>Enter</kbd> new price scale
            </span>
            <span>
              <kbd>Alt</kbd>
              <kbd>Enter</kbd> new pane
            </span>
          </>
        )}
      </div>
    </Modal>
  );
}
