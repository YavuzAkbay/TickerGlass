import type { StepContext } from '../types';

/** Running sums of one VWAP period (stored in `ta.vars`). */
export interface VwapSums extends Record<string, number> {
  /** sum(src * volume) */
  sv: number;
  /** sum(volume) */
  v: number;
  /** sum(src^2 * volume) */
  ssv: number;
  /** Volume-weighted standard deviation of the last update. */
  sd: number;
}

export const VWAP_SUMS: VwapSums = { sv: NaN, v: NaN, ssv: NaN, sd: NaN };

/**
 * VWAP: accumulate (resetting on a new period) and
 * return the VWAP; `st.sd` gets sqrt(max(E[src^2] - vwap^2, 0)). NaN inputs
 * leave the sums unchanged.
 */
export function vwapUpdate(st: VwapSums, isNew: boolean, x: number, vol: number): number {
  if (Number.isNaN(x) || Number.isNaN(vol)) {
    st.sd = NaN;
    return NaN;
  }
  if (isNew || Number.isNaN(st.v)) {
    st.sv = x * vol;
    st.v = vol;
    st.ssv = x * x * vol;
  } else {
    st.sv += x * vol;
    st.v += vol;
    st.ssv += x * x * vol;
  }
  const vwap = st.sv / st.v;
  st.sd = Math.sqrt(Math.max(st.ssv / st.v - vwap * vwap, 0));
  return vwap;
}

export const BAND_MODES = ['Standard Deviation', 'Percentage'] as const;

/** Band inputs shared by VWAP and Anchored VWAP. */
export function bandInputs(showFirst: boolean) {
  const group = 'Bands Settings';
  return {
    bandMode: {
      kind: 'enum',
      label: 'Bands Calculation Mode',
      options: BAND_MODES,
      default: 'Standard Deviation',
      group,
      hideInTitle: true,
    },
    showBand1: {
      kind: 'bool',
      label: 'Bands Multiplier #1',
      default: showFirst,
      group,
      inline: 'band1',
      hideInTitle: true,
    },
    mult1: {
      kind: 'float',
      label: 'Multiplier #1',
      default: 1,
      min: 0,
      step: 0.5,
      group,
      inline: 'band1',
      hideInTitle: true,
    },
    showBand2: {
      kind: 'bool',
      label: 'Bands Multiplier #2',
      default: false,
      group,
      inline: 'band2',
      hideInTitle: true,
    },
    mult2: {
      kind: 'float',
      label: 'Multiplier #2',
      default: 2,
      min: 0,
      step: 0.5,
      group,
      inline: 'band2',
      hideInTitle: true,
    },
    showBand3: {
      kind: 'bool',
      label: 'Bands Multiplier #3',
      default: false,
      group,
      inline: 'band3',
      hideInTitle: true,
    },
    mult3: {
      kind: 'float',
      label: 'Multiplier #3',
      default: 3,
      min: 0,
      step: 0.5,
      group,
      inline: 'band3',
      hideInTitle: true,
    },
  } as const;
}

/** Band plots and fills shared by VWAP and Anchored VWAP (drawn after the VWAP line). */
export const BAND_OUTPUTS = [
  { type: 'plot', id: 'upper1', title: 'Upper Band #1', kind: 'line', color: '#8bc34a' },
  { type: 'plot', id: 'lower1', title: 'Lower Band #1', kind: 'line', color: '#8bc34a' },
  {
    type: 'fill',
    id: 'fill1',
    title: 'Bands Fill #1',
    between: ['upper1', 'lower1'],
    color: 'rgba(139, 195, 74, 0.05)',
  },
  { type: 'plot', id: 'upper2', title: 'Upper Band #2', kind: 'line', color: '#7a8a99' },
  { type: 'plot', id: 'lower2', title: 'Lower Band #2', kind: 'line', color: '#7a8a99' },
  {
    type: 'fill',
    id: 'fill2',
    title: 'Bands Fill #2',
    between: ['upper2', 'lower2'],
    color: 'rgba(122, 138, 153, 0.05)',
  },
  { type: 'plot', id: 'upper3', title: 'Upper Band #3', kind: 'line', color: '#0fb5c9' },
  { type: 'plot', id: 'lower3', title: 'Lower Band #3', kind: 'line', color: '#0fb5c9' },
  {
    type: 'fill',
    id: 'fill3',
    title: 'Bands Fill #3',
    between: ['upper3', 'lower3'],
    color: 'rgba(15, 181, 201, 0.05)',
  },
] as const;

type BandId = 'upper1' | 'lower1' | 'upper2' | 'lower2' | 'upper3' | 'lower3';

interface BandSettings {
  bandMode: (typeof BAND_MODES)[number];
  showBand1: boolean;
  mult1: number;
  showBand2: boolean;
  mult2: number;
  showBand3: boolean;
  mult3: number;
}

/** VWAP bands: vwap +- mult * (stdev or 1% of vwap). Hidden bands stay NaN. */
export function setBands(
  c: Pick<StepContext<never, BandId>, 'set'>,
  s: BandSettings,
  vwap: number,
  sd: number,
): void {
  const basis = s.bandMode === 'Standard Deviation' ? sd : vwap * 0.01;
  if (s.showBand1) {
    c.set('upper1', vwap + basis * s.mult1);
    c.set('lower1', vwap - basis * s.mult1);
  }
  if (s.showBand2) {
    c.set('upper2', vwap + basis * s.mult2);
    c.set('lower2', vwap - basis * s.mult2);
  }
  if (s.showBand3) {
    c.set('upper3', vwap + basis * s.mult3);
    c.set('lower3', vwap - basis * s.mult3);
  }
}
