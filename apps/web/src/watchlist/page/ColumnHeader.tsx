import { ArrowDown, ArrowUp } from 'lucide-react';
import { useEffect, useRef, type DragEvent, type KeyboardEvent, type PointerEvent } from 'react';
import { useT } from '../../i18n';
import { clampWidth } from '../columns/presets';
import { COLUMN_DEFS } from '../columns/registry';
import type { ColumnId, SortSpec } from '../types';

/** Where a dragged column header would land: before/after the header it is over. */
export interface ColumnDrop {
  from: ColumnId;
  over: ColumnId | null;
  after: boolean;
}

/** Keyboard resize step (Alt+Shift+Left/Right) in px. */
const RESIZE_STEP = 16;

interface Props {
  id: ColumnId;
  label: string;
  title: string;
  align: 'left' | 'right';
  sortable: boolean;
  sort: SortSpec | null;
  /** The data source cannot fill this column (explained in the tooltip). */
  unavailable: boolean;
  drag: ColumnDrop | null;
  onSort: (id: ColumnId) => void;
  /** Alt+Left/Right. */
  onMove: (id: ColumnId, dir: -1 | 1) => void;
  onDragState: (d: ColumnDrop | null) => void;
  onDropOn: (from: ColumnId, to: ColumnId, after: boolean) => void;
  /** Live width while dragging the resize handle (null = done). */
  onResizeLive: (id: ColumnId, px: number | null) => void;
  /** Commit a width; null resets to the default track. */
  onResize: (id: ColumnId, px: number | null) => void;
}

/** One column header: click sorts; drag or Alt+Arrows reorder; the right edge resizes. */
export function ColumnHeader(p: Props) {
  const t = useT();
  const ref = useRef<HTMLSpanElement>(null);
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanup.current?.(), []);

  const active = p.sort?.key === p.id;
  const isDrop = p.drag && p.drag.over === p.id && p.drag.from !== p.id;

  const onKeyDown = (e: KeyboardEvent<HTMLSpanElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      e.stopPropagation();
      const dir = e.key === 'ArrowRight' ? 1 : -1;
      if (e.shiftKey) {
        const w = ref.current?.getBoundingClientRect().width;
        if (w) p.onResize(p.id, clampWidth(w + dir * RESIZE_STEP));
      } else p.onMove(p.id, dir);
      return;
    }
    if (!p.sortable || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    p.onSort(p.id);
  };

  const onDragStart = (e: DragEvent<HTMLSpanElement>) => {
    if ((e.target as HTMLElement).closest('.wlp-resize')) {
      e.preventDefault();
      return;
    }
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('application/x-tickerglass-column', p.id);
    p.onDragState({ from: p.id, over: null, after: false });
  };
  const onDragOver = (e: DragEvent<HTMLSpanElement>) => {
    if (!p.drag) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const r = e.currentTarget.getBoundingClientRect();
    const after = e.clientX >= r.left + r.width / 2;
    if (p.drag.over !== p.id || p.drag.after !== after)
      p.onDragState({ ...p.drag, over: p.id, after });
  };
  const onDrop = (e: DragEvent<HTMLSpanElement>) => {
    if (!p.drag) return;
    e.preventDefault();
    p.onDropOn(p.drag.from, p.id, p.drag.after);
    p.onDragState(null);
  };

  const startResize = (e: PointerEvent<HTMLSpanElement>) => {
    const el = ref.current;
    if (!el || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    cleanup.current?.(); // a drag that never ended (lost pointerup) is released first
    const startX = e.clientX;
    const startW = el.getBoundingClientRect().width;
    let w = startW;
    const move = (ev: globalThis.PointerEvent) => {
      w = clampWidth(startW + ev.clientX - startX);
      p.onResizeLive(p.id, w);
    };
    const stop = () => {
      cleanup.current?.();
      if (w !== startW) p.onResize(p.id, w);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    // Also runs on unmount / a new drag: always ends the live preview.
    cleanup.current = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
      cleanup.current = null;
      p.onResizeLive(p.id, null);
    };
  };

  const tip = p.unavailable
    ? `${p.title}: ${t(COLUMN_DEFS[p.id].snapshot ? 'wlp.snapUnavailable' : 'wlp.colUnavailable')}`
    : `${p.sortable ? `${t('wlp.sortBy')} ` : ''}${p.title}`;

  return (
    <span
      ref={ref}
      role="columnheader"
      aria-sort={
        p.sortable
          ? active
            ? p.sort!.dir === 'asc'
              ? 'ascending'
              : 'descending'
            : 'none'
          : undefined
      }
      aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight"
      data-col={p.id}
      data-testid={`wlp-col-${p.id}`}
      className={`wlp-th${active ? ' sorted' : ''}${p.align === 'right' ? ' right' : ''}${p.drag?.from === p.id ? ' dragging' : ''}${isDrop ? (p.drag!.after ? ' drop-after' : ' drop-before') : ''}`}
      title={`${tip} (${t('wlp.colReorderHint')})`}
      tabIndex={0}
      draggable
      onClick={() => p.sortable && p.onSort(p.id)}
      onKeyDown={onKeyDown}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={() => p.onDragState(null)}
    >
      {p.label}
      {active ? p.sort!.dir === 'asc' ? <ArrowUp size={11} /> : <ArrowDown size={11} /> : null}
      <span
        className="wlp-resize"
        aria-hidden="true"
        title={t('wlp.colResize')}
        draggable={false}
        onPointerDown={startResize}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => {
          e.stopPropagation();
          p.onResize(p.id, null);
        }}
      />
    </span>
  );
}
