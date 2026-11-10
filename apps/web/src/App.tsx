import { Suspense, useEffect, useRef } from 'react';
import { ChartGrid } from './layout/ChartGrid';
import { registerGridCommands } from './layout/commands';
import { registerCoreCommands } from './commands/core';
import { registerDrawingCommands } from './drawings/commands';
import { registerIndicatorCommands } from './indicators/commands';
import { registerReplayCommands } from './replay/commands';
import { installShortcuts } from './commands/shortcuts';
import { registerWatchlistCommands } from './watchlist/commands';
import { registerNotesCommands } from './notes/commands';
import { registerScreenerCommands } from './screener/commands';
import { startPersistence } from './persist/bootstrap';
import { loadProvider, refreshUsage, resetProviderStore, useProviderStore } from './api/provider';
import { getQuoteStream } from './quotes/stream';
import { startFirstRun } from './setup/firstRun';
import { flushAndReload, isSwitchingHere } from './setup/switchProvider';
import { registerLayoutCommands } from './persist/commands';
import { initAuth, useAuthStore } from './store/auth';
import { LoginScreen } from './auth/LoginScreen';
import { DialogHost } from './dialogs/DialogHost';
import { Inspector } from './inspector/Inspector';
import { Navigator } from './navigator/Navigator';
import { useAppStore } from './store/app';
import { useUiStore } from './store/ui';
import { QuickTools, ToolRail } from './toolbar/ToolRail';
import { TopBar } from './topbar/TopBar';
import { ContextMenuHost } from './ui/ContextMenu';
import { ErrorBoundary } from './ui/ErrorBoundary';
import { retryableLazy } from './ui/lazyRetry';
import { installShareLinkHandler } from './share/linkHandler';
import { ShareHost } from './share/ShareHost';
import { PromptHost } from './ui/Prompt';
import { ToastHost, actionToast } from './ui/Toast';
import { MOBILE_QUERY, useIsMobile } from './ui/useMediaQuery';
import './ui/ui.css';
import './App.css';

// The full-window screens are whole separate surfaces: load one on first open.
const WatchlistsPage = retryableLazy(() =>
  import('./watchlist/page/WatchlistsPage').then((m) => ({ default: m.WatchlistsPage })),
);
const ScreenerPage = retryableLazy(() =>
  import('./screener/page/ScreenerPage').then((m) => ({ default: m.ScreenerPage })),
);

/** Direct children of `.app` that belong to the chart shell (hidden while a screen is open). */
const SHELL_PARTS = ['.app-top', '.navigator', '.center', '.inspector', '.app-rail'];

/** Auth gate: nothing of the shell (persistence, provider, quotes) boots until the
 * server says this browser may run the app. */
export function App() {
  const status = useAuthStore((s) => s.status);
  useEffect(() => initAuth(), []);
  if (status === 'checking') return <div className="app-boot" aria-busy="true" />;
  if (status === 'login') return <LoginScreen />;
  return <Shell />;
}

function Shell() {
  const theme = useAppStore((s) => s.theme);
  const mobile = useIsMobile();
  // Phones show the drawing tools as a strip over the chart, toggled from the bottom bar.
  const railHidden = useUiStore((s) => (mobile ? !s.mobileToolsOpen : s.toolRailHidden));
  const inspectorOpen = useUiStore((s) => s.inspector !== null);
  const screen = useUiStore((s) => s.screen);
  const screenOpen = screen !== 'charts';
  const appRef = useRef<HTMLDivElement>(null);
  const PageScreen =
    screen === 'watchlists'
      ? WatchlistsPage.get()
      : screen === 'screener'
        ? ScreenerPage.get()
        : null;

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    // Browser chrome (mobile status bar / address bar) matches the panels.
    const color = getComputedStyle(document.documentElement).getPropertyValue('--panel').trim();
    if (color) document.querySelector('meta[name="theme-color"]')?.setAttribute('content', color);
  }, [theme]);

  // A full-window screen covers the shell: untab and unlabel its parts. They stay mounted,
  // so charts keep their data and switching back is instant.
  useEffect(() => {
    const root = appRef.current;
    if (!root) return;
    for (const sel of SHELL_PARTS) {
      const el = root.querySelector(sel);
      if (el instanceof HTMLElement) el.inert = screenOpen;
    }
  }, [screenOpen, inspectorOpen]);

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
    const unregisterScreener = registerScreenerCommands();
    const unregisterNotes = registerNotesCommands();
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
      unregisterScreener();
      unregisterNotes();
      unregisterReplay();
      uninstall();
    };
  }, []);

  // After the chart mounted (child effects run first): restore the last layout.
  useEffect(() => startPersistence(), []);
  // What the data provider supports (until known, everything counts as supported).
  useEffect(() => {
    void loadProvider();
  }, []);
  // Another tab switched the data provider: reload what this tab knows about it, and offer a
  // reload (the chart and every cached series still hold the old provider's data).
  useEffect(
    () =>
      getQuoteStream().onProviderChanged((frame) => {
        const mine = isSwitchingHere(); // this tab reloads by itself
        resetProviderStore();
        void refreshUsage();
        void loadProvider().then(() => {
          if (mine) return;
          const known = useProviderStore.getState();
          const name = known.loaded ? known.name : (frame.id ?? 'another provider');
          actionToast(`Data source changed to ${name}`, [
            { label: 'Reload', run: () => void flushAndReload() },
          ]);
        });
      }),
    [],
  );
  // First visit: which data source this instance runs on, and whether it answers.
  useEffect(() => startFirstRun(), []);
  // A share link (#tg-import=...) opens the import preview; nothing is imported unasked.
  useEffect(() => installShareLinkHandler(), []);

  return (
    <div
      ref={appRef}
      className={`app${inspectorOpen ? '' : ' no-inspector'}${screenOpen ? ' has-screen' : ''}`}
    >
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
      {screenOpen ? (
        <ErrorBoundary
          fallback={() => null}
          onError={(error) =>
            actionToast(
              `The ${screen === 'screener' ? 'screener' : 'watchlists'} screen failed to open: ${error.message}`,
              [],
              'error',
            )
          }
        >
          <Suspense fallback={null}>
            {/* `.get()` during render is intentional: it follows lazy-retry resets. */}
            {/* eslint-disable-next-line react-hooks/static-components */}
            {PageScreen ? <PageScreen /> : null}
          </Suspense>
        </ErrorBoundary>
      ) : null}
      <DialogHost />
      <ContextMenuHost />
      <PromptHost />
      <ShareHost />
      <ToastHost />
    </div>
  );
}
