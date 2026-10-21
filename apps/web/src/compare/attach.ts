import type { ChartState, DataFeed, PriceScaleMode } from '@tickerglass/engine';
import { replayFeed } from '../chart/feed';
import type { ChartSession } from '../chart/session';
import { runInSession, scopedOn } from '../store/chart';
import { toast } from '../ui/Toast';
import { onMainScaleMode, removeCompares } from './actions';
import { CompareController } from './controller';

const mainMode = (s: ChartState): PriceScaleMode | null =>
  s.panes.find((p) => p.id === 'main')?.priceScale.mode ?? null;

/** Run compare overlays for `chart` and keep them in sync with the compare store. */
export function attachCompares(session: ChartSession, feed: DataFeed): () => void {
  const { chart } = session;
  const ctl = new CompareController({
    chart,
    feed,
    schedule: (fn) => requestAnimationFrame(fn),
    onError: (message) => toast(message, 'error'),
    onLost: (ids) => runInSession(session.id, () => removeCompares(ids)),
    runtime: session.compareRuntime,
    prepost: () => session.view.getState().prepost,
    chartType: () => session.view.getState().chartType,
    dataEpoch: () => replayFeed.epoch,
  });
  ctl.sync(session.compares.getState().items);
  let mode = mainMode(chart.getState());
  const offs = [
    session.compares.subscribe((s, p) => {
      if (s.items !== p.items) ctl.sync(s.items);
    }),
    scopedOn(session)('stateChange', (s) => {
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
