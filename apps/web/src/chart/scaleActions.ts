import type { Chart, PriceScaleMode } from '@investopen/engine';
import { useHistory } from '../commands/history';

type ScaleState = { mode: PriceScaleMode; autoScale: boolean; invert: boolean };

function read(chart: Chart, paneId: string): ScaleState | null {
  const ps = chart.getState().panes.find((p) => p.id === paneId)?.priceScale;
  return ps ? { mode: ps.mode, autoScale: ps.autoScale, invert: ps.invert } : null;
}

function write(chart: Chart, paneId: string, s: ScaleState): void {
  chart.setPriceScaleMode(paneId, s.mode);
  chart.setInvertScale(paneId, s.invert);
  chart.setAutoScale(paneId, s.autoScale);
}

/** Apply a price-scale change and record it for undo. */
export function changeScale(
  chart: Chart,
  paneId: string,
  patch: Partial<ScaleState>,
  label: string,
) {
  const before = read(chart, paneId);
  if (!before) return;
  const after = { ...before, ...patch };
  write(chart, paneId, after);
  useHistory.getState().push({
    label,
    undo: () => write(chart, paneId, before),
    redo: () => write(chart, paneId, after),
  });
}

export function toggleScaleMode(chart: Chart, paneId: string, mode: PriceScaleMode) {
  const cur = read(chart, paneId);
  if (!cur) return;
  changeScale(
    chart,
    paneId,
    { mode: cur.mode === mode ? 'linear' : mode, autoScale: true },
    `Scale: ${mode}`,
  );
}
