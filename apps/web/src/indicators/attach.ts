import type { DataFeed } from '@tickerglass/engine';
import { replayFeed } from '../chart/feed';
import { fetchEvents } from '../events/api';
import { syncScriptDefinitions } from '../scripts/definitions';
import { useScriptsStore } from '../scripts/store';
import { computeTimesOf, perfEnabled } from '../chart/perf';
import type { ChartSession } from '../chart/session';
import { runInSession, scopedOn } from '../store/chart';
import { useUiStore } from '../store/ui';
import { toHideMode } from '../toolbar/commands';
import { toast } from '../ui/Toast';
import { findIndicator, removeIndicators } from './actions';
import { IndicatorController, createIndicatorWorker } from './controller';
import { openIndicatorSettings } from './menu';
import { ScriptRouterPort } from './sandbox/port';
import { effectiveInstancesOf } from './store';

type UiSnapshot = ReturnType<typeof useUiStore.getState>;

/** Left-toolbar hide button in "Hide indicators" / "Hide all" mode. */
const indicatorsHidden = (s: UiSnapshot) =>
  s.hideAll && ['indicators', 'all'].includes(toHideMode(s.groupTools.hide));

/** Run the indicator worker for `chart` and keep it in sync with the app stores. */
export function attachIndicators(session: ChartSession, feed: DataFeed): () => void {
  const { chart } = session;
  // User scripts run in their own sandboxes behind this port.
  const port = new ScriptRouterPort(createIndicatorWorker(), {
    getScript: (id) => useScriptsStore.getState().scripts.find((s) => s.id === id),
  });
  const ctl = new IndicatorController({
    chart,
    feed,
    worker: port,
    schedule: (fn) => requestAnimationFrame(fn),
    onError: (message) => toast(message, 'error'),
    onStudiesLost: (ids) => runInSession(session.id, () => removeIndicators(ids)),
    runtime: session.indicatorRuntime,
    prepost: () => session.view.getState().prepost,
    chartType: () => session.view.getState().chartType,
    dataEpoch: () => replayFeed.epoch,
    loadEvents: fetchEvents,
    profile: perfEnabled(),
    onComputeTime: (ms) => computeTimesOf(session.id).record(ms),
  });
  ctl.setHidden(indicatorsHidden(useUiStore.getState()));
  // The chart shows settings-dialog previews too (they are not persisted).
  const sync = () => ctl.sync(effectiveInstancesOf(session.indicators, session.preview));
  // Script stubs first (the controller looks definitions up), then the new
  // definitions applied (outputs, titles), then the sandboxes restarted.
  const syncScripts = () => {
    const changed = syncScriptDefinitions(useScriptsStore.getState().scripts);
    sync();
    for (const id of changed) port.reloadScript(id);
  };
  syncScripts();
  const offs = [
    useScriptsStore.subscribe(syncScripts),
    session.indicators.subscribe(sync),
    session.preview.subscribe(sync),
    useUiStore.subscribe((s) => ctl.setHidden(indicatorsHidden(s))),
    scopedOn(session)('studyDoubleClick', (e) => {
      // Compare overlays are studies too: they have no indicator settings.
      if (findIndicator(e.id)) openIndicatorSettings(e.id);
    }),
  ];
  return () => {
    offs.forEach((off) => off());
    ctl.destroy();
  };
}
