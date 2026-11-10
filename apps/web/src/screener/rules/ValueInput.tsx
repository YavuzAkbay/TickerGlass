import { ArrowLeftRight } from 'lucide-react';
import { useState } from 'react';
import { useT } from '../../i18n';
import type { FieldDef, RuleOp, RuleValue } from '../server/types';
import { FieldPicker } from './FieldPicker';
import {
  dateEdge,
  dateToSeconds,
  formatNumber,
  parseNumberText,
  sameDimension,
  secondsToDate,
  valueKind,
} from './rules';

interface Props {
  def: FieldDef;
  op: RuleOp;
  value: RuleValue | null;
  fields: readonly FieldDef[];
  onChange: (value: RuleValue | null) => void;
  invalid?: boolean | undefined;
}

const UNIT_SUFFIX: Partial<Record<FieldDef['type'], string>> = { percent: '%', money: '$' };

/** Number text box: money accepts 10B / 2.5M / 300K; commits a parsed number (null while unparsable). */
function NumberBox({
  def,
  value,
  onChange,
  label,
  invalid,
  testId = 'rb-value',
}: {
  def: FieldDef;
  value: number | null;
  onChange: (v: number | null) => void;
  label: string;
  invalid?: boolean | undefined;
  testId?: string;
}) {
  const [text, setText] = useState(value === null ? '' : formatNumber(def.type, value));
  const shorthand = def.type === 'money';
  const bad = text.trim() !== '' && parseNumberText(text, shorthand) === null;
  const suffix = UNIT_SUFFIX[def.type];
  return (
    <span className={`rb-num${suffix ? ` rb-num-${def.type}` : ''}`}>
      {def.type === 'money' ? (
        <span className="rb-unit" aria-hidden="true">
          $
        </span>
      ) : null}
      <input
        className={`io-input rb-input rs-num${invalid || bad ? ' invalid' : ''}`}
        inputMode="decimal"
        spellCheck={false}
        autoComplete="off"
        aria-label={label}
        aria-invalid={invalid || bad || undefined}
        data-testid={testId}
        placeholder={shorthand ? '10B' : ''}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          onChange(parseNumberText(e.target.value, shorthand));
        }}
      />
      {def.type === 'percent' ? (
        <span className="rb-unit" aria-hidden="true">
          %
        </span>
      ) : null}
    </span>
  );
}

/** A UTC day picker for one end of a `between` on a date field: the low end is the start of the
 * day, the high end its last second, so both picked days are inside the range. */
function DateBox({
  value,
  side,
  onChange,
  label,
  invalid,
  testId,
}: {
  value: number | null;
  side: 'lo' | 'hi';
  onChange: (v: number | null) => void;
  label: string;
  invalid?: boolean | undefined;
  testId: string;
}) {
  return (
    <input
      type="date"
      className={`io-input rb-input${invalid ? ' invalid' : ''}`}
      aria-label={label}
      data-testid={testId}
      value={value === null ? '' : secondsToDate(value)}
      onChange={(e) => onChange(dateToSeconds(e.target.value, dateEdge('between', side)))}
    />
  );
}

const asNumber = (v: RuleValue | null): number | null => (typeof v === 'number' ? v : null);

/**
 * The value editor of one rule; the widget follows the field type and the op. Give it a
 * `key` of field+op so its text state resets when either changes.
 */
