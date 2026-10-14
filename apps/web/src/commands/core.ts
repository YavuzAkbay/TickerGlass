import {
  Camera,
  Expand,
  Keyboard,
  Moon,
  Redo2,
  RotateCcw,
  Search,
  Settings,
  Undo2,
} from 'lucide-react';
import { changeScale, toggleScaleMode } from '../chart/scaleActions';
import { useDrawingRuntime } from '../drawings/store';
import { getChart } from '../store/chart';
import { normalizeSymbol, useAppStore } from '../store/app';
import { useUiStore, type RightPanel } from '../store/ui';
import { toast } from '../ui/Toast';
import { useHistory } from './history';
import { commands, type Command } from './registry';

/** Longest main-chart symbol: drawings and notes store it in a String(32) column. */
export const MAX_CHART_SYMBOL = 32;
export const TOO_LONG_FOR_CHART = `Too long for a chart symbol (max ${MAX_CHART_SYMBOL}), add it with Compare instead`;

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

export async function saveScreenshot(copy: boolean): Promise<void> {
  const chart = getChart();
  if (!chart) return;
  const canvas = chart.takeScreenshot();
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
  if (!blob) return;
  if (copy && 'ClipboardItem' in window) {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    toast('Chart image copied to clipboard', 'success');
    return;
  }
  const a = document.createElement('a');
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  a.href = URL.createObjectURL(blob);
  a.download = `${chart.getSymbol()}_${chart.getInterval()}_${stamp}.png`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const PANELS: [RightPanel, string][] = [
  ['watchlist', 'Watchlist'],
  ['alerts', 'Alerts'],
  ['objectTree', 'Object tree'],
  ['dataWindow', 'Data window'],
  ['details', 'Symbol details'],
  ['news', 'News'],
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
        useAppStore.getState().setSymbol(symbol);
      },
    },
    {
      id: 'chart.setInterval',
      title: 'Set interval',
      hidden: true,
      run: (arg) => {
        if (typeof arg === 'string' && arg) useAppStore.getState().setInterval(arg);
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
      title: 'Compare or add symbol',
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
      run: () => useAppStore.setState((s) => ({ prepost: !s.prepost })),
    },
    {
      id: 'alert.create',
      title: 'Create alert',
      category: 'Alerts',
      shortcut: 'Alt+a',
      run: () => toast('Alerts arrive in Phase 10'),
    },
    {
      id: 'replay.toggle',
      title: 'Bar replay',
      category: 'Chart',
      shortcut: 'Shift+Alt+r',
      run: () => toast('Market replay arrives in Phase 13'),
    },
    ...PANELS.map(([id, title]): Command => ({
      id: `view.panel.${id}`,
      title: `Toggle ${title} panel`,
      category: 'Panels',
      run: () => useUiStore.getState().togglePanel(id),
    })),
  ];
  return commands.register(list);
}
