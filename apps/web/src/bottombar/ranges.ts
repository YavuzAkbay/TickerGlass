import { activeChartId, syncBus } from '../layout/sync';
import { getChart } from '../store/chart';
import { useChartView } from '../store/chartView';

export interface RangePreset {
  label: string;
  title: string;
  interval: string;
  /** Start of the range given the last bar time (unix s). null = all history. */
  from: ((last: number) => number) | null;
}

const DAY = 86_400;

function monthsBack(last: number, months: number): number {
  const d = new Date(last * 1000);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.getTime() / 1000;
}

// Interval pairing for each bottom-bar range (default list: 1D .. Max).
export const RANGE_PRESETS: RangePreset[] = [
  { label: '1D', title: '1 day in 1 minute intervals', interval: '1m', from: (l) => l - DAY },
  {
    label: '1W',
    title: '1 week in 15 minute intervals',
    interval: '15m',
    from: (l) => l - 7 * DAY,
  },
  {
    label: '1M',
    title: '1 month in 1 hour intervals',
    interval: '1h',
    from: (l) => monthsBack(l, 1),
  },
  {
    label: '3M',
    title: '3 months in 4 hour intervals',
    interval: '4h',
    from: (l) => monthsBack(l, 3),
  },
  {
    label: '1Y',
    title: '1 year in 1 day intervals',
    interval: '1D',
    from: (l) => monthsBack(l, 12),
  },
  {
    label: '3Y',
    title: '3 years in 1 week intervals',
    interval: '1W',
    from: (l) => monthsBack(l, 36),
  },
  { label: 'Max', title: 'All data in 1 month intervals', interval: '1M', from: null },
];

export async function applyRangePreset(preset: RangePreset): Promise<void> {
  const chart = getChart();
  if (!chart) return;
  const { symbol, setInterval } = useChartView.getState();
  // Load first, then sync the store (the chart treats the repeat as a no-op).
  const loading = chart.setSymbolAndInterval(symbol, preset.interval);
  setInterval(preset.interval);
  await loading;
  const n = chart.store.length;
  if (!n) return;
  const from = activeChartId();
  if (from === null) return;
  // The range is worked out on this chart's data; with date-range sync the others show the same dates.
  if (preset.from === null) await syncBus.range(from, 'all');
  else await syncBus.range(from, { from: preset.from(chart.store.time[n - 1]!), to: Infinity });
}
