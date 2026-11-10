import { useMemo } from 'react';
import { useT, type MessageKey } from '../../i18n';
import type { FieldCategory, FieldDef } from '../server/types';
import { fieldLabel } from './rules';

/** Display order of the picker's groups. */
export const CATEGORY_ORDER: readonly FieldCategory[] = [
  'price',
  'performance',
  'technical',
  'volume',
  'fundamental',
  'meta',
];

export const CATEGORY_KEYS: Record<FieldCategory, MessageKey> = {
  meta: 'scr.cat.meta',
  price: 'scr.cat.price',
  performance: 'scr.cat.performance',
  technical: 'scr.cat.technical',
  volume: 'scr.cat.volume',
  fundamental: 'scr.cat.fundamental',
};

/** Selectable fields by category in display order; unavailable ones are left out. */
export function groupFields(fields: readonly FieldDef[]): [FieldCategory, FieldDef[]][] {
  const out: [FieldCategory, FieldDef[]][] = [];
  for (const cat of CATEGORY_ORDER) {
    const list = fields.filter((f) => f.category === cat && f.available && f.ops.length > 0);
    if (list.length) out.push([cat, list]);
  }
  return out;
}

interface Props {
  fields: readonly FieldDef[];
  value: string;
  onChange: (id: string) => void;
  /** Restrict to these ids (e.g. the same-dimension operand fields). */
  only?: readonly FieldDef[];
  label?: string;
  invalid?: boolean;
  testId?: string;
}

/**
 * Field select grouped by category (native `<optgroup>`s: keyboard and screen
 * reader friendly). Fields the provider cannot serve are not offered; a saved rule that
 * still names one keeps it as a disabled entry so the row does not silently change.
 */
export function FieldPicker({ fields, value, onChange, only, label, invalid, testId }: Props) {
  const t = useT();
  const groups = useMemo(() => groupFields(only ?? fields), [fields, only]);
  const known = (only ?? fields).find((f) => f.id === value);
  const orphan = !groups.some(([, list]) => list.some((f) => f.id === value));
  return (
    <select
      className={`io-input rb-select${invalid ? ' invalid' : ''}`}
      aria-label={label ?? t('scr.rb.field')}
      aria-invalid={invalid || undefined}
      data-testid={testId ?? 'rb-field'}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {orphan ? (
        <option value={value} disabled title={t('scr.rb.unavailableField')}>
          {fieldLabel(value)}
          {known && !known.available ? ` (${t('scr.rb.unavailable')})` : ''}
        </option>
      ) : null}
      {groups.map(([cat, list]) => (
        <optgroup key={cat} label={t(CATEGORY_KEYS[cat])}>
          {list.map((f) => (
            <option key={f.id} value={f.id}>
              {fieldLabel(f.id)}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}
