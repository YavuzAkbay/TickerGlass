import { useEffect } from 'react';
import { BottomBar } from './bottombar/BottomBar';
import { ChartView } from './chart/ChartView';
import { registerCoreCommands } from './commands/core';
import { registerDrawingCommands } from './drawings/commands';
import { registerIndicatorCommands } from './indicators/commands';
import { registerReplayCommands } from './replay/commands';
import { installShortcuts } from './commands/shortcuts';
import { registerWatchlistCommands } from './watchlist/commands';
import { startPersistence } from './persist/bootstrap';
import { registerLayoutCommands } from './persist/commands';
import { DialogHost } from './dialogs/DialogHost';
import { RightSidebar } from './sidebar/RightSidebar';
import { useAppStore } from './store/app';
import { useUiStore } from './store/ui';
import { LeftToolbar } from './toolbar/LeftToolbar';
import { TopBar } from './topbar/TopBar';
import { ContextMenuHost } from './ui/ContextMenu';
import { PromptHost } from './ui/Prompt';
import { ToastHost } from './ui/Toast';
import './ui/ui.css';
import './App.css';

export function App() {
  const theme = useAppStore((s) => s.theme);

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
    // Digits open the interval input, anything else symbol search .
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
      <aside className="app-left">
        <LeftToolbar />
      </aside>
      <main className="center">
        <div className="chart-area">
          <ChartView />
        </div>
        <BottomBar />
      </main>
      <aside className="app-right">
        <RightSidebar />
      </aside>
      <DialogHost />
      <ContextMenuHost />
      <PromptHost />
      <ToastHost />
    </div>
  );
}
