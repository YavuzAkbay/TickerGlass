import { useEffect, useState } from 'react';
import { LineSeries, type Chart, type PriceScaleMode } from '@investopen/engine';
import { ChartView } from './chart/ChartView';
import { useAppStore } from './store/app';
import './App.css';

const INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1D', '1W', '1M'];

export function App() {
  const { theme, symbol, interval, toggleTheme, setSymbol, setInterval } = useAppStore();
  const [chart, setChart] = useState<Chart | null>(null);
  const [draft, setDraft] = useState(symbol);
  const [mode, setMode] = useState<PriceScaleMode>('linear');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    if (!chart) return;
    const offs = [
      chart.on('error', (e) => setError(e.message)),
      chart.on('dataLoaded', () => setError(null)),
    ];
    return () => offs.forEach((off) => off());
  }, [chart]);

  const changeMode = (m: PriceScaleMode) => {
    const next = mode === m ? 'linear' : m;
    setMode(next);
    chart?.setPriceScaleMode('main', next);
  };

  const addPane = () => {
    if (!chart) return;
    const pane = chart.addPane(1);
    chart.addSeries(
      pane.id,
      new LineSeries(
        `close-${pane.id}`,
        'Close',
        () => chart.store.close,
        () => chart.store.length,
      ),
    );
  };

  return (
    <div className="shell">
      <header className="topbar">
        <span className="brand">InvestOpen</span>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (draft.trim()) setSymbol(draft.trim().toUpperCase());
          }}
        >
          <input
            className="symbol-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            aria-label="Symbol"
          />
        </form>
        <div className="group">
          {INTERVALS.map((iv) => (
            <button
              key={iv}
              type="button"
              className={iv === interval ? 'active' : ''}
              onClick={() => setInterval(iv)}
            >
              {iv}
            </button>
          ))}
        </div>
        <div className="group">
          <button
            type="button"
            className={mode === 'log' ? 'active' : ''}
            onClick={() => changeMode('log')}
          >
            log
          </button>
          <button
            type="button"
            className={mode === 'percent' ? 'active' : ''}
            onClick={() => changeMode('percent')}
          >
            %
          </button>
          <button type="button" onClick={() => chart?.resetView()}>
            reset
          </button>
          <button type="button" onClick={addPane}>
            + pane
          </button>
        </div>
        {error && <span className="error">{error}</span>}
        <span className="spacer" />
        <button type="button" onClick={toggleTheme}>
          {theme === 'dark' ? 'Light' : 'Dark'}
        </button>
      </header>
      <main className="chart-area">
        <ChartView symbol={symbol} interval={interval} theme={theme} onReady={setChart} />
      </main>
    </div>
  );
}
