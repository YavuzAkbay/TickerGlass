import { useEffect, useRef, useState } from 'react';
import { DARK_THEME, LIGHT_THEME } from '@investopen/engine';
import { feed } from './feed';
import { PRIMARY_CHART_ID, createChartSession, type ChartSession } from './session';
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
import { legacyChartView, useAppStore } from '../store/app';
import {
  getActiveSession,
  registerSession,
  setActiveChart,
  unregisterSession,
  useChartStore,
} from '../store/chart';
import { pickChartView } from '../store/chartView';

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

/**
 * One chart of the layout: hosts the engine chart for session `id`, keeps it in
 * sync with the session's view and the app preferences, and renders its legends.
 * Pointer focus makes it the active chart.
 */
export function ChartView({ id }: { id: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [session, setSession] = useState<ChartSession | null>(null);
  const theme = useAppStore((s) => s.theme);
  const crosshair = useAppStore((s) => s.crosshair);
  const magnet = useAppStore((s) => s.magnet);
  const active = useChartStore((s) => s.activeId === id);
  const multi = useChartStore((s) => s.sessions.size > 1);
  const replaying = useReplayStore((s) => s.status !== 'off');

  useEffect(() => {
    // The first chart starts from the pre-v4 app store values (if any), others from the active chart.
    const current = getActiveSession();
    const initial = current
      ? pickChartView(current.view.getState())
      : id === PRIMARY_CHART_ID
        ? legacyChartView()
        : null;
    const s = createChartSession(id, hostRef.current!, initial);
    const { chart } = s;
    registerSession(s);
    setSession(s);
    // Expose for debugging and e2e tests (the active chart; see the focus handler).
    (window as unknown as { chart?: unknown }).chart = chart;
    if (import.meta.env.DEV || import.meta.env.VITE_E2E === '1') {
      (window as unknown as { sandboxProbe?: typeof sandboxProbe }).sandboxProbe = sandboxProbe;
    }
    const offs = [
      chart.on('symbolResolved', (symbolInfo) => s.info.setState({ symbolInfo })),
      chart.on('crosshairMove', (c) => s.info.setState({ crosshair: c })),
      chart.on('loading', (loading) => s.info.setState({ loading })),
      chart.on('contextMenu', (p) => openChartContextMenu(chart, p)),
      // Drawings first: a pane removal folds their undo step with the studies'.
      attachDrawings(s, hostRef.current!),
      attachIndicators(s, feed),
      attachCompares(s, feed),
      attachAlerts(s),
      attachReplay(s),
    ];
    return () => {
      offs.forEach((off) => off());
      unregisterSession(id);
      setSession(null);
      s.destroy();
    };
  }, [id]);

  // `window.chart` follows the active chart.
  useEffect(() => {
    if (active && session) (window as unknown as { chart?: unknown }).chart = session.chart;
  }, [active, session]);

  useEffect(() => {
    if (!session) return;
    const { chart, view } = session;
    // Like a React effect, after the code that set the view (a layout apply sets
    // the view, then the engine state) has run; one load for any number of changes.
    let queued = false;
    const apply = () => {
      if (queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        const { symbol, interval } = view.getState();
        void chart.setSymbolAndInterval(symbol, interval);
      });
    };
    apply();
    let prev = view.getState();
    const off = view.subscribe((v) => {
      if (v.symbol !== prev.symbol || v.interval !== prev.interval) apply();
      if (v.chartStyle !== prev.chartStyle || v.chartType !== prev.chartType) {
        chart.setChartStyle(v.chartStyle);
        chart.setChartType(v.chartType);
      }
      if (
        v.timezone !== prev.timezone ||
        v.prepost !== prev.prepost ||
        v.showPrevClose !== prev.showPrevClose
      )
        chart.applyOptions({
          timezone: v.timezone,
          prepost: v.prepost,
          showPrevClose: v.showPrevClose,
        });
      prev = v;
    });
    return off;
  }, [session]);

  useEffect(() => {
    session?.chart.applyOptions({
      theme: theme === 'dark' ? DARK_THEME : LIGHT_THEME,
      crosshair,
      magnet,
    });
  }, [session, theme, crosshair, magnet]);

  return (
    <div
      className={`chart-cell${multi ? ' multi' : ''}${multi && active ? ' active' : ''}`}
      data-chart-id={id}
      onPointerDownCapture={() => setActiveChart(id)}
    >
      <div ref={hostRef} className="chart-host" />
      {session ? <CompareLegends session={session} /> : null}
      {session ? <IndicatorLegends session={session} /> : null}
      {active ? (
        <>
          <DrawingToolbar />
          <DrawingTextEditor />
          {replaying ? <ReplayBar /> : null}
        </>
      ) : null}
    </div>
  );
}
