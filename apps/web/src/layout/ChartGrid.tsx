import { useEffect, useMemo } from 'react';
import { useStore } from 'zustand';
import type { ChartSession } from '../chart/session';
import { setActiveChart, useChartStore } from '../store/chart';
import { useIsMobile } from '../ui/useMediaQuery';
import { ChartCell } from './ChartCell';
import { gridGeometry } from './geometry';
import { markGridMounted } from './mounted';
import { SplitHandle } from './SplitHandle';
import { useLayoutGrid } from './store';

/**
 * The layout's charts. Cells and splitters are a flat list positioned from the
 * grid tree (see geometry.ts), keyed by chart id, so a chart keeps its element
 * and engine chart when a template moves it to another branch.
 *
 * Phones show one chart of a multi-chart layout at a time (the active one,
 * shown like a maximized cell) with a tab strip to switch: every cell stays
 * mounted at its grid size underneath, so switching is instant.
 */
export function ChartGrid() {
  const grid = useLayoutGrid((s) => s.grid);
  const maximizedId = useLayoutGrid((s) => s.maximizedId);
  const activeId = useChartStore((s) => s.activeId);
  const mobile = useIsMobile();
  const geometry = useMemo(() => gridGeometry(grid), [grid]);
  const has = (id: string | null) => geometry.cells.some((c) => c.chartId === id);
  const single = mobile && geometry.cells.length > 1;
  const shown = single
    ? has(activeId)
      ? activeId
      : (geometry.cells[0]?.chartId ?? null)
    : has(maximizedId)
      ? maximizedId
      : null;
  useEffect(() => markGridMounted(), []);
  return (
    <>
      {single ? <PaneSwitcher ids={geometry.cells.map((c) => c.chartId)} shown={shown} /> : null}
      <div className={`chart-stack${single ? ' with-switcher' : ''}`}>
        {geometry.cells.map((c) => (
          <ChartCell
            key={c.chartId}
            chartId={c.chartId}
            box={c.box}
            maximized={shown === c.chartId}
            covered={shown !== null && shown !== c.chartId}
          />
        ))}
        {shown !== null
          ? null
          : geometry.splitters.map((g) => (
              <SplitHandle key={`${g.path.join('.')}:${g.index}`} geometry={g} />
            ))}
      </div>
    </>
  );
}

/** Phones: one tab per chart of the layout (its number and symbol); picking one shows it. */
function PaneSwitcher({ ids, shown }: { ids: string[]; shown: string | null }) {
  return (
    <div className="pane-switcher" role="tablist" aria-label="Charts in this layout">
      {ids.map((id, i) => (
        <PaneTab key={id} id={id} index={i} selected={id === shown} />
      ))}
    </div>
  );
}

function PaneTab({ id, index, selected }: { id: string; index: number; selected: boolean }) {
  const session = useChartStore((s) => s.sessions.get(id));
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      className={`pane-tab${selected ? ' active' : ''}`}
      onClick={() => setActiveChart(id)}
    >
      <span className="pane-tab-num">{index + 1}</span>
      {session ? <PaneSymbol info={session.info} /> : null}
    </button>
  );
}

function PaneSymbol({ info }: { info: ChartSession['info'] }) {
  const symbol = useStore(info, (s) => s.symbolInfo?.symbol ?? '');
  return <span className="pane-tab-sym">{symbol}</span>;
}
