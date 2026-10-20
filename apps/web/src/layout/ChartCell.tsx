import { ChartView } from '../chart/ChartView';
import { cssLen, type Box } from './geometry';

/** One grid cell: positions a chart inside the grid. Pointer focus is handled by the chart itself. */
export function ChartCell({ chartId, box }: { chartId: string; box: Box }) {
  return (
    <div
      className="grid-cell"
      style={{
        left: cssLen(box.x),
        top: cssLen(box.y),
        width: cssLen(box.w),
        height: cssLen(box.h),
      }}
    >
      <ChartView id={chartId} />
    </div>
  );
}
