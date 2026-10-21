import { useState } from 'react';
import { SymbolRow, useSymbolSearch } from './symbolSearch';
import './symbolField.css';

/**
 * Symbol text field with feed search suggestions (the Symbol Search list).
 * Commits an upper-cased symbol on pick or Enter/blur; Escape reverts the text.
 */
export function SymbolField({
  id,
  value,
  label,
  placeholder,
  clearOnCommit = false,
  onCommit,
}: {
  id?: string;
  value: string;
  label: string;
  placeholder?: string;
  /** Free-entry mode: empty again after a commit. */
  clearOnCommit?: boolean;
  onCommit: (symbol: string) => void;
}) {
  const [text, setText] = useState(value);
  const [shown, setShown] = useState(value);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  // Follow external changes (reset, undo) without fighting the user's typing.
  if (value !== shown) {
    setShown(value);
    setText(value);
  }
  const query = open && text.trim().toUpperCase() !== value ? text : '';
  const search = useSymbolSearch(query, 8);

  const commit = (raw: string) => {
    const symbol = raw.trim().toUpperCase();
    setOpen(false);
    if (!symbol) {
      setText(value);
      return;
    }
    setText(clearOnCommit ? '' : symbol);
    if (symbol !== value) onCommit(symbol);
  };

  return (
    <div className="sym-field">
      <input
        id={id}
        className="io-input"
        aria-label={label}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          // Let a click on a suggestion land first.
          setTimeout(() => setOpen(false), 120);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            const n = search.items.length;
            if (n) setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
          } else if (e.key === 'Enter') {
            e.preventDefault();
            commit(text);
          } else if (e.key === 'Escape' && open) {
            e.stopPropagation();
            setText(value);
            setOpen(false);
          }
        }}
      />
      {open && search.items.length ? (
        <div className="sym-field-list" role="listbox" aria-label={`${label} suggestions`}>
          {search.items.map((r, i) => (
            <SymbolRow
              key={`${r.symbol}|${r.exchange ?? ''}`}
              result={r}
              query={text}
              active={i === active}
              onHover={() => setActive(i)}
              onSelect={() => commit(r.symbol)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
