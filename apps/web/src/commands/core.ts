import type { Chart } from '@tickerglass/engine';
import {
  Camera,
  Database,
  Expand,
  FileSpreadsheet,
  FileText,
  Keyboard,
  Moon,
  Redo2,
  RotateCcw,
  Search,
  Settings,
  Undo2,
} from 'lucide-react';
import { useAlerts } from '../alerts/store';
import { isCloneArgs, openAlertDialog, sanitizeCreateArgs } from '../alerts/dialog/open';
import { errorMessage } from '../api/client';
import { getCapabilities } from '../api/provider';
import { changeScale, toggleScaleMode } from './scaleActions';
import { useDrawingRuntime } from '../drawings/store';
import { activeChartId, syncBus } from '../layout/sync';
import {
  buildTable,
  dataFilename,
  exportInputFromChart,
  isIntradayInterval,
  makeTimeFormatter,
  toCsv,
} from '../chart/exportData';
import { composeScreenshot, screenshotFilename } from '../chart/screenshot';
import { leaves } from '../layout/grid';
import { useLayoutGrid } from '../layout/store';
import { downloadBlob } from '../persist/layouts';
import { getChart, useChartStore } from '../store/chart';
import { normalizeSymbol, useAppStore } from '../store/app';
import { useChartView } from '../store/chartView';
import { useUiStore, type NavSection } from '../store/ui';
import { toast } from '../ui/Toast';
import { useHistory } from './history';
import { commands, type Command } from './registry';

/** Longest main-chart symbol: drawings and notes store it in a String(32) column. */
export const MAX_CHART_SYMBOL = 32;
export const TOO_LONG_FOR_CHART = `Too long for a chart symbol (max ${MAX_CHART_SYMBOL}), add it with Compare instead`;

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const hasChart = () => !!getChart();
/** Undo/redo would fight an ongoing drawing drag or the open text editor. */
const drawingBusy = () => {
  const r = useDrawingRuntime.getState();
  return r.dragging || !!r.textEdit;
};
const open = (
  id: Parameters<ReturnType<typeof useUiStore.getState>['openDialog']>[0],
  arg?: unknown,
) => useUiStore.getState().openDialog(id, arg);

/** Charts to capture: the focused one, or every chart of the layout in grid order. */
function screenshotCharts(layout: boolean): Chart[] {
  const active = getChart();
  if (!active) return [];
  const { grid, maximizedId } = useLayoutGrid.getState();
  if (!layout || maximizedId !== null) return [active];
  const { sessions } = useChartStore.getState();
  const charts = leaves(grid).flatMap((id) => sessions.get(id)?.chart ?? []);
  return charts.length ? charts : [active];
}

export async function saveScreenshot(copy: boolean, layout = false): Promise<void> {
  const charts = screenshotCharts(layout);
  const first = charts[0];
  if (!first) return;
  const now = new Date();
  const canvas = composeScreenshot(charts, now);
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
  if (!blob) return;
  const what = charts.length > 1 ? 'Layout' : 'Chart';
  if (copy && 'ClipboardItem' in window) {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    toast(`${what} image copied to clipboard`, 'success');
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = screenshotFilename(first.getSymbol(), first.getInterval(), now);
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/**
 * Export the active chart's data (displayed series plus every attached
 * study's plot columns) as CSV or XLSX. Generated and downloaded entirely in
 * this browser: a self-hosted server is never contacted, so the file always
 * lands on the machine the chart is open on.
 */
export async function exportChartData(format: 'csv' | 'xlsx'): Promise<void> {
  const chart = getChart();
  if (!chart) return;
  try {
    const input = exportInputFromChart(chart);
    if (!input) {
      toast('No data to export');
      return;
    }
    const table = buildTable(input);
    const fmtTime = makeTimeFormatter(chart.timezone, isIntradayInterval(chart.getInterval()));
    const filename = dataFilename(chart.getSymbol(), chart.getInterval(), format, new Date());
    if (format === 'csv') {
      // BOM: Excel reads UTF-8 CSV correctly only with it.
      const csv = '\uFEFF' + toCsv(table, fmtTime);
      downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), filename);
    } else {
      const { buildXlsx } = await import('../chart/xlsx');
      const bytes = buildXlsx(table, fmtTime, chart.getSymbol());
      downloadBlob(new Blob([bytes], { type: XLSX_MIME }), filename);
    }
    toast(`Exported ${table.n.toLocaleString()} bars to ${filename}`, 'success');
  } catch (err) {
    toast(`Chart data export failed: ${errorMessage(err)}`, 'error');
  }
}

