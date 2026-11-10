import { LayoutGrid, Table2 } from 'lucide-react';
import { useT } from '../i18n';
import type { ViewMode } from './viewMode';
import './heatmap.css';

interface Props {
  value: ViewMode;
  onChange: (mode: ViewMode) => void;
  /** Test id prefix (`<prefix>-table`, `<prefix>-heatmap`). */
  testId: string;
}

/** Segmented Table | Heatmap switch of a list screen's header. */
export function ViewToggle({ value, onChange, testId }: Props) {
  const t = useT();
  return (
    <div className="hm-toggle" role="group" aria-label={t('hm.view')} data-testid={testId}>
      <button
        type="button"
        className={`hm-toggle-btn${value === 'table' ? ' on' : ''}`}
        aria-pressed={value === 'table'}
        data-testid={`${testId}-table`}
        onClick={() => onChange('table')}
      >
        <Table2 size={14} strokeWidth={1.6} aria-hidden="true" />
        <span>{t('hm.view.table')}</span>
      </button>
      <button
        type="button"
        className={`hm-toggle-btn${value === 'heatmap' ? ' on' : ''}`}
        aria-pressed={value === 'heatmap'}
        data-testid={`${testId}-heatmap`}
        onClick={() => onChange('heatmap')}
      >
        <LayoutGrid size={14} strokeWidth={1.6} aria-hidden="true" />
        <span>{t('hm.view.heatmap')}</span>
      </button>
    </div>
  );
}
