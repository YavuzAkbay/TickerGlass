import { ChevronRight, Eye, EyeOff, Trash2 } from 'lucide-react';
import { useAppStore } from '../../store/app';
import { useChartStore } from '../../store/chart';
import { useChartTick } from '../hooks';

/** Panes and their series, kept in sync with chart state changes. */
export function ObjectTree() {
  const chart = useChartStore((s) => s.chart);
  const symbol = useAppStore((s) => s.symbol);
  const interval = useAppStore((s) => s.interval);
  useChartTick(chart, ['stateChange', 'dataLoaded']);

  if (!chart) return <div className="rs-empty-text rs-pad">No chart</div>;

  return (
    <div className="rs-tree" role="tree" aria-label="Object tree">
      {chart.panes.map((pane, i) => {
        const isMain = pane.id === 'main';
        const name = isMain ? 'Main pane' : `Pane ${i + 1}`;
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
                {pane.series.map((s) => (
                  <div key={s.id} role="treeitem" className="rs-tree-row rs-tree-series">
                    <span className="rs-tree-dot" />
                    <span className="rs-tree-label">
                      {s.id === 'main' ? `${symbol}, ${interval}` : s.title || s.id}
                    </span>
                  </div>
                ))}
                {pane.series.length === 0 ? (
                  <div className="rs-tree-row rs-tree-series muted">Empty pane</div>
                ) : null}
              </div>
            )}
          </div>
        );
      })}
      <div className="rs-section-title">Drawings</div>
      <div className="rs-empty-text rs-pad">No drawings yet</div>
    </div>
  );
}