export function ValueInput({ def, op, value, fields, onChange, invalid }: Props) {
  const t = useT();
  const kind = valueKind(def, op);
  const others = sameDimension(fields, def);
  const asField =
    typeof value === 'object' && value !== null && !Array.isArray(value) && !('pct' in value);

  switch (kind) {
    case 'bool':
      return (
        <select
          className="io-input rb-select rb-bool"
          aria-label={t('scr.rb.value')}
          data-testid="rb-value"
          value={value === false ? 'no' : 'yes'}
          onChange={(e) => onChange(e.target.value === 'yes')}
        >
          <option value="yes">{t('scr.rb.yes')}</option>
          <option value="no">{t('scr.rb.no')}</option>
        </select>
      );
    case 'enum':
      return (
        <select
          className="io-input rb-select"
          aria-label={t('scr.rb.value')}
          data-testid="rb-value"
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value || null)}
        >
          {typeof value !== 'string' ? <option value="">{'–'}</option> : null}
          {(def.enumValues ?? []).map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      );
    case 'text':
      return (
        <input
          className={`io-input rb-input${invalid ? ' invalid' : ''}`}
          aria-label={t('scr.rb.value')}
          data-testid="rb-value"
          spellCheck={false}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value || null)}
        />
      );
    case 'date':
      return (
        <input
          type="date"
          className={`io-input rb-input${invalid ? ' invalid' : ''}`}
          aria-label={t('scr.rb.value')}
          data-testid="rb-value"
          value={typeof value === 'number' ? secondsToDate(value) : ''}
          onChange={(e) => onChange(dateToSeconds(e.target.value, dateEdge(op)))}
        />
      );
    case 'between': {
      const pair =
        Array.isArray(value) && value.length === 2
          ? (value as unknown as (number | null)[])
          : [null, null];
      const set = (i: 0 | 1, n: number | null) => {
        const next: (number | null)[] = [pair[0] ?? null, pair[1] ?? null];
        next[i] = n;
        onChange(next[0] === null && next[1] === null ? null : (next as unknown as RuleValue));
      };
      const isDate = def.type === 'date';
      return (
        <span className="rb-between">
          {isDate ? (
            <DateBox
              value={pair[0] ?? null}
              side="lo"
              onChange={(n) => set(0, n)}
              label={t('scr.rb.from')}
              invalid={invalid}
              testId="rb-value-lo"
            />
          ) : (
            <NumberBox
              def={def}
              value={pair[0] ?? null}
              onChange={(n) => set(0, n)}
              label={t('scr.rb.from')}
              invalid={invalid}
              testId="rb-value-lo"
            />
          )}
          <span className="rb-and" aria-hidden="true">
            {t('scr.rb.andWord')}
          </span>
          {isDate ? (
            <DateBox
              value={pair[1] ?? null}
              side="hi"
              onChange={(n) => set(1, n)}
              label={t('scr.rb.to')}
              invalid={invalid}
              testId="rb-value-hi"
            />
          ) : (
            <NumberBox
              def={def}
              value={pair[1] ?? null}
              onChange={(n) => set(1, n)}
              label={t('scr.rb.to')}
              invalid={invalid}
              testId="rb-value-hi"
            />
          )}
        </span>
      );
    }
    case 'list': {
      const chosen = Array.isArray(value) ? (value as string[]) : [];
      if (def.enumValues?.length)
        return (
          <span
            className="rb-chips"
            role="group"
            aria-label={t('scr.rb.value')}
            data-testid="rb-value"
          >
            {def.enumValues.map((v) => {
              const on = chosen.includes(v);
              return (
                <label key={v} className={`rb-chip${on ? ' on' : ''}`}>
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() => {
                      const next = on ? chosen.filter((x) => x !== v) : [...chosen, v];
                      onChange(next.length ? next : null);
                    }}
                  />
                  {v}
                </label>
              );
            })}
          </span>
        );
      return (
        <input
          className={`io-input rb-input${invalid ? ' invalid' : ''}`}
          aria-label={t('scr.rb.valueList')}
          data-testid="rb-value"
          spellCheck={false}
          placeholder={t('scr.rb.listHint')}
          defaultValue={chosen.join(', ')}
          onChange={(e) => {
            const items = e.target.value
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean);
            onChange(items.length ? items : null);
          }}
        />
      );
    }
    case 'pct': {
      const cur =
        typeof value === 'object' && value !== null && !Array.isArray(value) && 'pct' in value
          ? value
          : null;
      const target = cur?.field ?? others[0]?.id ?? '';
      return (
        <span className="rb-pct">
          <PctBox
            value={cur?.pct ?? null}
            onChange={(pct) => onChange(pct === null || !target ? null : { field: target, pct })}
            invalid={invalid}
          />
          <span className="rb-and" aria-hidden="true">
            {op === 'abovePct' ? t('scr.rb.above') : t('scr.rb.below')}
          </span>
          <FieldPicker
            fields={fields}
            only={others}
            value={target}
            label={t('scr.rb.otherField')}
            testId="rb-value-field"
            onChange={(id) => onChange(cur ? { field: id, pct: cur.pct } : null)}
          />
        </span>
      );
    }
    default: {
      if (asField) {
        const ref = (value as { field: string }).field;
        return (
          <span className="rb-operand">
            <FieldPicker
              fields={fields}
              only={others}
              value={ref}
              label={t('scr.rb.otherField')}
              testId="rb-value-field"
              onChange={(id) => onChange({ field: id })}
            />
            <SwapButton onClick={() => onChange(null)} label={t('scr.rb.useNumber')} />
          </span>
        );
      }
      return (
        <span className="rb-operand">
          <NumberBox
            def={def}
            value={asNumber(value)}
            onChange={onChange}
            label={t('scr.rb.value')}
            invalid={invalid}
          />
          {others.length ? (
            <SwapButton
              onClick={() => onChange({ field: others[0]!.id })}
              label={t('scr.rb.useField')}
            />
          ) : null}
        </span>
      );
    }
  }
}

function SwapButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      className="rb-icon-btn"
      aria-label={label}
      title={label}
      data-testid="rb-swap"
      onClick={onClick}
    >
      <ArrowLeftRight size={13} aria-hidden="true" />
    </button>
  );
}

/** The percentage of an above/below-by-percent rule. */
function PctBox({
  value,
  onChange,
  invalid,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  invalid?: boolean | undefined;
}) {
  const t = useT();
  const [text, setText] = useState(value === null ? '' : String(value));
  const bad = text.trim() !== '' && parseNumberText(text) === null;
  return (
    <span className="rb-num rb-num-percent">
      <input
        className={`io-input rb-input rs-num${invalid || bad ? ' invalid' : ''}`}
        inputMode="decimal"
        aria-label={t('scr.rb.percent')}
        data-testid="rb-value"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          onChange(parseNumberText(e.target.value));
        }}
      />
      <span className="rb-unit" aria-hidden="true">
        %
      </span>
    </span>
  );
}
