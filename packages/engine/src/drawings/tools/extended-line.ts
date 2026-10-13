import { defineDrawingTool } from '../registry';
import { TREND_LINE_DEFAULTS, trendLine } from './trend-line';

/** Trend line extended both ways by default (both extends stay editable, by convention). */
export const extendedLine = defineDrawingTool({
  ...trendLine,
  type: 'extended-line',
  name: 'Extended line',
  defaults: { ...TREND_LINE_DEFAULTS, extendLeft: true, extendRight: true },
});
