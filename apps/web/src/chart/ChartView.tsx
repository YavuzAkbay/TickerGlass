import { useEffect, useRef } from 'react';
import { DARK_THEME, LIGHT_THEME, createChart, type Chart } from '@investopen/engine';
import { feed } from './feed';
import { openChartContextMenu } from './contextMenus';
import { useAppStore } from '../store/app';
import { useChartStore } from '../store/chart';

/** Hosts the engine chart and keeps it in sync with the app stores. */
export function ChartView() {
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<Chart | null>(null);
  const { symbol, interval, theme, timezone, prepost, crosshair, magnet } = useAppStore();
  const { chartType, chartStyle, volume, showPrevClose } = useAppStore();

  useEffect(() => {
    const s = useAppStore.getState();
    const chart = createChart(hostRef.current!, feed, {
      theme: s.theme === 'dark' ? DARK_THEME : LIGHT_THEME,
      timezone: s.timezone,
      prepost: s.prepost,
      crosshair: s.crosshair,
      magnet: s.magnet,
      showPrevClose: s.showPrevClose,
    });
    chart.setChartStyle(s.chartStyle);
    chart.setChartType(s.chartType);
    chart.setVolumeMode(s.volume);
    chartRef.current = chart;
    useChartStore.setState({ chart });
    // Expose for debugging and e2e tests.
    (window as unknown as { chart?: Chart }).chart = chart;
    const offs = [
      chart.on('symbolResolved', (info) => useChartStore.setState({ symbolInfo: info })),
      chart.on('crosshairMove', (c) => useChartStore.setState({ crosshair: c })),
      chart.on('loading', (loading) => useChartStore.setState({ loading })),
      chart.on('contextMenu', (p) => openChartContextMenu(chart, p)),
    ];
    return () => {
      offs.forEach((off) => off());
      useChartStore.setState({ chart: null });
      chart.destroy();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    void chartRef.current?.setSymbolAndInterval(symbol, interval);
  }, [symbol, interval]);

  useEffect(() => {
    chartRef.current?.applyOptions({
      theme: theme === 'dark' ? DARK_THEME : LIGHT_THEME,
      timezone,
      prepost,
      crosshair,
      magnet,
    });
  }, [theme, timezone, prepost, crosshair, magnet]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.setChartStyle(chartStyle);
    chart.setChartType(chartType);
    chart.setVolumeMode(volume);
    chart.applyOptions({ showPrevClose });
  }, [chartType, chartStyle, volume, showPrevClose]);

  return <div ref={hostRef} className="chart-host" />;
}
