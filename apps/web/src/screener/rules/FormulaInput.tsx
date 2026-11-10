import { useId, useMemo, useRef, useState } from 'react';
import { useT, type MessageKey, type MessageParams } from '../../i18n';
import type { FieldDef } from '../server/types';
import { fieldLabel } from './rules';
import {
  applySuggestion,
  FORMULA_MAX_ARGS,
  FORMULA_MAX_DEPTH,
  FORMULA_MAX_LENGTH,
  FORMULA_MAX_MINMAX_NESTING,
  FORMULA_MAX_NODES,
  FORMULA_MAX_NUMBER_CHARS,
  parseFormula,
  suggest,
  type FormulaError,
  type FormulaReason,
  type FormulaSuggestion,
} from './formula';

const REASON_KEYS: Record<FormulaReason, MessageKey> = {
  empty: 'scr.fx.e.empty',
  char: 'scr.fx.e.char',
  numberLong: 'scr.fx.e.numberLong',
  unexpected: 'scr.fx.e.unexpected',
  end: 'scr.fx.e.end',
  close: 'scr.fx.e.close',
  unknownFn: 'scr.fx.e.unknownFn',
  prevArg: 'scr.fx.e.prevArg',
  maxArgs: 'scr.fx.e.maxArgs',
  minArgs: 'scr.fx.e.minArgs',
  unknownField: 'scr.fx.e.unknownField',
  notNumeric: 'scr.fx.e.notNumeric',
  notCrossable: 'scr.fx.e.notCrossable',
  unavailable: 'scr.fx.e.unavailable',
  length: 'scr.fx.e.length',
  depth: 'scr.fx.e.depth',
  nodes: 'scr.fx.e.nodes',
  minmax: 'scr.fx.e.minmax',
};

/** Human message of a formula error (the caret shows where). */
export function formulaMessage(
  err: FormulaError,
  t: (key: MessageKey, params?: MessageParams) => string,
): string {
  const n =
    err.reason === 'length'
      ? FORMULA_MAX_LENGTH
      : err.reason === 'nodes'
        ? FORMULA_MAX_NODES
        : err.reason === 'depth'
          ? FORMULA_MAX_DEPTH
          : err.reason === 'numberLong'
            ? FORMULA_MAX_NUMBER_CHARS
            : err.reason === 'minmax'
              ? FORMULA_MAX_MINMAX_NESTING
              : err.reason === 'maxArgs'
                ? FORMULA_MAX_ARGS
                : 2;
  const text = t(REASON_KEYS[err.reason], { name: err.name ?? '', n });
  return `${text} (${t('scr.fx.at', { n: err.offset + 1 })})`;
}

interface Props {
  value: string;
  onChange: (text: string) => void;
  fields: readonly FieldDef[];
}

/**
 * Formula text box: monospace input with live validation against the field catalog (the
 * client mirror of the server grammar), a caret under the offending character and an
 * autocomplete list of field ids and functions (ARIA combobox; arrows, Enter/Tab, Escape).
 */
export function FormulaInput({ value, onChange, fields }: Props) {
  const t = useT();
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [caret, setCaret] = useState<number | null>(null);
  const [active, setActive] = useState(0);
  const [closed, setClosed] = useState(false);

  const parsed = useMemo(
    () => (value.trim() === '' ? null : parseFormula(value, fields)),
    [value, fields],
  );
  const error = parsed && !parsed.ok ? parsed.error : null;
  const items = useMemo(
    () => (caret === null || closed ? [] : suggest(value, caret, fields)),
    [value, caret, fields, closed],
  );
  const open = items.length > 0;
  const current = open ? Math.min(active, items.length - 1) : -1;

  const sync = (el: HTMLInputElement) => setCaret(el.selectionStart ?? el.value.length);
  const pick = (s: FormulaSuggestion) => {
    const pos = caret ?? value.length;
    const next = applySuggestion(value, pos, s);
    onChange(next.text);
    setCaret(next.caret);
    setActive(0);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(next.caret, next.caret);
      }
    });
  };

  return (
    <span className="rb-fx">
      <span className="rb-fx-box">
        <input
          ref={inputRef}
          className={`io-input rb-input rb-fx-input${error ? ' invalid' : ''}`}
          role="combobox"
          aria-label={t('scr.fx.label')}
          aria-invalid={!!error || undefined}
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listId}
          aria-activedescendant={open ? `${listId}-${current}` : undefined}
          title={t('scr.fx.help')}
          data-testid="rb-formula"
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          maxLength={FORMULA_MAX_LENGTH * 2}
          placeholder={t('scr.fx.placeholder')}
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            setClosed(false);
            setActive(0);
            sync(e.target);
          }}
          onSelect={(e) => sync(e.currentTarget)}
          onBlur={() => setCaret(null)}
          onKeyDown={(e) => {
            if (!open) return;
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              const step = e.key === 'ArrowDown' ? 1 : -1;
              setActive((current + step + items.length) % items.length);
            } else if (e.key === 'Enter' || e.key === 'Tab') {
              const s = items[current];
              if (s) {
                e.preventDefault();
                pick(s);
              }
            } else if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              setClosed(true);
            }
          }}
        />
        {open ? (
          <ul
            id={listId}
            className="rb-fx-list"
            role="listbox"
            aria-label={t('scr.fx.suggestions')}
            data-testid="rb-formula-suggestions"
          >
            {items.map((s, i) => (
              <li
                key={`${s.kind}:${s.id}`}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === current}
                className={`rb-fx-opt${i === current ? ' on' : ''}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(s);
                }}
              >
                <span className="rb-fx-id">{s.kind === 'function' ? `${s.id}()` : s.id}</span>
                <span className="rb-fx-kind">
                  {s.kind === 'function' ? t('scr.fx.fn') : fieldLabel(s.id)}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </span>
      {error ? (
        <span className="rb-fx-err" role="alert" data-testid="rb-formula-error">
          <span className="rb-fx-caret" aria-hidden="true">
            <span className="rb-fx-pre">{value.slice(0, error.offset)}</span>^
          </span>
          <span>{formulaMessage(error, t)}</span>
        </span>
      ) : null}
    </span>
  );
}
