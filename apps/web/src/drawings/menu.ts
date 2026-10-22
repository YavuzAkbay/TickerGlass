import { CHANNEL_TOOLS, LINE_TOOLS } from '@tickerglass/alerts';
import { getDrawingTool, type DrawingStyle } from '@tickerglass/engine';
import {
  ArrowDownToLine,
  Bell,
  ArrowUpToLine,
  ClipboardCopy,
  Copy,
  Eye,
  EyeOff,
  Layers,
  Link,
  Lock,
  Palette,
  Settings,
  Trash2,
  Unlock,
} from 'lucide-react';
import { openAlertDialog } from '../alerts/dialog/open';
import { isBrickType } from '../alerts/dialog/sources';
import { useChartView } from '../store/chartView';
import { getChart } from '../store/chart';
import { useUiStore } from '../store/ui';
import type { MenuItem } from '../ui/Menu';
import { toast } from '../ui/Toast';
import {
  cloneDrawings,
  copyDrawings,
  findDrawing,
  removeDrawings,
  setDrawingStyle,
  setScope,
  setVisibility,
  toggleHidden,
  toggleLocked,
  zOrder,
} from './actions';
import { currentPreset, toolName, visibilityPreset, type VisibilityPreset } from './model';
import { useDrawingRuntime, useDrawingTemplates } from './store';

export type DrawingSettingsTab = 'style' | 'text' | 'coordinates' | 'visibility';

export function openDrawingSettings(
  id: string,
  opts: { tab?: DrawingSettingsTab; saveTemplate?: boolean } = {},
): void {
  useUiStore.getState().openInspector('drawing', id, opts);
}

/** Inline text editor over the chart at viewport (x, y). */
export function openTextEditor(id: string, x: number, y: number, created: boolean): void {
  useDrawingRuntime.setState({ textEdit: { id, x, y, created } });
}

/** Tool defaults merged with the user's saved default style (or factory defaults). */
export function defaultStyleOf(type: string): DrawingStyle | null {
  const def = getDrawingTool(type);
  if (!def) return null;
  return { ...structuredClone(def.defaults), ...useDrawingTemplates.getState().defaults[type] };
}

/** Template submenu for drawings of one tool type. */
export function templateItems(ids: readonly string[], type: string): MenuItem[] {
  const def = getDrawingTool(type);
  if (!def) return [];
  const templates = useDrawingTemplates.getState();
  const saved = templates.byType[type] ?? [];
  const first = ids[0];
  const items: MenuItem[] = [
    {
      label: 'Save as…',
      disabled: !first,
      onSelect: () => first && openDrawingSettings(first, { saveTemplate: true }),
    },
    {
      label: 'Save as default',
      disabled: !first,
      onSelect: () => {
        const d = first ? findDrawing(first) : undefined;
        if (!d) return;
        templates.saveDefault(type, structuredClone(d.style));
        toast(`Saved as default for ${def.name}`, 'success');
      },
    },
    {
      label: 'Apply default',
      onSelect: () => {
        const style = defaultStyleOf(type);
        if (style) setDrawingStyle(ids, style, 'Apply default template');
      },
    },
    {
      label: 'Reset to factory defaults',
      onSelect: () => setDrawingStyle(ids, structuredClone(def.defaults), 'Reset style'),
    },
  ];
  if (saved.length) {
    items.push({ type: 'separator' }, { type: 'header', label: 'Templates' });
    for (const t of saved)
      items.push({
        label: t.name,
        onSelect: () => setDrawingStyle(ids, structuredClone(t.style), `Apply ${t.name}`),
      });
  }
  if (templates.defaults[type]) {
    items.push(
      { type: 'separator' },
      { label: 'Remove saved default', onSelect: () => templates.clearDefault(type) },
    );
  }
  return items;
}

const PRESETS: [VisibilityPreset, string][] = [
  ['above', 'Current interval and above'],
  ['only', 'Current interval only'],
  ['below', 'Current interval and below'],
  ['all', 'All intervals'],
];

/** Right-click menu of the selected drawings (also the mini-toolbar "More" menu). */
export function drawingMenuItems(ids: readonly string[]): MenuItem[] {
  const list = ids.map((id) => findDrawing(id)).filter((d) => !!d);
  const first = list[0];
  if (!first) return [];
  const sel = list.map((d) => d.id);
  const single = list.length === 1;
  const sameType = list.every((d) => d.type === first.type);
  const locked = list.every((d) => d.locked);
  const hidden = list.every((d) => d.hidden);
  const synced = list.every((d) => d.scope === 'all');
  const interval = useChartView.getState().interval;
  const preset = currentPreset(first.visibility, interval);
  const items: MenuItem[] = [];
  if (single)
    items.push({
      label: 'Settings…',
      icon: Settings,
      disabled: !getDrawingTool(first.type),
      onSelect: () => openDrawingSettings(first.id),
    });
  if (single && (LINE_TOOLS.includes(first.type) || CHANNEL_TOOLS.includes(first.type))) {
    const brick = isBrickType(useChartView.getState().chartType);
    items.push({
      label: 'Add alert…',
      icon: Bell,
      disabled: brick,
      ...(brick ? { title: 'Drawing alerts are not available on this chart type' } : {}),
      onSelect: () => openAlertDialog({ drawingId: first.id }),
    });
  }
  items.push(
    { label: 'Clone', icon: Copy, shortcut: 'Alt+drag', onSelect: () => void cloneDrawings(sel) },
    {
      label: 'Copy',
      icon: ClipboardCopy,
      shortcut: 'Mod+c',
      onSelect: () => void copyDrawings(sel),
    },
    { type: 'separator' },
    {
      label: 'Visual order',
      icon: Layers,
      submenu: [
        { label: 'Bring to front', icon: ArrowUpToLine, onSelect: () => zOrder(sel, 'front') },
        { label: 'Bring forward', onSelect: () => zOrder(sel, 'forward') },
        { label: 'Send backward', onSelect: () => zOrder(sel, 'backward') },
        { label: 'Send to back', icon: ArrowDownToLine, onSelect: () => zOrder(sel, 'back') },
      ],
    },
    {
      label: 'Visibility on intervals',
      icon: Eye,
      submenu: PRESETS.map(([p, label]) => ({
        label,
        checked: preset === p,
        onSelect: () => setVisibility(sel, visibilityPreset(interval, p)),
      })),
    },
    {
      label: 'Sync to all symbols',
      icon: Link,
      checked: synced,
      onSelect: () => setScope(sel, synced ? 'symbol' : 'all'),
    },
  );
  if (sameType && getDrawingTool(first.type))
    items.push({ label: 'Presets', icon: Palette, submenu: templateItems(sel, first.type) });
  items.push(
    { type: 'separator' },
    {
      label: locked ? 'Unlock' : 'Lock',
      icon: locked ? Unlock : Lock,
      onSelect: () => toggleLocked(sel),
    },
    {
      label: hidden ? 'Show' : 'Hide',
      icon: hidden ? Eye : EyeOff,
      onSelect: () => toggleHidden(sel),
    },
    { type: 'separator' },
    {
      label: single ? `Remove ${toolName(first.type)}` : `Remove ${list.length} drawings`,
      icon: Trash2,
      danger: true,
      shortcut: 'Delete',
      onSelect: () => {
        removeDrawings(sel);
        getChart()?.selectDrawings([]);
      },
    },
  );
  return items;
}
