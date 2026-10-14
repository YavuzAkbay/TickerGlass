import type { Chart, ChartState, DataFeed, PriceScaleMode } from '@investopen/engine';
import { useAppStore } from '../store/app';
import { toast } from '../ui/Toast';
import { onMainScaleMode, removeCompares } from './actions';
import { CompareController } from './controller';
import { useCompareStore } from './store';

const mainMode = (s: ChartState): PriceScaleMode | null =>
  s.panes.find((p) => p.id === 'main')?.priceScale.mode ?? null;

/** Run compare overlays for `chart` and keep them in sync with the compare store. */
export function attachCompares(chart: Chart, feed: DataFeed): () => void {
  const ctl = new CompareController({
    chart,
    feed,
    schedule: (fn) => requestAnimationFrame(fn),
    onError: (message) => toast(message, 'error'),
    onLost: removeCompares,
    prepost: () => useAppStore.getState().prepost,
    chartType: () => useAppStore.getState().chartType,
  });
  ctl.sync(useCompareStore.getState().items);
  let mode = mainMode(chart.getState());
  const offs = [
    useCompareStore.subscribe((s, p) => {
      if (s.items !== p.items) ctl.sync(s.items);
    }),
    chart.on('stateChange', (s) => {
      const next = mainMode(s);
      const prev = mode;
      mode = next;
      if (prev !== next) onMainScaleMode(prev, next);
    }),
  ];
  return () => {
    offs.forEach((off) => off());
    ctl.destroy();
  };
}
