import { defineIndicator } from '../registry';
import { COLOR } from './common';

const WEEK = 7 * 86_400;

/**
 * 52 Week High/Low: highest high and lowest low of the bars that opened less
 * than `weeks` weeks before the current bar (partial windows from the first
 * bar). Computed on daily bars by default (the host runs it on chart bars at
 * 1D and above); with "Wait for timeframe closes" every chart bar shows the
 * value as of the last closed day.
 *
 * The window is by time, so its bar count varies; the max/min come from
 * "previous greater/smaller bar" links (bar-aligned, so re-running the last
 * bar only rewrites its own slot): walking the links from the current bar to
 * the oldest one still inside the window ends at the window's extreme.
 */
export const HIGH_LOW_52W = defineIndicator({
  id: 'high-low-52w',
  name: '52 Week High/Low',
  shortName: '52W H/L',
  category: 'other',
  keywords: ['52 week', '52w', 'high', 'low', 'year', 'annual', 'range'],
  overlay: true,
  inputs: {
    weeks: { kind: 'int', label: 'Weeks', default: 52, min: 1, max: 520 },
    timeframe: {
      kind: 'timeframe',
      label: 'Timeframe',
      default: '1D',
      waitForCloseInput: 'waitForClose',
    },
    waitForClose: {
      kind: 'bool',
      label: 'Wait for timeframe closes',
      default: true,
      hideInTitle: true,
    },
  },
  outputs: [
    { type: 'plot', id: 'hi', title: 'High', kind: 'step', color: COLOR.green },
    { type: 'plot', id: 'lo', title: 'Low', kind: 'step', color: COLOR.brightRed },
  ],
  setup({ inputs, ta }) {
    const span = inputs.weeks * WEEK;
    // First bar inside the window (only ever moves forward).
    const s = ta.vars({ start: 0 });
    // Index of the nearest earlier bar with a higher high / lower low (-1: none).
    const higher = ta.series();
    const lower = ta.series();
    return (c) => {
      const { i, time, high, low } = c;
      const cutoff = time[i]! - span;
      while (s.start < i && time[s.start]! <= cutoff) s.start++;
      let j = i - 1;
      while (j >= 0 && high[j]! <= high[i]!) j = higher.get(j);
      higher.set(i, j);
      j = i - 1;
      while (j >= 0 && low[j]! >= low[i]!) j = lower.get(j);
      lower.set(i, j);
      let k = i;
      while (higher.get(k) >= s.start) k = higher.get(k);
      c.set('hi', high[k]!);
      k = i;
      while (lower.get(k) >= s.start) k = lower.get(k);
      c.set('lo', low[k]!);
    };
  },
});
