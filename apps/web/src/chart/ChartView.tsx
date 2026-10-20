import { useEffect, useRef } from 'react';
import { DARK_THEME, LIGHT_THEME, createChart, type Chart } from '@investopen/engine';
import { feed } from './feed';
import { attachAlerts } from '../alerts/attach';
import { attachCompares } from '../compare/attach';
import { CompareLegends } from '../compare/Legend';
import { attachDrawings } from '../drawings/attach';
import { DrawingToolbar } from '../drawings/DrawingToolbar';
import { DrawingTextEditor } from '../drawings/TextEditor';
import { attachIndicators } from '../indicators/attach';
import { IndicatorLegends } from '../indicators/Legend';
import { createSandboxWorker } from '../indicators/sandbox/port';
import type { ProbeResult } from '../indicators/sandbox/protocol';
import { attachReplay } from '../replay/attach';
import { ReplayBar } from '../replay/ReplayBar';
import { useReplayStore } from '../replay/store';
import { openChartContextMenu } from './contextMenus';
import { useAppStore } from '../store/app';
import { useChartStore } from '../store/chart';

/**
 * Dev/e2e hook: runs `code` as a user-script body in a fresh sandbox worker and
 * returns what it returned or threw. A worker that doesn't answer within
 * `timeoutMs` is terminated (`terminated: true`).
 */
function sandboxProbe(
  code: string,
  timeoutMs = 3000,
): Promise<ProbeResult & { terminated?: boolean }> {
  const w = createSandboxWorker();
  return new Promise((resolve) => {
    let result: ProbeResult | null = null;
    const done = (r: ProbeResult & { terminated?: boolean }) => {
      clearTimeout(timer);
      w.terminate();
      resolve(r);
    };
    const timer = setTimeout(
      () => done({ ok: false, error: `No response for ${timeoutMs} ms`, terminated: true }),
      timeoutMs,
    );
    w.listen(
      (m) => {
        if (m.type === 'probeResult') {
          const { type: _type, seq: _seq, ...rest } = m;
          result = rest;
        } else if (m.type === 'error') done({ ok: false, error: m.message });
        else if (m.type === 'ack') done(result ?? { ok: false, error: 'Ack without result' });
      },
      (error) => done({ ok: false, error }),
    );
    w.post({ seq: 1, msg: { type: 'probe', code } });
  });
}

/** Hosts the engine chart and keeps it in sync with the app stores. */
export function ChartView() {
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<Chart | null>(null);
  const { symbol, interval, theme, timezone, prepost, crosshair, magnet } = useAppStore();
  const { chartType, chartStyle, showPrevClose } = useAppStore();
  const chartState = useChartStore((s) => s.chart);
  const replaying = useReplayStore((s) => s.status !== 'off');

  useEffect(() => {
    const s = useAppStore.getState();
    const chart = createChart(hostRef.current!, feed, {
      theme: s.theme === 'dark' ? DARK_THEME : LIGHT_THEME,
      timezone: s.timezone,
      prepost: s.prepost,
      crosshair: s.crosshair,
      magnet: s.magnet,
      showPrevClose: s.showPrevClose,
    });
    chart.setChartStyle(s.chartStyle);
    chart.setChartType(s.chartType);
    chartRef.current = chart;
    useChartStore.setState({ chart });
    // Expose for debugging and e2e tests.
    (window as unknown as { chart?: Chart }).chart = chart;
    if (import.meta.env.DEV || import.meta.env.VITE_E2E === '1') {
      (window as unknown as { sandboxProbe?: typeof sandboxProbe }).sandboxProbe = sandboxProbe;
    }
    const offs = [
      chart.on('symbolResolved', (info) => useChartStore.setState({ symbolInfo: info })),
      chart.on('crosshairMove', (c) => useChartStore.setState({ crosshair: c })),
      chart.on('loading', (loading) => useChartStore.setState({ loading })),
      chart.on('contextMenu', (p) => openChartContextMenu(chart, p)),
      // Drawings first: a pane removal folds their undo step with the studies'.
      attachDrawings(chart, hostRef.current!),
      attachIndicators(chart, feed),
      attachCompares(chart, feed),
      attachAlerts(chart),
      attachReplay(chart),
    ];
    return () => {
      offs.forEach((off) => off());
      useChartStore.setState({ chart: null });
      chart.destroy();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    void chartRef.current?.setSymbolAndInterval(symbol, interval);
  }, [symbol, interval]);

  useEffect(() => {
    chartRef.current?.applyOptions({
      theme: theme === 'dark' ? DARK_THEME : LIGHT_THEME,
      timezone,
      prepost,
      crosshair,
      magnet,
    });
  }, [theme, timezone, prepost, crosshair, magnet]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.setChartStyle(chartStyle);
    chart.setChartType(chartType);
    chart.applyOptions({ showPrevClose });
  }, [chartType, chartStyle, showPrevClose]);

  return (
    <>
      <div ref={hostRef} className="chart-host" />
      <CompareLegends chart={chartState} />
      <IndicatorLegends chart={chartState} />
      <DrawingToolbar />
      <DrawingTextEditor />
      {replaying ? <ReplayBar /> : null}
    </>
  );
}
