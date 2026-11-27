/** Tool definitions of the Full tier (see fullTools.ts); no runtime imports from tools.ts so
 * the tool list can be built while modules are still loading. */
import { CHART_TYPES } from '@tickerglass/engine';
import { RANGE_PRESETS } from '../bottombar/ranges';
import type { ToolSchema } from './tools';

export const BARS_DEFAULT = 250;

const fn = (
  name: string,
  description: string,
  properties: Record<string, unknown> = {},
  required: string[] = [],
): ToolSchema => ({
  type: 'function',
  function: {
    name,
    description,
    parameters: { type: 'object', properties, ...(required.length ? { required } : {}) },
  },
});

const SYMBOL = { type: 'string', description: 'Ticker; omit for the chart symbol' };

export const FULL_SCHEMAS: ToolSchema[] = [
  fn(
    'list_drawings',
    "List the drawings on the chart (the user's and the AI's) with ids, types, anchor points and text. Read-only.",
  ),
  fn(
    'update_drawing',
    'Change a drawing by id: move its anchor points, change its text, colour tone, or hide/show it.',
    {
      id: { type: 'string' },
      points: {
        type: 'array',
        items: {
          type: 'object',
          properties: { time: { type: 'string' }, price: { type: 'number' } },
        },
      },
      text: { type: 'string' },
      tone: { type: 'string', enum: ['bullish', 'bearish', 'neutral'] },
      hidden: { type: 'boolean' },
    },
    ['id'],
  ),
  fn(
    'remove_drawing',
    'Remove drawings by id.',
    { ids: { type: 'array', items: { type: 'string' } } },
    ['ids'],
  ),
  fn(
    'edit_indicator',
    'Change an indicator\'s inputs by id (from list_indicators), e.g. {"length": 50}. Input keys: search_indicators.',
    { id: { type: 'string' }, inputs: { type: 'object' } },
    ['id', 'inputs'],
  ),
  fn(
    'set_chart',
    'Switch the chart: symbol, interval (1m 5m 15m 1h 4h 1D 1W 1M), visible range (1D 1W 1M 3M 1Y 3Y Max, which also picks a matching interval unless one is given) and chart type. Returns the new chart context.',
    {
      symbol: { type: 'string' },
      interval: { type: 'string' },
      range: { type: 'string', enum: RANGE_PRESETS.map((p) => p.label) },
      chart_type: { type: 'string', enum: CHART_TYPES },
    },
  ),
  fn(
    'get_bars',
    'Price history of any symbol (not shown on the chart): statistics, swings and bars, plus its change next to the chart symbol over the same dates. Read-only.',
    {
      symbol: { type: 'string' },
      interval: { type: 'string', description: 'Default 1D' },
      bars: { type: 'number', description: `How many recent bars (default ${BARS_DEFAULT})` },
    },
    ['symbol'],
  ),
  fn(
    'get_fundamentals',
    'Financial statements and valuation of a symbol (see get_fundamentals); with symbol, of another company. Read-only.',
    { symbol: SYMBOL },
  ),
  fn(
    'get_events',
    'Earnings dates with EPS estimate, actual and surprise; dividends; splits. Read-only.',
    { symbol: SYMBOL },
  ),
  fn('get_news', 'Recent news headlines with dates and publishers. Read-only.', {
    symbol: SYMBOL,
  }),
];
