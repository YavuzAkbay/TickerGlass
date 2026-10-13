import { defineDrawingTool } from '../registry';
import { TREND_LINE_DEFAULTS, trendLine } from './trend-line';

/** Trend line extended to the right by default (both extends stay editable, by convention). */
export const ray = defineDrawingTool({
  ...trendLine,
  type: 'ray',
  name: 'Ray',
  defaults: { ...TREND_LINE_DEFAULTS, extendRight: true },
});
