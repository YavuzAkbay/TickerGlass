import { useEffect, useRef } from 'react';
import { DARK_THEME, LIGHT_THEME, createChart, type Chart } from '@investopen/engine';
import { feed } from './feed';
import type { Theme } from '../store/app';

interface Props {
  symbol: string;
  interval: string;
  theme: Theme;
  onReady?: (chart: Chart | null) => void;
}

export function ChartView({ symbol, interval, theme, onReady }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<Chart | null>(null);

  useEffect(() => {
    const chart = createChart(hostRef.current!, feed, {
      theme: theme === 'dark' ? DARK_THEME : LIGHT_THEME,
    });
    chartRef.current = chart;
    onReady?.(chart);
    // Expose for debugging and e2e tests.
    (window as unknown as { chart?: Chart }).chart = chart;
    return () => {
      onReady?.(null);
      chart.destroy();
      chartRef.current = null;
    };
    // Created once; props are applied by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void chartRef.current?.setSymbolAndInterval(symbol, interval);
  }, [symbol, interval]);

  useEffect(() => {
    chartRef.current?.applyOptions({ theme: theme === 'dark' ? DARK_THEME : LIGHT_THEME });
  }, [theme]);

  return <div ref={hostRef} className="chart-host" />;
}
