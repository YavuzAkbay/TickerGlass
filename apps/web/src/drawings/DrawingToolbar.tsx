import {
  getDrawingTool,
  type Chart,
  type DrawingBounds,
  type DrawingProperty,
  type JsonValue,
} from '@tickerglass/engine';
import { Ellipsis, Lock, Settings, Trash2, Type, Unlock } from 'lucide-react';
import { useLayoutEffect, useRef, useState, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { ColorSwatch } from '../dialogs/ColorPicker';
import { useT } from '../i18n';
import { getChart } from '../store/chart';
import { useUiStore } from '../store/ui';
import { IconButton } from '../ui/IconButton';
import { DropdownMenu, type MenuItem } from '../ui/Menu';
import { removeDrawings, setDrawingStyle, toggleLocked } from './actions';
import { drawingMenuItems, openDrawingSettings, openTextEditor } from './menu';
import { useDrawingRuntime, useDrawingStore, type DrawingBuckets } from './store';
import './drawings.css';

const FILL_KEY = /fill|back/i;
const GAP = 14;

/**
 * Viewport box of the drawings (anchors and handles, as the engine maps them),
 * or null when none is shown.
 */
export function selectionBox(chart: Chart, ids: readonly string[]): DrawingBounds | null {
  const b = chart.getDrawingBounds(ids);
  if (!b) return null;
  const root = chart.root.getBoundingClientRect();
  return {
    left: root.left + b.left,
    right: root.left + b.right,
    top: root.top + b.top,
    bottom: root.top + b.bottom,
  };
}

export interface ToolbarControls {
  line: DrawingProperty | undefined;
  fill: DrawingProperty | undefined;
  width: DrawingProperty | undefined;
  lineStyle: DrawingProperty | undefined;
  textColor: DrawingProperty | undefined;
}

/** Mini-toolbar controls a tool's schema offers (first match per role). */
export function toolbarControls(props: readonly DrawingProperty[]): ToolbarControls {
  const style = props.filter((p) => (p.tab ?? 'style') === 'style');
  return {
    line: style.find((p) => p.kind === 'color' && !FILL_KEY.test(p.key)),
    fill: style.find((p) => p.kind === 'color' && FILL_KEY.test(p.key)),
    width: style.find((p) => p.kind === 'lineWidth'),
    lineStyle: style.find((p) => p.kind === 'lineStyle'),
    textColor: props.find((p) => p.tab === 'text' && p.kind === 'color'),
  };
}

const LINE_STYLES: [string, string][] = [
  ['solid', 'Solid'],
  ['dashed', 'Dashed'],
  ['dotted', 'Dotted'],
];

function lineStyleIcon(style: string) {
  const dash = style === 'dashed' ? '4 3' : style === 'dotted' ? '1.5 2.5' : undefined;
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
      <line
        x1="3"
        y1="11"
        x2="19"
        y2="11"
        stroke="currentColor"
        strokeWidth="2"
        strokeDasharray={dash}
      />
    </svg>
  );
}

function lookupAll(s: DrawingBuckets, ids: readonly string[]) {
  const want = new Set(ids);
  return [s.synced, ...Object.values(s.bySymbol)].flat().filter((d) => want.has(d.id));
}

/** Button that opens a dropdown menu. */
function MenuButton({
  label,
  items,
  children,
}: {
  label: string;
  items: MenuItem[];
  children: React.ReactNode;
}) {
  const [btn, setBtn] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <IconButton
        ref={setBtn}
        label={label}
        className="drw-tb-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {children}
      </IconButton>
      <DropdownMenu anchor={btn} open={open} onClose={() => setOpen(false)} items={items} />
    </>
  );
}

/**
 * Floating toolbar for the selected drawings, placed above the pointer that
 * selected them (draggable by its grip). Controls come from the tool schema.
 */
export function DrawingToolbar() {
  const selection = useDrawingRuntime((s) => s.selection);
  const dragging = useDrawingRuntime((s) => s.dragging);
  const editing = useDrawingRuntime((s) => !!s.textEdit);
  const buckets = useDrawingStore();
  const dialogOpen = useUiStore((s) => !!s.dialog);
  const list = lookupAll(buckets, selection);
  const visible = list.length > 0 && !dragging && !editing && !dialogOpen;
  if (!visible) return null;
  return <ToolbarBody key={selection.join(',')} ids={list.map((d) => d.id)} />;
}

