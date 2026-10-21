import { Ellipsis, Eye, EyeOff, X } from 'lucide-react';
import { useState } from 'react';
import { createPortal } from 'react-dom';
import type { Chart } from '@investopen/engine';
import { useStore } from 'zustand';
import type { ChartSession } from '../chart/session';
import { openContextMenu } from '../ui/ContextMenu';
import { DropdownMenu } from '../ui/Menu';
import { removeCompare, toggleCompareVisible } from './actions';
import { compareMenuItems } from './menu';
import { comparePaneId, type CompareState } from './model';
import type { StatusLineSettings } from '../store/chartView';
import type { CompareStatus } from './store';
import './compare.css';

type LegendChart = Pick<Chart, 'getLegendSlot' | 'getStudyValues' | 'store'>;

/**
 * Legend rows sit inside the chart root, whose native listeners would start a
 * pan or open the chart menu. Handle right-click (overlay menu) here natively
 * and keep the events away from the chart.
 */
function shieldFromChart(el: HTMLDivElement | null) {
  if (!el) return;
  const stop = (e: Event) => e.stopPropagation();
  const menu = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const id = (e.target as HTMLElement).closest<HTMLElement>('[data-compare-id]')?.dataset
      .compareId;
    if (id) openContextMenu(e.clientX, e.clientY, compareMenuItems(id));
  };
  el.addEventListener('pointerdown', stop);
  el.addEventListener('dblclick', stop);
  el.addEventListener('contextmenu', menu);
  return () => {
    el.removeEventListener('pointerdown', stop);
    el.removeEventListener('dblclick', stop);
    el.removeEventListener('contextmenu', menu);
  };
}

/** Compare legend rows, rendered into each pane's engine compare slot. */
export function CompareLegends({ session }: { session: ChartSession }) {
  const { chart } = session;
  const statusLine = useStore(session.view, (s) => s.statusLine);
  const items = useStore(session.compares, (s) => s.items);
  const status = useStore(session.compareRuntime, (s) => s.status);
  // Re-read last-bar values when overlay data changes.
  useStore(session.compareRuntime, (s) => s.tick);
  const crossIndex = useStore(session.info, (s) => s.crosshair?.index ?? null);
  const index = crossIndex ?? chart.store.length - 1;
  // A 'pane' overlay without its pane (e.g. unavailable on this chart type) lists on the main pane.
  const byPane = new Map<string, CompareState[]>();
  for (const item of items) {
    const own = comparePaneId(item.id);
    const paneId = item.placement === 'pane' && chart.getLegendSlot(own, 'compare') ? own : 'main';
    byPane.set(paneId, [...(byPane.get(paneId) ?? []), item]);
  }
  return (
    <>
      {[...byPane].map(([paneId, list]) => {
        const slot = chart.getLegendSlot(paneId, 'compare');
        if (!slot) return null;
        return createPortal(
          <div className="cmp-legend" ref={shieldFromChart}>
            {list.map((item) => (
              <LegendRow
                key={item.id}
                chart={chart}
                item={item}
                index={index}
                status={status[item.id]}
                statusLine={statusLine}
              />
            ))}
          </div>,
          slot,
          paneId,
        );
      })}
    </>
  );
}

function LegendRow({
  chart,
  item,
  index,
  status,
  statusLine,
}: {
  chart: LegendChart;
  item: CompareState;
  index: number;
  status: CompareStatus | undefined;
  statusLine: StatusLineSettings;
}) {
  const [moreBtn, setMoreBtn] = useState<HTMLButtonElement | null>(null);
  const [menu, setMenu] = useState(false);
  const ready = status?.state === 'ready';
  const value =
    item.visible && ready && index >= 0 ? chart.getStudyValues(item.id, index)[0] : undefined;

  let tail = null;
  if (item.visible && statusLine.indicatorValues) {
    if (status?.state === 'error' || status?.state === 'unavailable') {
      tail = (
        <span className="cmp-legend-error" title={status.message}>
          {status.message}
        </span>
      );
    } else if (!ready) {
      tail = <span className="cmp-legend-muted">Loading…</span>;
    } else if (value) {
      tail = (
        <span className="cmp-legend-value" style={{ color: item.color }} title={value.title}>
          {value.text || '∅'}
        </span>
      );
    }
  }

  return (
    <div
      className={`cmp-legend-row${item.visible ? '' : ' off'}${menu ? ' menu-open' : ''}`}
      data-compare-id={item.id}
    >
      <span className="cmp-legend-dot" style={{ background: item.color }} aria-hidden="true" />
      {statusLine.indicatorTitles ? <span className="cmp-legend-name">{item.symbol}</span> : null}
      <span className="cmp-legend-actions">
        <button
          type="button"
          className="cmp-legend-btn"
          aria-label={item.visible ? 'Hide' : 'Show'}
          title={item.visible ? 'Hide' : 'Show'}
          onClick={() => toggleCompareVisible(item.id)}
        >
          {item.visible ? <Eye size={15} /> : <EyeOff size={15} />}
        </button>
        <button
          type="button"
          className="cmp-legend-btn"
          aria-label="Remove"
          title="Remove"
          onClick={() => removeCompare(item.id)}
        >
          <X size={15} />
        </button>
        <button
          ref={setMoreBtn}
          type="button"
          className="cmp-legend-btn"
          aria-label="More"
          title="More"
          aria-haspopup="menu"
          aria-expanded={menu}
          onClick={() => setMenu((m) => !m)}
        >
          <Ellipsis size={15} />
        </button>
      </span>
      {tail}
      <DropdownMenu
        anchor={moreBtn}
        open={menu}
        onClose={() => setMenu(false)}
        items={menu ? compareMenuItems(item.id) : []}
      />
    </div>
  );
}
