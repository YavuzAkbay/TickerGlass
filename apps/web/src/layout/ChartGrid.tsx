import { useEffect, useMemo } from 'react';
import { ChartCell } from './ChartCell';
import { gridGeometry } from './geometry';
import { markGridMounted } from './mounted';
import { SplitHandle } from './SplitHandle';
import { useLayoutGrid } from './store';

/**
 * The layout's charts. Cells and splitters are a flat list positioned from the
 * grid tree (see geometry.ts), keyed by chart id, so a chart keeps its element
 * and engine chart when a template moves it to another branch.
 */
export function ChartGrid() {
  const grid = useLayoutGrid((s) => s.grid);
  const geometry = useMemo(() => gridGeometry(grid), [grid]);
  useEffect(() => markGridMounted(), []);
  return (
    <div className="chart-stack">
      {geometry.cells.map((c) => (
        <ChartCell key={c.chartId} chartId={c.chartId} box={c.box} />
      ))}
      {geometry.splitters.map((g) => (
        <SplitHandle key={`${g.path.join('.')}:${g.index}`} geometry={g} />
      ))}
    </div>
  );
}
