import { defineIndicator } from '../registry';
import type { VolumeProfileDef, VolumeProfileMode } from '../types';

/**
 * Inputs shared by the Visible Range and Session Volume Profiles. The
 * "Ticks Per Row" setting needs the symbol's minimum tick, which indicators do not
 * get, so the row layout uses the engine's terms (as the volume profile
 * drawings do): a number of rows, or a row height in price units (ticks x
 * min tick).
 */
export const VP_INPUTS = {
  layout: {
    kind: 'enum',
    label: 'Row Layout',
    options: ['count', 'size'],
    optionLabels: { count: 'Number Of Rows', size: 'Price Per Row' },
    default: 'count',
  },
  rows: { kind: 'int', label: 'Number Of Rows', default: 24, min: 1, max: 1000 },
  rowSize: { kind: 'float', label: 'Price Per Row', default: 1, min: 0, hideInTitle: true },
  valueArea: { kind: 'int', label: 'Value Area Volume %', default: 70, min: 1, max: 100 },
  placement: {
    kind: 'enum',
    label: 'Placement',
    options: ['right', 'left'],
    optionLabels: { right: 'Right', left: 'Left' },
    default: 'right',
    group: 'Style',
    hideInTitle: true,
  },
  widthPercent: {
    kind: 'int',
    label: 'Width (%)',
    default: 30,
    min: 1,
    max: 100,
    group: 'Style',
    hideInTitle: true,
  },
} as const;

/** The profile output (id `vp`), settings from VP_INPUTS. */
export function profileOutput(mode: VolumeProfileMode): VolumeProfileDef<'vp', typeof VP_INPUTS> {
  return {
    type: 'volumeProfile',
    id: 'vp',
    title: 'Volume Profile',
    mode,
    rowsLayout: (inputs) => inputs.layout,
    rows: (inputs) => inputs.rows,
    rowSize: (inputs) => inputs.rowSize,
    valueArea: (inputs) => inputs.valueArea,
    widthPercent: (inputs) => inputs.widthPercent,
    placement: (inputs) => inputs.placement,
    upColor: 'rgba(41, 98, 255, 0.3)',
    downColor: 'rgba(251, 192, 45, 0.3)',
    valueAreaUpColor: 'rgba(41, 98, 255, 0.7)',
    valueAreaDownColor: 'rgba(251, 192, 45, 0.7)',
    pocColor: '#f23645',
  };
}

/**
 * Visible Range Volume Profile: one profile of the bars in view, computed and
 * drawn by the engine from the chart's bars. Nothing to compute per bar: the
 * values array stays NaN.
 */
export const VP_VISIBLE = defineIndicator({
  id: 'vp-visible',
  name: 'Visible Range Volume Profile',
  shortName: 'VRVP',
  category: 'volume',
  keywords: ['volume profile', 'vrvp', 'visible range', 'poc', 'value area', 'vp'],
  overlay: true,
  inputs: VP_INPUTS,
  outputs: [profileOutput('visible')],
  setup() {
    return () => {};
  },
});