function ToolbarBody({ ids }: { ids: string[] }) {
  const t = useT();
  const buckets = useDrawingStore();
  const list = lookupAll(buckets, ids);
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  // Place above the selection's anchors (else below them, else above the
  // pointer that selected it), inside the chart area.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || pos) return;
    const chart = getChart();
    const area = chart?.root.getBoundingClientRect();
    const at = useDrawingRuntime.getState().pointer;
    const box =
      (chart && selectionBox(chart, ids)) ??
      (at ? { left: at.x, right: at.x, top: at.y, bottom: at.y } : null);
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const top = (area?.top ?? 0) + 4;
    const bottom = (area?.bottom ?? window.innerHeight) - h - 4;
    let x = box
      ? (box.left + box.right) / 2 - w / 2
      : (area ? area.left + area.width / 2 : 300) - w / 2;
    let y = box ? box.top - h - GAP : top;
    if (box && y < top) y = box.bottom + GAP > bottom ? top : box.bottom + GAP;
    if (area) x = Math.max(area.left + 4, Math.min(x, area.right - w - 4));
    setPos({ x, y: Math.max(top, Math.min(y, bottom)) });
  }, [pos, ids]);

  const first = list[0];
  if (!first) return null;
  const def = getDrawingTool(first.type);
  const sameType = list.every((d) => d.type === first.type);
  const c = toolbarControls(def && sameType ? def.properties : []);
  const widthKey = c.width?.key;
  const lineStyleKey = c.lineStyle?.key;
  const locked = list.every((d) => d.locked);
  const val = (key: string): JsonValue | undefined => first.style[key];
  const color = (p: DrawingProperty | undefined, label: string) =>
    p ? (
      <ColorSwatch
        value={typeof val(p.key) === 'string' ? (val(p.key) as string) : '#6E9BD6'}
        label={label}
        onChange={(v) =>
          setDrawingStyle(ids, { [p.key]: v }, `Change ${label.toLowerCase()}`, `color:${p.key}`)
        }
      />
    ) : null;

  const onGrip = {
    onPointerDown: (e: PointerEvent<HTMLDivElement>) => {
      const r = ref.current?.getBoundingClientRect();
      if (!r) return;
      drag.current = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    onPointerMove: (e: PointerEvent<HTMLDivElement>) => {
      if (drag.current) setPos({ x: e.clientX - drag.current.dx, y: e.clientY - drag.current.dy });
    },
    onPointerUp: () => {
      drag.current = null;
    },
  };

  return createPortal(
    <div
      ref={ref}
      className="drw-toolbar"
      role="toolbar"
      aria-label="Drawing toolbar"
      style={pos ? { left: pos.x, top: pos.y } : { left: -9999, top: -9999 }}
    >
      <div className="drw-tb-grip" aria-label="Move toolbar" {...onGrip}>
        <svg width="6" height="14" viewBox="0 0 6 14" aria-hidden="true">
          {[1.5, 5.5, 9.5, 13].map((y) => (
            <g key={y} fill="currentColor">
              <circle cx="1.5" cy={y - 0.5} r="1" />
              <circle cx="4.5" cy={y - 0.5} r="1" />
            </g>
          ))}
        </svg>
      </div>
      {color(c.line, 'Line color')}
      {color(c.fill, 'Background color')}
      {widthKey ? (
        <MenuButton
          label="Line width"
          items={[1, 2, 3, 4].map((w) => ({
            label: `${w}px`,
            checked: val(widthKey) === w,
            onSelect: () => setDrawingStyle(ids, { [widthKey]: w }, 'Change line width'),
          }))}
        >
          <span className="drw-tb-width">{String(val(widthKey) ?? 1)}px</span>
        </MenuButton>
      ) : null}
      {lineStyleKey ? (
        <MenuButton
          label="Line style"
          items={LINE_STYLES.map(([v, label]) => ({
            label,
            checked: val(lineStyleKey) === v,
            onSelect: () => setDrawingStyle(ids, { [lineStyleKey]: v }, 'Change line style'),
          }))}
        >
          {lineStyleIcon(String(val(lineStyleKey) ?? 'solid'))}
        </MenuButton>
      ) : null}
      {def?.text && list.length === 1 ? (
        <>
          {c.line && !first.text ? null : color(c.textColor, 'Text color')}
          <IconButton
            label="Edit text"
            icon={Type}
            className="drw-tb-btn"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              openTextEditor(first.id, r.left, r.bottom + 8, false);
            }}
          />
        </>
      ) : null}
      <div className="drw-tb-sep" />
      <IconButton
        label={t('drawing.settings')}
        icon={Settings}
        className="drw-tb-btn"
        disabled={list.length !== 1 || !def}
        onClick={() => openDrawingSettings(first.id)}
      />
      <IconButton
        label={locked ? 'Unlock' : 'Lock'}
        icon={locked ? Lock : Unlock}
        active={locked}
        className="drw-tb-btn"
        onClick={() => toggleLocked(ids)}
      />
      <IconButton
        label="Remove"
        icon={Trash2}
        className="drw-tb-btn"
        onClick={() => {
          // Like the Delete key: locked drawings stay.
          removeDrawings(ids, { skipLocked: true });
          getChart()?.selectDrawings([]);
        }}
      />
      <MenuButton label="More" items={drawingMenuItems(ids)}>
        <Ellipsis size={18} />
      </MenuButton>
    </div>,
    document.body,
  );
}
