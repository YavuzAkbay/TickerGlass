import { tryParseSymbolExpression, type ExpressionError } from '@investopen/engine';
import { SquareFunction } from 'lucide-react';
import type { ReactNode } from 'react';

export type QueryKind =
  | { kind: 'plain' }
  /** A symbol expression with its canonical form. */
  | { kind: 'expression'; canonical: string }
  /** Looks like an expression (operators typed) but does not parse. */
  | { kind: 'error'; error: ExpressionError };

/** Operators typed: this is an expression attempt, not a ticker/company search. */
const OPERATORS = /[+*/()]| - /;

/** Two or more alphabetic words in a row ("Class A"): reads like a company name. */
const COMPANY_NAME = /[A-Za-z]+(?: +[A-Za-z]+)+/;

/** How a (trimmed) search query reads: plain search text, a symbol expression, or a broken one. */
export function classifyQuery(q: string): QueryKind {
  if (q === '') return { kind: 'plain' };
  const parsed = tryParseSymbolExpression(q);
  if (parsed.ok) {
    return parsed.value.plain
      ? { kind: 'plain' }
      : { kind: 'expression', canonical: parsed.value.canonical };
  }
  return OPERATORS.test(q) && !COMPANY_NAME.test(q)
    ? { kind: 'error', error: parsed.error }
    : { kind: 'plain' };
}

/** Parse error with a caret under the offending character. */
export function ExpressionErrorBox({ query, error }: { query: string; error: ExpressionError }) {
  return (
    <div className="dlg-expr-error" role="alert">
      <pre>
        {query}
        {'\n'}
        {' '.repeat(Math.min(error.pos, query.length))}^
      </pre>
      <span>{error.message}</span>
    </div>
  );
}

interface Props {
  /** Canonical form of the typed expression. */
  canonical: string;
  active: boolean;
  onSelect: () => void;
  onHover: () => void;
  /** Trailing actions (e.g. compare placement buttons). */
  action?: ReactNode;
}

/** Top row of the symbol dialogs when the query is a symbol expression, e.g. AAPL/MSFT. */
export function ExpressionRow({ canonical, active, onSelect, onHover, action }: Props) {
  return (
    <div
      role="option"
      aria-selected={active}
      data-active={active || undefined}
      data-expression
      className={`dlg-symrow${active ? ' active' : ''}`}
      onPointerMove={onHover}
      onClick={onSelect}
    >
      <span className="dlg-symlogo" aria-hidden="true">
        <SquareFunction size={14} />
      </span>
      <span className="dlg-symexpr" title={canonical}>
        {canonical}
      </span>
      <span className="dlg-symbadge">Expression</span>
      {action}
    </div>
  );
}
