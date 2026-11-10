import { useT } from '../i18n';
import './heatmap.css';

interface Props<T extends string> {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  testId: string;
}

/** "Group: None | Sector | …" picker shared by the heatmap toolbars and the screener table. */
export function GroupSelect<T extends string>({ value, options, onChange, testId }: Props<T>) {
  const t = useT();
  return (
    <label className="hm-field">
      <span>{t('hm.group')}</span>
      <select
        className="hm-select"
        data-testid={testId}
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
