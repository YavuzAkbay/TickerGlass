import type { Drawing } from '@investopen/engine';
import { ChevronRight, Eye, EyeOff, Lock, Trash2, Unlock } from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  paneStack,
  removeDrawings,
  reorderPane,
  toggleHidden,
  toggleLocked,
} from '../../drawings/actions';
import { drawingMenuItems, openDrawingSettings } from '../../drawings/menu';
import { toolName } from '../../drawings/model';
import { drawingsFor, useDrawingRuntime, useDrawingStore } from '../../drawings/store';
import { useChartView } from '../../store/chartView';
import { useChartStore } from '../../store/chart';
import { openContextMenu } from '../../ui/ContextMenu';
import { useChartTick } from '../hooks';

/** Drawings of one pane, top of the z-order first; drag a row to reorder. */
function DrawingRows({ paneId, list }: { paneId: string; list: Drawing[] }) {
  const selection = useDrawingRuntime((s) => s.selection);
  const chart = useChartStore((s) => s.chart);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  if (!list.length) return null;
  const topFirst = [...list].reverse();

  const drop = (targetId: string) => {
    if (!dragId || dragId === targetId) return;
    const order = topFirst.map((d) => d.id).filter((id) => id !== dragId);
    order.splice(order.indexOf(targetId), 0, dragId);
    reorderPane(paneId, order.reverse(), 'Reorder drawings');
  };

  return (
    <>
      {topFirst.map((d) => {
        const name = toolName(d.type);
        const label = d.text ? `${name}: ${d.text}` : name;
        const selected = selection.includes(d.id);
        return (
          <div
            key={d.id}
            role="treeitem"
            aria-selected={selected}
            aria-label={label}
            draggable
            className={`rs-tree-row rs-tree-series rs-tree-drawing${selected ? ' selected' : ''}${d.hidden ? ' muted' : ''}${overId === d.id && dragId !== d.id ? ' drop-target' : ''}`}
            onClick={(e) =>
              chart?.selectDrawings([d.id], { add: e.shiftKey || e.metaKey || e.ctrlKey })
            }
            onDoubleClick={() => openDrawingSettings(d.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              const ids = selected ? selection : [d.id];
              if (!selected) chart?.selectDrawings([d.id]);
              openContextMenu(e.clientX, e.clientY, drawingMenuItems(ids));
            }}
            onDragStart={(e) => {
              setDragId(d.id);
              e.dataTransfer.effectAllowed = 'move';
            }}
            onDragOver={(e) => {
              if (!dragId || !list.some((x) => x.id === dragId)) return;
              e.preventDefault();
              setOverId(d.id);
            }}
            onDragLeave={() => setOverId((o) => (o === d.id ? null : o))}
            onDrop={(e) => {
              e.preventDefault();
              drop(d.id);
              setDragId(null);
              setOverId(null);
            }}
            onDragEnd={() => {
              setDragId(null);
              setOverId(null);
            }}
          >
            <span
              className="rs-tree-dot"
              style={{
                background: typeof d.style.lineColor === 'string' ? d.style.lineColor : undefined,
              }}
            />
            <span className="rs-tree-label">{label}</span>
            <button
              type="button"
              className="rs-tree-btn"
              aria-label={d.locked ? `Unlock ${name}` : `Lock ${name}`}
              title={d.locked ? 'Unlock' : 'Lock'}
              onClick={(e) => {
                e.stopPropagation();
                toggleLocked([d.id]);
              }}
            >
              {d.locked ? <Lock size={15} /> : <Unlock size={15} />}
            </button>
            <button
              type="button"
              className="rs-tree-btn"
              aria-label={d.hidden ? `Show ${name}` : `Hide ${name}`}
              title={d.hidden ? 'Show' : 'Hide'}
              onClick={(e) => {
                e.stopPropagation();
                toggleHidden([d.id]);
              }}
            >
              {d.hidden ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
            <button
              type="button"
              className="rs-tree-btn"
              aria-label={`Remove ${name}`}
              title="Remove"
              onClick={(e) => {
                e.stopPropagation();
                removeDrawings([d.id]);
              }}
            >
              <Trash2 size={15} />
            </button>
          </div>
        );
      })}
    </>
  );
}

/** Panes with their series, studies and drawings, kept in sync with the chart. */
export function ObjectTree() {
  const chart = useChartStore((s) => s.chart);
  const symbol = useChartView((s) => s.symbol);
  const interval = useChartView((s) => s.interval);
  // Re-render on drawing store changes (paneStack reads it). Select the
  // stable bucket arrays: a selector building a new array every call makes
  // useSyncExternalStore loop forever.
  const own = useDrawingStore((s) => s.bySymbol[symbol]);
  const synced = useDrawingStore((s) => s.synced);
  const drawings = useMemo(
    () => drawingsFor({ bySymbol: own ? { [symbol]: own } : {}, synced }, symbol),
    [own, synced, symbol],
  );
  useChartTick(chart, ['stateChange', 'dataLoaded']);

  if (!chart) return <div className="rs-empty-text rs-pad">No chart</div>;

  const paneIds = new Set(chart.panes.map((p) => p.id));
  const orphans = drawings.filter((d) => !paneIds.has(d.paneId));

  return (
    <div className="rs-tree" role="tree" aria-label="Object tree">
      {chart.panes.map((pane, i) => {
        const isMain = pane.id === 'main';
        const name = isMain ? 'Main pane' : `Pane ${i + 1}`;
        const stack = paneStack(pane.id);
        return (
          <div key={pane.id} role="treeitem" aria-expanded={!pane.collapsed} aria-label={name}>
            <div className={`rs-tree-row rs-tree-pane${pane.collapsed ? ' muted' : ''}`}>
              <ChevronRight size={14} className={`rs-tree-caret${pane.collapsed ? '' : ' open'}`} />
              <span className="rs-tree-label">{name}</span>
              <button
                type="button"
                className="rs-tree-btn"
                aria-label={pane.collapsed ? `Show ${name}` : `Hide ${name}`}
                title={pane.collapsed ? 'Show' : 'Hide'}
                onClick={() => chart.collapsePane(pane.id, !pane.collapsed)}
              >
                {pane.collapsed ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
              {isMain ? (
                <span className="rs-tree-btn-spacer" />
              ) : (
                <button
                  type="button"
                  className="rs-tree-btn"
                  aria-label={`Remove ${name}`}
                  title="Remove"
                  onClick={() => chart.removePane(pane.id)}
                >
                  <Trash2 size={15} />
                </button>
              )}
            </div>
            {pane.collapsed ? null : (
              <div role="group">
                <DrawingRows paneId={pane.id} list={stack} />
                {pane.series.map((s) => (
                  <div key={s.id} role="treeitem" className="rs-tree-row rs-tree-series">
                    <span className="rs-tree-dot" />
                    <span className="rs-tree-label">
                      {s.id === 'main' ? `${symbol}, ${interval}` : s.title || s.id}
                    </span>
                  </div>
                ))}
                {pane.series.length === 0 && stack.length === 0 ? (
                  <div className="rs-tree-row rs-tree-series muted">Empty pane</div>
                ) : null}
              </div>
            )}
          </div>
        );
      })}
      {orphans.length ? (
        <>
          <div className="rs-section-title">Drawings on removed panes</div>
          {[...new Set(orphans.map((d) => d.paneId))].map((paneId) => (
            <DrawingRows key={paneId} paneId={paneId} list={paneStack(paneId)} />
          ))}
        </>
      ) : null}
      {drawings.length === 0 ? <div className="rs-empty-text rs-pad">No drawings</div> : null}
    </div>
  );
}
