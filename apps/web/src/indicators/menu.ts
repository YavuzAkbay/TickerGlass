import {
  PRICE_SOURCES,
  getIndicator,
  isOutputRef,
  type OutputSourceRef,
  type SourceValue,
} from '@investopen/indicators';
import { Bell, Copy, Eye, EyeOff, Layers, Settings, SquareFunction, Trash2 } from 'lucide-react';
import { openAlertDialog } from '../alerts/dialog/open';
import { useUiStore } from '../store/ui';
import type { MenuItem } from '../ui/Menu';
import {
  addIndicator,
  findIndicator,
  removeIndicator,
  toggleIndicatorVisible,
  updateIndicator,
} from './actions';
import {
  SOURCE_LABELS,
  dependentsOf,
  inputsTitle,
  sourceInputKey,
  type IndicatorState,
  type Placement,
} from './model';
import { useIndicatorStore } from './store';

export function openIndicatorSettings(id: string): void {
  useUiStore.getState().openDialog('indicatorSettings', { id });
}

/** Indicators dialog in "add on top of this output" mode. */
export function openAddIndicatorOn(sourceOf: OutputSourceRef): void {
  useUiStore.getState().openDialog('indicators', { sourceOf });
}

/** First plot output, the default source for indicator-on-indicator. */
export function firstPlotId(type: string): string | null {
  return getIndicator(type)?.outputs.find((o) => o.type === 'plot')?.id ?? null;
}

/** Legend "more" button and right-click menu of a study. */
export function indicatorMenuItems(id: string): MenuItem[] {
  const inst = findIndicator(id);
  const def = inst ? getIndicator(inst.type) : undefined;
  if (!inst || !def) return [];
  const plot = firstPlotId(inst.type);
  const place = (p: Placement, label: string): MenuItem => ({
    label,
    checked: inst.placement === p,
    onSelect: () => updateIndicator(id, { placement: p }, 'Move indicator'),
  });
  return [
    { label: 'Settings…', icon: Settings, onSelect: () => openIndicatorSettings(id) },
    {
      label: inst.visible ? 'Hide' : 'Show',
      icon: inst.visible ? EyeOff : Eye,
      onSelect: () => toggleIndicatorVisible(id),
    },
    {
      label: 'Add alert…',
      icon: Bell,
      disabled: !plot,
      onSelect: () => openAlertDialog({ indicatorId: id }),
    },
    { type: 'separator' },
    {
      label: `Add indicator on ${def.shortName}…`,
      icon: SquareFunction,
      disabled: !plot,
      onSelect: () => plot && openAddIndicatorOn({ instanceId: id, outputId: plot }),
    },
    {
      label: 'Duplicate',
      icon: Copy,
      onSelect: () =>
        addIndicator(inst.type, {
          inputs: inst.inputs,
          from: {
            styles: inst.styles,
            visibility: inst.visibility,
            visible: inst.visible,
            placement: inst.placement,
          },
        }),
    },
    {
      label: 'Move to',
      icon: Layers,
      submenu: [
        place('auto', def.overlay ? 'Default (price pane)' : 'Default (own pane)'),
        place('main', 'Price pane'),
        place('own', 'New pane'),
      ],
    },
    { type: 'separator' },
    { label: 'Remove', icon: Trash2, danger: true, onSelect: () => removeIndicator(id) },
  ];
}

function sameSource(a: SourceValue | undefined, b: SourceValue): boolean {
  if (isOutputRef(a) && isOutputRef(b))
    return a.instanceId === b.instanceId && a.outputId === b.outputId;
  return a === b;
}

/** Sources an instance may read: price columns and plots of other (non-dependent) instances. */
export function sourceOptions(
  inst: IndicatorState,
  all: readonly IndicatorState[],
): { label: string; value: SourceValue }[] {
  const out: { label: string; value: SourceValue }[] = PRICE_SOURCES.map((s) => ({
    label: SOURCE_LABELS[s],
    value: s,
  }));
  const blocked = dependentsOf(all, inst.id);
  for (const other of all) {
    if (other.id === inst.id || blocked.has(other.id)) continue;
    const def = getIndicator(other.type);
    if (!def) continue;
    const head = [
      def.shortName,
      inputsTitle(def, other.inputs, (id) => all.find((i) => i.id === id)),
    ]
      .filter(Boolean)
      .join(' ');
    for (const o of def.outputs) {
      if (o.type !== 'plot') continue;
      out.push({ label: `${head}: ${o.title}`, value: { instanceId: other.id, outputId: o.id } });
    }
  }
  return out;
}

/** Legend "source" button menu. */
export function sourceMenuItems(id: string): MenuItem[] {
  const inst = findIndicator(id);
  const def = inst ? getIndicator(inst.type) : undefined;
  const key = def ? sourceInputKey(def) : null;
  if (!inst || !key) return [];
  const current = inst.inputs[key] as SourceValue | undefined;
  const items: MenuItem[] = [{ type: 'header', label: 'Source' }];
  const options = sourceOptions(inst, useIndicatorStore.getState().instances);
  options.forEach((o, i) => {
    if (i === PRICE_SOURCES.length) items.push({ type: 'separator' });
    items.push({
      label: o.label,
      checked: sameSource(current, o.value),
      onSelect: () =>
        updateIndicator(id, { inputs: { ...inst.inputs, [key]: o.value } }, 'Change source'),
    });
  });
  return items;
}
