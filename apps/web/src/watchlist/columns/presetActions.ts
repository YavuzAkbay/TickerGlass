import { t } from '../../i18n';
import { promptName } from '../../ui/Prompt';
import { toast } from '../../ui/Toast';
import { useWatchlistPagePrefs } from '../page/pagePrefs';
import type { ColumnId } from '../types';
import { MAX_PRESET_NAME, MAX_PRESETS, type ColumnWidths } from './presets';
import type { Surface } from './registry';

/** Ask for a name and save `columns`/`widths` (from `surface`) as a preset (the same name replaces). */
export async function saveColumnPreset(
  columns: ColumnId[],
  widths: ColumnWidths,
  surface: Surface,
): Promise<void> {
  const name = await promptName({
    title: t('wlp.presetSaveTitle'),
    label: t('wlp.presetName'),
    okLabel: t('wlp.presetSave'),
  });
  if (!name) return;
  const clean = name.replace(/\s+/g, ' ').trim().slice(0, MAX_PRESET_NAME);
  if (!clean) return;
  if (useWatchlistPagePrefs.getState().savePreset(clean, columns, widths, surface))
    toast(t('wlp.presetSaved', { name: clean }), 'success');
  else toast(t('wlp.presetsFull', { max: MAX_PRESETS }), 'error');
}

export function deleteColumnPreset(name: string): void {
  useWatchlistPagePrefs.getState().deletePreset(name);
  toast(t('wlp.presetDeleted', { name }), 'info');
}
