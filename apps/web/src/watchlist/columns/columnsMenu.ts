import type { MenuItem } from '../../ui/Menu';
import { t } from '../../i18n';
import {
  BUILTIN_PRESETS,
  presetFor,
  sameColumns,
  type ColumnPreset,
  type ColumnWidths,
} from './presets';
import { COLUMN_DEFS, columnIdsOf, type Surface } from './registry';
import type { ColumnId } from '../types';

interface Args {
  surface: Surface;
  columns: readonly ColumnId[];
  presets: readonly ColumnPreset[];
  onToggle: (id: ColumnId) => void;
  /** Replace the shown columns (built-in presets also reset widths); `preset` for a saved one. */
  onApply: (columns: ColumnId[], widths: ColumnWidths, preset?: ColumnPreset) => void;
  onSavePreset: () => void;
  onDeletePreset: (name: string) => void;
  clearSort: { disabled: boolean; onSelect: () => void };
  /** Surface-specific entries below "Clear sort". */
  extra?: MenuItem[];
}

/** The columns menu of both tables: presets, column toggles, clear sort. */
export function columnsMenu(a: Args): MenuItem[] {
  const builtins = BUILTIN_PRESETS.map((p): MenuItem => {
    const columns = p.columns[a.surface];
    return {
      label: t(p.label),
      checked: sameColumns(a.columns, columns),
      onSelect: () => a.onApply([...columns], {}),
    };
  });
  const saved = a.presets.map((p): MenuItem => {
    const v = presetFor(p, a.surface);
    return {
      label: p.name,
      checked: sameColumns(a.columns, v.columns),
      disabled: v.columns.length === 0,
      onSelect: () => a.onApply(v.columns, v.widths, p),
    };
  });
  return [
    {
      label: t('wlp.presets'),
      submenu: [
        ...builtins,
        ...(saved.length ? ([{ type: 'separator' }, ...saved] as MenuItem[]) : []),
        { type: 'separator' },
        { label: t('wlp.presetSaveAs'), onSelect: a.onSavePreset },
        ...(a.presets.length
          ? ([
              {
                label: t('wlp.presetDelete'),
                submenu: a.presets.map((p): MenuItem => ({
                  label: p.name,
                  danger: true,
                  onSelect: () => a.onDeletePreset(p.name),
                })),
              },
            ] as MenuItem[])
          : []),
      ],
    },
    { type: 'separator' },
    ...columnIdsOf(a.surface).map((id): MenuItem => ({
      label: COLUMN_DEFS[id].label,
      checked: a.columns.includes(id),
      onSelect: () => a.onToggle(id),
    })),
    { type: 'separator' },
    { label: t('wlp.clearSort'), disabled: a.clearSort.disabled, onSelect: a.clearSort.onSelect },
    ...(a.extra ?? []),
  ];
}
