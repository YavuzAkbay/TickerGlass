import { useEffect } from 'react';
import { ChartGrid } from './layout/ChartGrid';
import { registerGridCommands } from './layout/commands';
import { registerCoreCommands } from './commands/core';
import { registerDrawingCommands } from './drawings/commands';
import { registerIndicatorCommands } from './indicators/commands';
import { registerReplayCommands } from './replay/commands';
import { installShortcuts } from './commands/shortcuts';
import { registerWatchlistCommands } from './watchlist/commands';
import { startPersistence } from './persist/bootstrap';
import { startFirstRun } from './setup/firstRun';
import { registerLayoutCommands } from './persist/commands';
import { DialogHost } from './dialogs/DialogHost';
import { Inspector } from './inspector/Inspector';
import { Navigator } from './navigator/Navigator';
import { useAppStore } from './store/app';
import { useUiStore } from './store/ui';
import { QuickTools, ToolRail } from './toolbar/ToolRail';
import { TopBar } from './topbar/TopBar';
import { ContextMenuHost } from './ui/ContextMenu';
import { PromptHost } from './ui/Prompt';
import { ToastHost } from './ui/Toast';
import { MOBILE_QUERY, useIsMobile } from './ui/useMediaQuery';
import './ui/ui.css';
import './App.css';

export function App() {
  const theme = useAppStore((s) => s.theme);
  const mobile = useIsMobile();
  // Phones show the drawing tools as a strip over the chart, toggled from the bottom bar.
  const railHidden = useUiStore((s) => (mobile ? !s.mobileToolsOpen : s.toolRailHidden));
  const inspectorOpen = useUiStore((s) => s.inspector !== null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    // Browser chrome (mobile status bar / address bar) matches the panels.
    const color = getComputedStyle(document.documentElement).getPropertyValue('--panel').trim();
    if (color) document.querySelector('meta[name="theme-color"]')?.setAttribute('content', color);
  }, [theme]);

  // Phones: the Navigator and Inspector are both sheets over the chart; opening one closes the other.
  useEffect(
    () =>
      useUiStore.subscribe((s, prev) => {
        if (!window.matchMedia(MOBILE_QUERY).matches) return;
        if (s.navSheet && !prev.navSheet && s.inspector) s.closeInspector();
        else if (s.inspector && !prev.inspector && s.navSheet) s.set({ navSheet: false });
      }),
    [],
  );

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
  // First visit: which data source this instance runs on, and whether it answers.
  useEffect(() => startFirstRun(), []);

  return (
    <div className={`app${inspectorOpen ? '' : ' no-inspector'}`}>
      <header className="app-top">
        <TopBar />
      </header>
      <Navigator />
      <main className="center">
        <div className="chart-pane">
          <div className="chart-area">
            <ChartGrid />
          </div>
        </div>
      </main>
      <Inspector />
      <aside className={`app-rail${railHidden ? ' collapsed' : ''}`} inert={railHidden}>
        <ToolRail />
      </aside>
      <QuickTools />
      <DialogHost />
      <ContextMenuHost />
      <PromptHost />
      <ToastHost />
    </div>
  );
}
