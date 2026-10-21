import type { ComponentType, ReactNode } from 'react';
import type { ChartType } from '@tickerglass/engine';

type IconProps = { size?: number };

/** 20x20 line icon (currentColor, 1.5 stroke, round caps and joins, no fills except anchor dots). */
function icon(children: ReactNode): ComponentType<IconProps> {
  return function ChartTypeIcon({ size = 18 }: IconProps) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 20 20"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {children}
      </svg>
    );
  };
}

const dot = (x: number, y: number) => (
  <circle key={`${x}-${y}`} cx={x} cy={y} r={1.5} fill="currentColor" stroke="none" />
);

const BarsIcon = icon(<path d="M6 3v14M3 6h3M6 13h3M14 4v13M11 8h3M14 15h3" />);
const CandlesIcon = icon(
  <>
    <path d="M6 2.5v3M6 14v3.5M14 4v2.5M14 15v2" />
    <rect x="4" y="5.5" width="4" height="8.5" rx="1" />
    <rect x="12" y="6.5" width="4" height="8.5" rx="1" />
  </>,
);
const HollowCandlesIcon = icon(
  <>
    <path d="M6 2.5v3M6 14v3.5M14 4v2.5M14 15v2" />
    <rect x="4" y="5.5" width="4" height="8.5" rx="1" />
    <path d="M12 6.5h4v8.5h-4z" strokeDasharray="2 1.5" />
  </>,
);
const VolumeCandlesIcon = icon(
  <>
    <path d="M5 3v2.5M5 13v3.5M13.5 4v2M13.5 14v3" />
    <rect x="3.5" y="5.5" width="3" height="7.5" rx="0.8" />
    <rect x="10" y="6" width="7" height="8" rx="0.8" />
  </>,
);
const LineIcon = icon(<path d="M2.5 14l4.5-5 3.5 2.5L17.5 4.5" />);
const LineMarkersIcon = icon(
  <>
    <path d="M3 14l4-5 3.5 2.5 6.5-7" />
    {dot(3, 14)}
    {dot(7, 9)}
    {dot(10.5, 11.5)}
    {dot(17, 4.5)}
  </>,
);
const StepLineIcon = icon(<path d="M2.5 14.5h4v-5h4v3h3v-8h4" />);
const AreaIcon = icon(<path d="M2.5 17V12l4.5-4.5 3.5 2.5 7-6.5V17z" />);
const HlcAreaIcon = icon(
  <>
    <path d="M2.5 8l4.5-3.5 3.5 2 7-3.5" />
    <path d="M2.5 15l4.5-3.5 3.5 2 7-3.5" />
    <path d="M2.5 8v7M17.5 3v7" />
  </>,
);
const BaselineIcon = icon(
  <>
    <path d="M2.5 10h15" strokeDasharray="2 2" />
    <path d="M2.5 14l3.5-2.5 3-5 3.5 7.5 2-2 3-4" />
  </>,
);
const ColumnsIcon = icon(<path d="M4 17V11M8 17V7M12 17V12M16 17V4" strokeWidth={2.5} />);
const HighLowIcon = icon(
  <>
    <path d="M5 5v9M10 7.5v9M15 3.5v8" />
    <path d="M3.5 5h3M8.5 7.5h3M13.5 3.5h3" />
  </>,
);
const HeikinAshiIcon = icon(
  <>
    <path d="M4.5 3v2M4.5 12.5v3M10 6v2M10 14v2.5M15.5 8v1.5M15.5 16v2" />
    <rect x="3" y="5" width="3" height="7.5" rx="0.8" />
    <rect x="8.5" y="8" width="3" height="6" rx="0.8" />
    <rect x="14" y="9.5" width="3" height="6.5" rx="0.8" />
  </>,
);
const RenkoIcon = icon(
  <>
    <rect x="2.5" y="12" width="4.5" height="4" rx="0.8" />
    <rect x="7" y="8" width="4.5" height="4" rx="0.8" />
    <rect x="11.5" y="4" width="4.5" height="4" rx="0.8" />
  </>,
);
const LineBreakIcon = icon(
  <>
    <rect x="2.5" y="10" width="4" height="7" rx="0.8" />
    <rect x="8" y="6" width="4" height="8" rx="0.8" />
    <rect x="13.5" y="3" width="4" height="6" rx="0.8" />
  </>,
);
const KagiIcon = icon(<path d="M3.5 17v-7h5v4h4V4h4" />);
const PointFigureIcon = icon(
  <>
    <path d="M3.5 3.5l3 3M6.5 3.5l-3 3M3.5 9l3 3M6.5 9l-3 3" />
    <circle cx="12" cy="7" r="2" />
    <circle cx="12" cy="13.5" r="2" />
    <path d="M15.5 3.5l2 2M17.5 3.5l-2 2" />
  </>,
);
const RangeIcon = icon(
  <>
    <path d="M5 8v8M3 9.5h2M5 14h2" />
    <path d="M10 4v8M8 5.5h2M10 10h2" />
    <path d="M15 2.5v8M13 4h2M15 8.5h2" />
  </>,
);

export interface ChartTypeDef {
  id: ChartType;
  label: string;
  icon: ComponentType<IconProps>;
}

/** Chart styles in menu order. `null` marks a group separator. */
export const CHART_TYPE_MENU: (ChartTypeDef | null)[] = [
  { id: 'bars', label: 'Bars', icon: BarsIcon },
  { id: 'candles', label: 'Candles', icon: CandlesIcon },
  { id: 'hollowCandles', label: 'Hollow candles', icon: HollowCandlesIcon },
  { id: 'volumeCandles', label: 'Volume-width candles', icon: VolumeCandlesIcon },
  null,
  { id: 'line', label: 'Line', icon: LineIcon },
  { id: 'lineMarkers', label: 'Line + dots', icon: LineMarkersIcon },
  { id: 'stepLine', label: 'Step', icon: StepLineIcon },
  null,
  { id: 'area', label: 'Area', icon: AreaIcon },
  { id: 'hlcArea', label: 'Range area', icon: HlcAreaIcon },
  { id: 'baseline', label: 'Baseline split', icon: BaselineIcon },
  null,
  { id: 'columns', label: 'Histogram', icon: ColumnsIcon },
  { id: 'highLow', label: 'High–low bars', icon: HighLowIcon },
  null,
  { id: 'heikinAshi', label: 'Heikin Ashi', icon: HeikinAshiIcon },
  null,
  { id: 'renko', label: 'Renko', icon: RenkoIcon },
  { id: 'lineBreak', label: 'Line break', icon: LineBreakIcon },
  { id: 'kagi', label: 'Kagi', icon: KagiIcon },
  { id: 'pointFigure', label: 'Point & figure', icon: PointFigureIcon },
  { id: 'range', label: 'Range', icon: RangeIcon },
];

export function chartTypeDef(id: ChartType): ChartTypeDef | undefined {
  return CHART_TYPE_MENU.find((t): t is ChartTypeDef => !!t && t.id === id);
}
