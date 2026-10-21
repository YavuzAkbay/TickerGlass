/**
 * Chart templates (Settings dialog "Template" menu): every chart setting
 * except the per-chart price scale, stored in `/chart-templates`.
 */
import type { ChartStyle, CrosshairMode, DeepPartial, MagnetMode } from '@tickerglass/engine';
import type { Theme } from '../store/app';
import { pickTyped } from './settingsSync';

export const CHART_TEMPLATE_SCHEMA_VERSION = 1;

export interface ChartTemplateData {
  theme: Theme;
  crosshair: CrosshairMode;
  magnet: MagnetMode;
  prepost: boolean;
  timezone: string;
  chartStyle: DeepPartial<ChartStyle>;
  showPrevClose: boolean;
}

/** The template part of a settings draft. */
export function templateData<D extends ChartTemplateData>(d: D): ChartTemplateData {
  return {
    theme: d.theme,
    crosshair: d.crosshair,
    magnet: d.magnet,
    prepost: d.prepost,
    timezone: d.timezone,
    chartStyle: d.chartStyle,
    showPrevClose: d.showPrevClose,
  };
}

const ENUMS: Partial<Record<keyof ChartTemplateData, readonly string[]>> = {
  theme: ['dark', 'light'],
  crosshair: ['cross', 'dot', 'arrow'],
  magnet: ['off', 'weak', 'strong'],
};

/** `base` with a stored template's values on top (unknown or mistyped fields are ignored). */
export function readChartTemplate<D extends ChartTemplateData>(base: D, data: unknown): D {
  const patch = pickTyped(templateData(base), data);
  for (const [k, allowed] of Object.entries(ENUMS) as [keyof ChartTemplateData, string[]][])
    if (patch[k] !== undefined && !allowed.includes(patch[k] as string)) delete patch[k];
  return { ...base, ...patch };
}
