import { defineIndicator } from '../registry';

/** `arr[i - k]` (k bars back), NaN before the first bar. */
function back(arr: Float64Array, i: number, k: number): number {
  return i >= k ? arr[i - k]! : NaN;
}

/**
 * Williams Fractals test for the bar `n` back from `i`: strictly
 * beyond the `n` bars after it, and beyond `n` bars before it allowing up to
 * four directly preceding equal bars (the "frontier" flags). `beyond(a, b)` is
 * strict, `level(a, b)` the non-strict version; NaN compares false.
 */
function isFractal(
  arr: Float64Array,
  i: number,
  n: number,
  beyond: (a: number, b: number) => boolean,
  level: (a: number, b: number) => boolean,
): boolean {
  const c = back(arr, i, n);
  for (let k = 1; k <= n; k++) if (!beyond(c, back(arr, i, n - k))) return false;
  for (let eq = 0; eq <= 4; eq++) {
    let ok = true;
    for (let e = 1; e <= eq && ok; e++) ok = level(c, back(arr, i, n + e));
    for (let k = 1; k <= n && ok; k++) ok = beyond(c, back(arr, i, n + eq + k));
    if (ok) return true;
  }
  return false;
}

const gt = (a: number, b: number) => a > b;
const ge = (a: number, b: number) => a >= b;
const lt = (a: number, b: number) => a < b;
const le = (a: number, b: number) => a <= b;

/**
 * Williams Fractals (Bill Williams, 5-bar definition at the default). Confirmed
 * `periods` bars after the fractal bar and drawn back on it (offset -periods). Values: the fractal
 * bar's high (up) / low (down) on the confirming bar, NaN elsewhere.
 */
export const FRACTALS = defineIndicator({
  id: 'fractals',
  name: 'Williams Fractals',
  shortName: 'Fractals',
  category: 'trend',
  keywords: ['fractals', 'williams', 'bill williams', 'swing', 'pivot'],
  overlay: true,
  inputs: {
    periods: { kind: 'int', label: 'Periods', default: 2, min: 2, max: 500 },
  },
  outputs: [
    {
      type: 'shape',
      id: 'up',
      title: 'Up Fractal',
      shape: 'triangleUp',
      location: 'aboveBar',
      size: 'small',
      color: '#009688',
      offset: (inputs) => -inputs.periods,
    },
    {
      type: 'shape',
      id: 'down',
      title: 'Down Fractal',
      shape: 'triangleDown',
      location: 'belowBar',
      size: 'small',
      color: '#f44336',
      offset: (inputs) => -inputs.periods,
    },
  ],
  setup({ inputs }) {
    const n = inputs.periods;
    return (c) => {
      const i = c.i;
      c.set('up', isFractal(c.high, i, n, gt, ge) ? c.high[i - n]! : NaN);
      c.set('down', isFractal(c.low, i, n, lt, le) ? c.low[i - n]! : NaN);
    };
  },
});
