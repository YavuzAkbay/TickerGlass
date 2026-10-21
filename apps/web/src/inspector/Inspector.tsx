import { getDrawingTool } from '@investopen/engine';
import { X } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { DrawingProperties } from '../drawings/DrawingProperties';
import { lookupDrawing, useDrawingStore } from '../drawings/store';
import { useT } from '../i18n';
import { Details } from '../sidebar/panels/Details';
import { useChartView } from '../store/chartView';
import {
  DEFAULT_INSPECTOR_WIDTH,
  MAX_INSPECTOR_WIDTH,
  MIN_INSPECTOR_WIDTH,
  useUiStore,
} from '../store/ui';
import { IconButton } from '../ui/IconButton';
import '../sidebar/sidebar.css';
import './inspector.css';

const KEY_STEP = 16;

/** Right-hand detail panel between the chart and the tool rail; hidden unless a view is open. */
export function Inspector() {
  const inspector = useUiStore((s) => s.inspector);
  const isOpen = inspector !== null;
  const returnTo = useRef<HTMLElement | null>(null);

  // Move focus into the panel on open; give it back on close (button, Escape or auto-close).
  useEffect(() => {
    if (!isOpen) return;
    returnTo.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.querySelector<HTMLElement>('.inspector-title')?.focus();
    return () => {
      const prev = returnTo.current;
      returnTo.current = null;
      const active = document.activeElement;
      // Don't steal focus from something the user moved to (e.g. a dialog).
      if (active && active !== document.body && !active.closest('.inspector')) return;
      const target =
        prev && prev.isConnected && prev !== document.body
          ? prev
          : document.querySelector<HTMLElement>('.sh-symbol');
      target?.focus();
    };
  }, [isOpen]);

  if (!inspector) return null;
  return <InspectorBody view={inspector.view} id={inspector.id} />;
}

function InspectorBody({ view, id }: { view: 'symbol' | 'drawing'; id: string | undefined }) {
  const t = useT();
  const width = useUiStore((s) => s.inspectorWidth);
  const setWidth = useUiStore((s) => s.setInspectorWidth);
  const close = useUiStore((s) => s.closeInspector);
  const drawing = useDrawingStore((s) => (view === 'drawing' ? lookupDrawing(s, id) : undefined));
  const drag = useRef<{ x: number; w: number } | null>(null);
  const symbol = useChartView((s) => s.symbol);
  const [openedOn] = useState(symbol);
  const missing = view === 'drawing' && !drawing;
  // Drawings belong to a symbol: switching symbols leaves the edited drawing off screen.
  const stale = view === 'drawing' && symbol !== openedOn;

  // A drawing that was deleted (or never existed) leaves nothing to show.
  useEffect(() => {
    if (missing || stale) close();
  }, [missing, stale, close]);

  if (missing || stale) return null;
  const title =
    view === 'symbol'
      ? t('inspector.symbol')
      : (getDrawingTool(drawing!.type)?.name ?? t('inspector.drawing'));

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    drag.current = { x: e.clientX, w: width };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current) setWidth(drag.current.w - (e.clientX - drag.current.x));
  };
  const onPointerUp = () => {
    drag.current = null;
  };
  const onResizeKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowLeft') setWidth(width + KEY_STEP);
    else if (e.key === 'ArrowRight') setWidth(width - KEY_STEP);
    else return;
    e.preventDefault();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    // Pickers and menus handle their own Escape first.
    if ((e.target as HTMLElement).closest('[data-own-escape]')) return;
    e.preventDefault();
    close();
  };

  return (
    <aside
      className="inspector"
      aria-label={t('inspector.label')}
      style={{ width }}
      onKeyDown={onKeyDown}
    >
      <div
        className="inspector-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label={t('inspector.resize')}
        aria-valuenow={width}
        aria-valuemin={MIN_INSPECTOR_WIDTH}
        aria-valuemax={MAX_INSPECTOR_WIDTH}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={() => setWidth(DEFAULT_INSPECTOR_WIDTH)}
        onKeyDown={onResizeKey}
      />
      <header className="inspector-head">
        <h2 className="inspector-title" tabIndex={-1}>
          {title}
        </h2>
        <IconButton icon={X} label={t('inspector.close')} className="rs-head-btn" onClick={close} />
      </header>
      <div className="inspector-body">
        {view === 'symbol' ? <Details /> : drawing ? <DrawingProperties drawing={drawing} /> : null}
      </div>
    </aside>
  );
}
