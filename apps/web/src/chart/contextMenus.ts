import type { Chart, ChartPoint } from '@investopen/engine';
import {
  Bell,
  ClipboardCopy,
  Eye,
  LineChart,
  Maximize2,
  Minimize2,
  MoveDown,
  MoveUp,
  RotateCcw,
  Settings,
  Trash2,
} from 'lucide-react';
import { commands } from '../commands/registry';
import { changeScale, toggleScaleMode } from './scaleActions';
import { openContextMenu } from '../ui/ContextMenu';
import type { MenuItem } from '../ui/Menu';
import { toast } from '../ui/Toast';

function priceText(chart: Chart, price: number | undefined): string {
  if (price === undefined) return '';
  const d = chart.symbolInfo ? Math.max(0, -Math.floor(Math.log10(chart.symbolInfo.minTick))) : 2;
  return price.toFixed(d);
}

function scaleItems(chart: Chart, paneId: string): MenuItem[] {
  const pane = chart.getState().panes.find((p) => p.id === paneId);
  const ps = pane?.priceScale;
  if (!ps) return [];
  const setMode = (mode: 'linear' | 'log' | 'percent' | 'indexed') => () =>
    toggleScaleMode(chart, paneId, mode);
  return [
    {
      label: 'Auto (fits data to screen)',
      checked: ps.autoScale,
      onSelect: () => changeScale(chart, paneId, { autoScale: !ps.autoScale }, 'Auto scale'),
    },
    {
      label: 'Invert scale',
      checked: ps.invert,
      shortcut: 'Alt+I',
      onSelect: () => changeScale(chart, paneId, { invert: !ps.invert }, 'Invert scale'),
    },
    { type: 'separator' },
    { label: 'Regular', checked: ps.mode === 'linear', onSelect: setMode('linear') },
    {
      label: 'Percent',
      checked: ps.mode === 'percent',
      shortcut: 'Alt+P',
      onSelect: setMode('percent'),
    },
    { label: 'Indexed to 100', checked: ps.mode === 'indexed', onSelect: setMode('indexed') },
    {
      label: 'Logarithmic',
      checked: ps.mode === 'log',
      shortcut: 'Alt+L',
      onSelect: setMode('log'),
    },
  ];
}

function paneItems(chart: Chart, paneId: string): MenuItem[] {
  const state = chart.getState();
  const idx = state.panes.findIndex((p) => p.id === paneId);
  const maximized = state.maximizedPane === paneId;
  const items: MenuItem[] = [
    {
      label: maximized ? 'Restore pane' : 'Maximize pane',
      icon: maximized ? Minimize2 : Maximize2,
      onSelect: () => chart.maximizePane(maximized ? null : paneId),
    },
  ];
  if (state.panes.length > 1) {
    items.push(
      {
        label: 'Move pane up',
        icon: MoveUp,
        disabled: idx <= 0,
        onSelect: () => chart.movePane(paneId, -1),
      },
      {
        label: 'Move pane down',
        icon: MoveDown,
        disabled: idx >= state.panes.length - 1,
        onSelect: () => chart.movePane(paneId, 1),
      },
    );
  }
  if (paneId !== 'main') {
    items.push({
      label: 'Remove pane',
      icon: Trash2,
      danger: true,
      onSelect: () => chart.removePane(paneId),
    });
  }
  return items;
}

/** Right-click menus for the chart canvas, price axis and time axis. */
export function openChartContextMenu(chart: Chart, p: ChartPoint): void {
  const { clientX: x, clientY: y } = p;
  if (p.kind === 'priceAxis' && p.paneId) {
    openContextMenu(x, y, [
      {
        label: `Add alert at ${priceText(chart, p.price)}`,
        icon: Bell,
        onSelect: () => commands.execute('alert.create', { price: p.price }),
      },
      { type: 'separator' },
      ...scaleItems(chart, p.paneId),
    ]);
    return;
  }
  if (p.kind === 'timeAxis') {
    openContextMenu(x, y, [
      {
        label: 'Reset time scale',
        icon: RotateCcw,
        shortcut: 'Alt+R',
        onSelect: () => chart.resetView(),
      },
      {
        label: 'Go to date…',
        shortcut: 'Alt+G',
        onSelect: () => commands.execute('chart.goToDate'),
      },
    ]);
    return;
  }
  if (p.kind !== 'pane' || !p.paneId) return;
  const symbol = chart.getSymbol();
  openContextMenu(x, y, [
    {
      label: 'Reset chart view',
      icon: RotateCcw,
      shortcut: 'Alt+R',
      onSelect: () => chart.resetView(),
    },
    { type: 'separator' },
    {
      label: `Copy price ${priceText(chart, p.price)}`,
      icon: ClipboardCopy,
      onSelect: () => {
        void navigator.clipboard.writeText(priceText(chart, p.price));
        toast('Price copied');
      },
    },
    {
      label: `Add alert on ${symbol} at ${priceText(chart, p.price)}`,
      icon: Bell,
      shortcut: 'Alt+A',
      onSelect: () => commands.execute('alert.create', { price: p.price }),
    },
    { type: 'separator' },
    {
      label: 'Add indicator…',
      icon: LineChart,
      shortcut: '/',
      onSelect: () => commands.execute('chart.indicators'),
    },
    { label: 'Compare or add symbol…', onSelect: () => commands.execute('chart.compare') },
    { type: 'separator' },
    { label: 'Price scale', submenu: scaleItems(chart, p.paneId) },
    { label: 'Pane', submenu: paneItems(chart, p.paneId) },
    {
      label: 'Hide drawings',
      icon: Eye,
      onSelect: () => commands.execute('drawings.toggleHideAll'),
    },
    {
      label: 'Remove drawings',
      icon: Trash2,
      onSelect: () => commands.execute('drawings.removeAll'),
    },
    { type: 'separator' },
    { label: 'Settings…', icon: Settings, onSelect: () => commands.execute('chart.settings') },
  ]);
}
