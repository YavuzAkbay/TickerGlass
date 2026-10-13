import { useEffect } from 'react';
import { BottomBar } from './bottombar/BottomBar';
import { ChartView } from './chart/ChartView';
import { registerCoreCommands } from './commands/core';
import { installShortcuts } from './commands/shortcuts';
import { DialogHost } from './dialogs/DialogHost';
import { RightSidebar } from './sidebar/RightSidebar';
import { useAppStore } from './store/app';
import { useUiStore } from './store/ui';
import { LeftToolbar } from './toolbar/LeftToolbar';
import { TopBar } from './topbar/TopBar';
import { ContextMenuHost } from './ui/ContextMenu';
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
    // Digits open the interval input, anything else symbol search .
    const uninstall = installShortcuts((initial) =>
      useUiStore
        .getState()
        .openDialog(/\d/.test(initial) ? 'intervalInput' : 'symbolSearch', { initial }),
    );
    return () => {
      unregister();
      uninstall();
    };
  }, []);

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
      <ToastHost />
    </div>
  );
}
