import { ChartView } from '../chart/ChartView';
import { cssLen, type Box } from './geometry';

/** One grid cell: positions a chart inside the grid. Pointer focus is handled by the chart itself. */
export function ChartCell({
  chartId,
  box,
  maximized = false,
  covered = false,
}: {
  chartId: string;
  box: Box;
  /** Fills the whole grid, above the other cells. */
  maximized?: boolean;
  /** Another cell is maximized over this one (it keeps its size and stays mounted). */
  covered?: boolean;
}) {
  return (
    <div
      className={`grid-cell${maximized ? ' maximized' : ''}`}
      data-maximized={maximized || undefined}
      aria-hidden={covered || undefined}
      style={
        maximized
          ? { left: 0, top: 0, width: '100%', height: '100%', zIndex: 5 }
          : {
              left: cssLen(box.x),
              top: cssLen(box.y),
              width: cssLen(box.w),
              height: cssLen(box.h),
            }
      }
    >
      <ChartView id={chartId} />
    </div>
  );
}
