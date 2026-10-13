import { useEffect, useState } from 'react';
import { useAppStore } from './store/app';
import './App.css';

type ApiStatus = 'checking' | 'ok' | 'down';

export function App() {
  const theme = useAppStore((s) => s.theme);
  const toggleTheme = useAppStore((s) => s.toggleTheme);
  const [api, setApi] = useState<ApiStatus>('checking');

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    fetch('/api/health')
      .then((r) => setApi(r.ok ? 'ok' : 'down'))
      .catch(() => setApi('down'));
  }, []);

  return (
    <div className="shell">
      <header className="topbar">
        <span className="brand">InvestOpen</span>
        <span className="spacer" />
        <span className={`api api-${api}`}>API: {api}</span>
        <button type="button" onClick={toggleTheme}>
          {theme === 'dark' ? 'Light' : 'Dark'} theme
        </button>
      </header>
      <main className="chart-area">Chart goes here</main>
    </div>
  );
}
