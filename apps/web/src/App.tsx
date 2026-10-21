import { useEffect } from 'react';
import { SymbolHeader } from './center/SymbolHeader';
import { RangeStrip } from './bottombar/RangeStrip';
import { ChartGrid } from './layout/ChartGrid';
import { registerGridCommands } from './layout/commands';
import { registerCoreCommands } from './commands/core';
import { registerDrawingCommands } from './drawings/commands';
import { registerIndicatorCommands } from './indicators/commands';
import { registerReplayCommands } from './replay/commands';
import { installShortcuts } from './commands/shortcuts';
import { registerWatchlistCommands } from './watchlist/commands';
import { startPersistence } from './persist/bootstrap';
import { registerLayoutCommands } from './persist/commands';
import { DialogHost } from './dialogs/DialogHost';
import { Navigator } from './navigator/Navigator';
import { useAppStore } from './store/app';
import { useUiStore } from './store/ui';
import { ToolRail } from './toolbar/ToolRail';
import { TopBar } from './topbar/TopBar';
import { ContextMenuHost } from './ui/ContextMenu';
import { PromptHost } from './ui/Prompt';
import { ToastHost } from './ui/Toast';
import './ui/ui.css';
import './App.css';

export function App() {
  const theme = useAppStore((s) => s.theme);
  const railHidden = useUiStore((s) => s.toolRailHidden);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    const unregister = registerCoreCommands();
    const unregisterIndicators = registerIndicatorCommands();
    const unregisterDrawings = registerDrawingCommands();
    const unregisterLayouts = registerLayoutCommands();
    const unregisterGrid = registerGridCommands();
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
      unregisterGrid();
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
      <Navigator />
      <main className="center">
        <SymbolHeader />
        <div className="chart-pane">
          <div className="chart-area">
            <ChartGrid />
          </div>
          <RangeStrip />
        </div>
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
