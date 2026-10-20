import { getChart } from '../store/chart';
import { useAppStore } from '../store/app';

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

// Interval pairing for each bottom-bar range.
export const RANGE_PRESETS: RangePreset[] = [
  { label: '1D', title: '1 day in 1 minute intervals', interval: '1m', from: (l) => l - DAY },
  { label: '5D', title: '5 days in 5 minute intervals', interval: '5m', from: (l) => l - 5 * DAY },
  {
    label: '1M',
    title: '1 month in 30 minute intervals',
    interval: '30m',
    from: (l) => monthsBack(l, 1),
  },
  {
    label: '3M',
    title: '3 months in 1 hour intervals',
    interval: '1h',
    from: (l) => monthsBack(l, 3),
  },
  {
    label: '6M',
    title: '6 months in 2 hour intervals',
    interval: '2h',
    from: (l) => monthsBack(l, 6),
  },
  {
    label: 'YTD',
    title: 'Year to date in 1 day intervals',
    interval: '1D',
    from: (l) => Date.UTC(new Date(l * 1000).getUTCFullYear(), 0, 1) / 1000,
  },
  {
    label: '1Y',
    title: '1 year in 1 day intervals',
    interval: '1D',
    from: (l) => monthsBack(l, 12),
  },
  {
    label: '5Y',
    title: '5 years in 1 week intervals',
    interval: '1W',
    from: (l) => monthsBack(l, 60),
  },
  { label: 'All', title: 'All data in 1 month intervals', interval: '1M', from: null },
];

export async function applyRangePreset(preset: RangePreset): Promise<void> {
  const chart = getChart();
  if (!chart) return;
  const { symbol, setInterval } = useAppStore.getState();
  // Load first, then sync the store (the chart treats the repeat as a no-op).
  const loading = chart.setSymbolAndInterval(symbol, preset.interval);
  setInterval(preset.interval);
  await loading;
  const n = chart.store.length;
  if (!n) return;
  if (preset.from === null) await chart.showAllHistory();
  else await chart.setVisibleTimeRange(preset.from(chart.store.time[n - 1]!));
}
