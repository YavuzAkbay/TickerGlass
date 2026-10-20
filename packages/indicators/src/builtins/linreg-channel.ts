import { defineIndicator } from '../registry';
import { COLOR } from './common';

const OUTPUT_IDS = ['mid', 'upper', 'lower', 'r'] as const;
type ChannelId = (typeof OUTPUT_IDS)[number];

/**
 * Linear Regression Channel (port of the common built-in): least-squares
 * line of the last `length` source values, drawn over those bars on the last
 * bar only. Upper/lower are the line +/- deviation x the residuals' sample
 * standard deviation, or, with a "use deviation" box off, the largest
 * excursion of the highs above (lows below) the line. `r` (hidden) is the common
 * "Pearson's R": the correlation of the source with the fitted line, i.e.
 * |Pearson r| of source and time. The window moves with every bar, so past
 * values repaint (the previous window is cleared where it no longer overlaps).
 */
export const LINREG_CHANNEL = defineIndicator({
  id: 'linreg-channel',
  name: 'Linear Regression Channel',
  shortName: 'LinReg',
  category: 'other',
  keywords: ['linear regression', 'regression', 'channel', 'linreg', 'pearson', 'trend'],
  overlay: true,
  repaints: true,
  inputs: {
    length: { kind: 'int', label: 'Length', default: 100, min: 1, max: 5000 },
    source: { kind: 'source', label: 'Source', default: 'close' },
    useUpperDev: {
      kind: 'bool',
      label: 'Upper Deviation',
      default: true,
      group: 'Channel Settings',
      inline: 'upper',
      hideInTitle: true,
    },
    upperDev: {
      kind: 'float',
      label: 'Upper Deviation',
      default: 2,
      min: 0,
      step: 0.1,
      group: 'Channel Settings',
      inline: 'upper',
    },
    useLowerDev: {
      kind: 'bool',
      label: 'Lower Deviation',
      default: true,
      group: 'Channel Settings',
      inline: 'lower',
      hideInTitle: true,
    },
    lowerDev: {
      kind: 'float',
      label: 'Lower Deviation',
      default: 2,
      min: 0,
      step: 0.1,
      group: 'Channel Settings',
      inline: 'lower',
    },
  },
  outputs: [
    { type: 'plot', id: 'mid', title: 'Linear Regression', kind: 'line', color: COLOR.brightRed },
    { type: 'plot', id: 'upper', title: 'Upper', kind: 'line', color: COLOR.blue },
    { type: 'plot', id: 'lower', title: 'Lower', kind: 'line', color: COLOR.blue },
    {
      type: 'fill',
      id: 'fillUpper',
      title: 'Upper Fill',
      between: ['upper', 'mid'],
      color: 'rgba(41, 98, 255, 0.15)',
    },
    {
      type: 'fill',
      id: 'fillLower',
      title: 'Lower Fill',
      between: ['mid', 'lower'],
      color: 'rgba(255, 82, 82, 0.15)',
    },
    {
      type: 'plot',
      id: 'r',
      title: "Pearson's R",
      kind: 'line',
      color: COLOR.level,
      visible: false,
      showLastValue: false,
    },
  ],
  setup({ inputs, ta }) {
    const n = inputs.length;
    // Window drawn by the last bar's previous run ([-1, -1]: none).
    const drawn = ta.vars({ from: -1, to: -1 });
    return (c) => {
      if (!c.isLast) return;
      const i = c.i;
      const src = c.src.source;
      const put = (id: ChannelId, j: number, v: number) => {
        if (j === i) c.set(id, v);
        else if (!Object.is(c.get(id, j), v)) c.setAt(id, j, v);
      };
      let start = n > 1 && i >= n - 1 ? i - n + 1 : i + 1;
      for (let j = start; j <= i; j++) if (Number.isNaN(src[j]!)) start = i + 1;
      // Clear the earlier run's window outside the new one (both end at bar i).
      for (let j = drawn.from; j >= 0 && j <= Math.min(drawn.to, start - 1); j++)
        for (const id of OUTPUT_IDS) put(id, j, NaN);
      drawn.from = -1;
      drawn.to = -1;
      if (start > i) return;

      // the common calcSlope: k = 0 is the newest bar, x = k + 1.
      let sumX = 0;
      let sumY = 0;
      let sumXSqr = 0;
      let sumXY = 0;
      for (let k = 0; k < n; k++) {
        const y = src[i - k]!;
        const x = k + 1;
        sumX += x;
        sumY += y;
        sumXSqr += x * x;
        sumXY += y * x;
      }
      const slope = (n * sumXY - sumX * sumY) / (n * sumXSqr - sumX * sumX);
      const average = sumY / n;
      // Fitted value at the newest bar; bar i - k is at intercept + slope * k.
      const intercept = average - (slope * sumX) / n + slope;

      // the common calcDev.
      const periods = n - 1;
      const meanFit = intercept + (slope * periods) / 2;
      let upDev = 0;
      let dnDev = 0;
      let ss = 0;
      let dsxx = 0;
      let dsyy = 0;
      let dsxy = 0;
      for (let k = 0; k <= periods; k++) {
        const fit = intercept + slope * k;
        upDev = Math.max(upDev, c.high[i - k]! - fit);
        dnDev = Math.max(dnDev, fit - c.low[i - k]!);
        const y = src[i - k]!;
        const dxt = y - average;
        const dyt = fit - meanFit;
        ss += (y - fit) ** 2;
        dsxx += dxt * dxt;
        dsyy += dyt * dyt;
        dsxy += dxt * dyt;
      }
      const sd = Math.sqrt(ss / periods);
      const r = dsxx === 0 || dsyy === 0 ? 0 : dsxy / Math.sqrt(dsxx * dsyy);
      const up = inputs.useUpperDev ? inputs.upperDev * sd : upDev;
      const dn = inputs.useLowerDev ? inputs.lowerDev * sd : dnDev;
      for (let k = 0; k <= periods; k++) {
        const j = i - k;
        const fit = intercept + slope * k;
        put('mid', j, fit);
        put('upper', j, fit + up);
        put('lower', j, fit - dn);
        put('r', j, r);
      }
      drawn.from = start;
      drawn.to = i;
    };
  },
});
