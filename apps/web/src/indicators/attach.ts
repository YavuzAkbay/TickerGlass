import type { Chart, DataFeed } from '@investopen/engine';
import { useAppStore } from '../store/app';
import { useUiStore } from '../store/ui';
import { toHideMode } from '../toolbar/commands';
import { toast } from '../ui/Toast';
import { findIndicator, removeIndicators } from './actions';
import { IndicatorController, createIndicatorWorker } from './controller';
import { openIndicatorSettings } from './menu';
import { effectiveInstances, useIndicatorPreview, useIndicatorStore } from './store';

type UiSnapshot = ReturnType<typeof useUiStore.getState>;

/** Left-toolbar hide button in "Hide indicators" / "Hide all" mode. */
const indicatorsHidden = (s: UiSnapshot) =>
  s.hideAll && ['indicators', 'all'].includes(toHideMode(s.groupTools.hide));

/** Run the indicator worker for `chart` and keep it in sync with the app stores. */
export function attachIndicators(chart: Chart, feed: DataFeed): () => void {
  const ctl = new IndicatorController({
    chart,
    feed,
    worker: createIndicatorWorker(),
    schedule: (fn) => requestAnimationFrame(fn),
    onError: (message) => toast(message, 'error'),
    onStudiesLost: removeIndicators,
    prepost: () => useAppStore.getState().prepost,
    chartType: () => useAppStore.getState().chartType,
  });
  ctl.setHidden(indicatorsHidden(useUiStore.getState()));
  // The chart shows settings-dialog previews too (they are not persisted).
  const sync = () => ctl.sync(effectiveInstances());
  sync();
  const offs = [
    useIndicatorStore.subscribe(sync),
    useIndicatorPreview.subscribe(sync),
    useUiStore.subscribe((s) => ctl.setHidden(indicatorsHidden(s))),
    chart.on('studyDoubleClick', (e) => {
      // Compare overlays are studies too: they have no indicator settings.
      if (findIndicator(e.id)) openIndicatorSettings(e.id);
    }),
  ];
  return () => {
    offs.forEach((off) => off());
    ctl.destroy();
  };
}
