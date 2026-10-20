import { useEffect, useState } from 'react';
import { RangeStrip } from './bottombar/RangeStrip';
import { ChartView } from './chart/ChartView';
import { PRIMARY_CHART_ID } from './chart/session';
import { registerCoreCommands } from './commands/core';
import { registerDrawingCommands } from './drawings/commands';
import { registerIndicatorCommands } from './indicators/commands';
import { registerReplayCommands } from './replay/commands';
import { installShortcuts } from './commands/shortcuts';
import { registerWatchlistCommands } from './watchlist/commands';
import { startPersistence } from './persist/bootstrap';
import { registerLayoutCommands } from './persist/commands';
import { DialogHost } from './dialogs/DialogHost';
import { Dock } from './dock/Dock';
import { useAppStore } from './store/app';
import { useUiStore } from './store/ui';
import { ToolRail } from './toolbar/ToolRail';
import { TopBar } from './topbar/TopBar';
import { ContextMenuHost } from './ui/ContextMenu';
import { PromptHost } from './ui/Prompt';
import { ToastHost } from './ui/Toast';
import './ui/ui.css';
import './App.css';

/**
 * Chart ids to mount. One chart; `?charts=N` (dev/e2e, 2..4) stacks N sessions
 * until the grid layouts exist.
 */
function chartIds(): string[] {
  const n = Number(new URLSearchParams(location.search).get('charts'));
  const count = Number.isInteger(n) && n >= 2 ? Math.min(n, 4) : 1;
  return Array.from({ length: count }, (_, i) => (i === 0 ? PRIMARY_CHART_ID : `c${i + 1}`));
}

export function App() {
  const theme = useAppStore((s) => s.theme);
  const railHidden = useUiStore((s) => s.toolRailHidden);
  const [ids] = useState(chartIds);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    const unregister = registerCoreCommands();
    const unregisterIndicators = registerIndicatorCommands();
    const unregisterDrawings = registerDrawingCommands();
    const unregisterLayouts = registerLayoutCommands();
    const unregisterWatchlist = registerWatchlistCommands();
    const unregisterReplay = registerReplayCommands();
    // Digits open the interval input, anything else symbol search.
    const uninstall = installShortcuts((initial) =>
      useUiStore
        .getState()
        .openDialog(/\d/.test(initial) ? 'intervalInput' : 'symbolSearch', { initial }),
    );
    return () => {
      unregister();
      unregisterIndicators();
      unregisterDrawings();
      unregisterLayouts();
      unregisterWatchlist();
      unregisterReplay();
      uninstall();
    };
  }, []);

  // After the chart mounted (child effects run first): restore the last layout.
  useEffect(() => startPersistence(), []);

  return (
    <div className="app">
      <header className="app-top">
        <TopBar />
      </header>
      <main className="center">
        <div className="chart-pane">
          <div className="chart-area">
            <div className="chart-stack">
              {ids.map((id) => (
                <ChartView key={id} id={id} />
              ))}
            </div>
          </div>
          <RangeStrip />
        </div>
        <Dock />
      </main>
      <aside className={`app-rail${railHidden ? ' collapsed' : ''}`} inert={railHidden}>
        <ToolRail />
      </aside>
      <DialogHost />
      <ContextMenuHost />
      <PromptHost />
      <ToastHost />
    </div>
  );
}
