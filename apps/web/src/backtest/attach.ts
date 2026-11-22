import type { ChartSession } from '../chart/session';
import { BACKTEST_MARKER_GROUP } from './run';
import { useBacktestRun } from './store';

/**
 * Trade markers belong to the symbol and interval a run used: a chart that
 * loads anything else drops them (the report stays, flagged as stale).
 */
export function attachBacktest(session: Pick<ChartSession, 'chart'>): () => void {
  const { chart } = session;
  return chart.on('dataLoaded', () => {
    const run = useBacktestRun.getState().run;
    if (!run || run.symbol !== chart.getSymbol() || run.interval !== chart.getInterval())
      chart.setMarkers(BACKTEST_MARKER_GROUP, []);
  });
}