const PANELS: [NavSection | 'details', string][] = [
  ['watchlist', 'Watchlist'],
  ['alerts', 'Alerts'],
  ['timeline', 'Timeline'],
  ['objectTree', 'Layers'],
  ['dataWindow', 'Values'],
  ['details', 'Symbol details'],
  ['notes', 'Notes'],
];

export function registerCoreCommands(): () => void {
  const list: Command[] = [
    {
      id: 'chart.symbolSearch',
      title: 'Symbol search',
      category: 'Chart',
      icon: Search,
      run: (arg) => open('symbolSearch', arg),
    },
    {
      id: 'chart.setSymbol',
      title: 'Set symbol',
      hidden: true,
      run: (arg) => {
        if (typeof arg !== 'string' || !arg) return;
        const symbol = normalizeSymbol(arg);
        if (symbol.length > MAX_CHART_SYMBOL) {
          toast(TOO_LONG_FOR_CHART, 'error');
          return;
        }
        const from = activeChartId();
        if (from !== null) syncBus.setSymbol(from, symbol);
        else useChartView.getState().setSymbol(symbol);
      },
    },
    {
      id: 'chart.setInterval',
      title: 'Set interval',
      hidden: true,
      run: (arg) => {
        if (typeof arg !== 'string' || !arg) return;
        const from = activeChartId();
        if (from !== null) syncBus.setInterval(from, arg);
        else useChartView.getState().setInterval(arg);
      },
    },
    {
      id: 'chart.indicators',
      title: 'Indicators',
      category: 'Chart',
      shortcut: '/',
      run: () => open('indicators'),
    },
    {
      id: 'chart.compare',
      title: 'Overlay a symbol',
      category: 'Chart',
      run: () => open('compare'),
    },
    {
      id: 'chart.settings',
      title: 'Chart settings',
      category: 'Chart',
      icon: Settings,
      run: () => open('settings'),
    },
    {
      id: 'chart.goToDate',
      title: 'Go to date',
      category: 'Chart',
      shortcut: 'Alt+G',
      run: () => open('goToDate'),
    },
    {
      id: 'chart.resetView',
      title: 'Reset chart view',
      category: 'Chart',
      shortcut: 'Alt+R',
      icon: RotateCcw,
      enabled: hasChart,
      run: () => getChart()?.resetView(),
    },
    {
      id: 'chart.scale.log',
      title: 'Toggle logarithmic scale',
      category: 'Scale',
      shortcut: 'Alt+L',
      enabled: hasChart,
      run: () => toggleScaleMode(getChart()!, 'main', 'log'),
    },
    {
      id: 'chart.scale.percent',
      title: 'Toggle percent scale',
      category: 'Scale',
      shortcut: 'Alt+P',
      enabled: hasChart,
      run: () => toggleScaleMode(getChart()!, 'main', 'percent'),
    },
    {
      id: 'chart.scale.indexed',
      title: 'Toggle indexed-to-100 scale',
      category: 'Scale',
      enabled: hasChart,
      run: () => toggleScaleMode(getChart()!, 'main', 'indexed'),
    },
    {
      id: 'chart.scale.invert',
      title: 'Invert price scale',
      category: 'Scale',
      shortcut: 'Alt+I',
      enabled: hasChart,
      run: () => {
        const c = getChart()!;
        const inv = c.getState().panes[0]!.priceScale.invert;
        changeScale(c, 'main', { invert: !inv }, 'Invert scale');
      },
    },
    {
      id: 'chart.scale.auto',
      title: 'Toggle auto scale',
      category: 'Scale',
      enabled: hasChart,
      run: () => {
        const c = getChart()!;
        const auto = c.getState().panes[0]!.priceScale.autoScale;
        changeScale(c, 'main', { autoScale: !auto }, 'Auto scale');
      },
    },
    {
      id: 'chart.screenshot',
      title: 'Download chart image',
      category: 'Chart',
      shortcut: 'Alt+S',
      icon: Camera,
      enabled: hasChart,
      run: () => saveScreenshot(false),
    },
    {
      id: 'chart.screenshot.copy',
      title: 'Copy chart image',
      category: 'Chart',
      shortcut: 'Shift+Mod+S',
      icon: Camera,
      enabled: hasChart,
      run: () => saveScreenshot(true),
    },
    {
      id: 'chart.screenshotLayout',
      title: 'Download layout image',
      category: 'Chart',
      icon: Camera,
      enabled: hasChart,
      run: () => saveScreenshot(false, true),
    },
    {
      id: 'chart.screenshotLayout.copy',
      title: 'Copy layout image',
      category: 'Chart',
      icon: Camera,
      enabled: hasChart,
      run: () => saveScreenshot(true, true),
    },
    {
      id: 'chart.exportCSV',
      title: 'Download chart data (CSV)',
      category: 'Chart',
      icon: FileText,
      enabled: hasChart,
      run: () => exportChartData('csv'),
    },
    {
      id: 'chart.exportXLSX',
      title: 'Download chart data (XLSX)',
      category: 'Chart',
      icon: FileSpreadsheet,
      enabled: hasChart,
      run: () => exportChartData('xlsx'),
    },
    {
      id: 'view.fullscreen',
      title: 'Toggle fullscreen',
      category: 'View',
      shortcut: 'Shift+f',
      icon: Expand,
      run: () =>
        document.fullscreenElement
          ? document.exitFullscreen()
          : document.documentElement.requestFullscreen(),
    },
    {
      id: 'view.toggleTheme',
      title: 'Toggle dark/light theme',
      category: 'View',
      icon: Moon,
      run: () => useAppStore.getState().toggleTheme(),
    },
    {
      id: 'view.commandPalette',
      title: 'Command palette',
      category: 'View',
      shortcut: 'Mod+k',
      allowInInput: true,
      run: () => open('commandPalette'),
    },
    {
      id: 'app.dataSource',
      title: 'Data source…',
      category: 'App',
      icon: Database,
      run: () => open('dataSource'),
    },
    {
      id: 'view.shortcuts',
      title: 'Keyboard shortcuts',
      category: 'View',
      shortcut: 'Shift+?',
      icon: Keyboard,
      run: () => open('shortcuts'),
    },
    {
      id: 'edit.undo',
      title: 'Undo',
      category: 'Edit',
      shortcut: 'Mod+z',
      icon: Undo2,
      enabled: () => useHistory.getState().past.length > 0 && !drawingBusy(),
      run: () => useHistory.getState().undo(),
    },
    {
      id: 'edit.redo',
      title: 'Redo',
      category: 'Edit',
      shortcut: ['Shift+Mod+z', 'Mod+y'],
      icon: Redo2,
      enabled: () => useHistory.getState().future.length > 0 && !drawingBusy(),
      run: () => useHistory.getState().redo(),
    },
    {
      id: 'session.toggle',
      title: 'Toggle extended trading hours',
      category: 'Chart',
      shortcut: 'Alt+E',
      enabled: () => getCapabilities().extendedHistory,
      run: () => useChartView.setState((s) => ({ prepost: !s.prepost })),
    },
    {
      id: 'alert.create',
      title: 'Create alert',
      category: 'Alerts',
      shortcut: 'Alt+a',
      // `{price?, paneId?, symbol?, drawingId?, indicatorId?}` or `{cloneOf: id}`.
      run: (arg) => {
        if (isCloneArgs(arg)) {
          if (useAlerts.getState().alerts[arg.cloneOf]) openAlertDialog({ cloneOf: arg.cloneOf });
          else toast('Alert not found', 'error');
          return;
        }
        openAlertDialog(sanitizeCreateArgs(arg));
      },
    },
    {
      id: 'alert.edit',
      title: 'Edit alert',
      category: 'Alerts',
      hidden: true,
      run: (arg) => {
        const id = (arg as { id?: unknown } | undefined)?.id;
        if (typeof id === 'string' && useAlerts.getState().alerts[id])
          openAlertDialog({ editId: id });
        else toast('Alert not found', 'error');
      },
    },
    ...PANELS.map(([id, title]): Command => ({
      id: `view.panel.${id}`,
      title: `Toggle ${title} panel`,
      category: 'Panels',
      run: () => {
        const ui = useUiStore.getState();
        // Symbol details live in the Inspector.
        if (id !== 'details') ui.toggleNav(id);
        else if (ui.inspector?.view === 'symbol') ui.closeInspector();
        else ui.openInspector('symbol');
      },
    })),
  ];
  return commands.register(list);
}
