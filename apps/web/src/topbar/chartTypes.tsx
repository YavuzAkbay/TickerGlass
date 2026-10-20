import type { ComponentType, ReactNode } from 'react';
import type { ChartType } from '@investopen/engine';

type IconProps = { size?: number };

/** Small 24x24 line icon in the lucide style (currentColor, 1.5 stroke). */
function icon(children: ReactNode): ComponentType<IconProps> {
  return function ChartTypeIcon({ size = 18 }: IconProps) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
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

const BarsIcon = icon(
  <>
    <path d="M8 4v15M5 7h3M8 15h3" />
    <path d="M16 6v14M13 10h3M16 17h3" />
  </>,
);
const CandlesIcon = icon(
  <>
    <path d="M8 3v3M8 16v4M16 5v4M16 18v2" />
    <rect x="5.5" y="6" width="5" height="10" rx="0.5" fill="currentColor" />
    <rect x="13.5" y="9" width="5" height="9" rx="0.5" />
  </>,
);
const HollowCandlesIcon = icon(
  <>
    <path d="M8 3v3M8 16v4M16 5v4M16 18v2" />
    <rect x="5.5" y="6" width="5" height="10" rx="0.5" />
    <rect x="13.5" y="9" width="5" height="9" rx="0.5" />
  </>,
);
const VolumeCandlesIcon = icon(
  <>
    <path d="M7 4v3M7 15v4M16.5 6v3M16.5 17v3" />
    <rect x="5" y="7" width="4" height="8" rx="0.5" fill="currentColor" />
    <rect x="12.5" y="9" width="8" height="8" rx="0.5" />
  </>,
);
const LineIcon = icon(<path d="M3 17l5-6 4 3 5-7 4 4" />);
const LineMarkersIcon = icon(
  <>
    <path d="M4 17l4-6 4 3 5-7 3 4" />
    <circle cx="4" cy="17" r="1.4" fill="currentColor" />
    <circle cx="8" cy="11" r="1.4" fill="currentColor" />
    <circle cx="12" cy="14" r="1.4" fill="currentColor" />
    <circle cx="17" cy="7" r="1.4" fill="currentColor" />
    <circle cx="20" cy="11" r="1.4" fill="currentColor" />
  </>,
);
const StepLineIcon = icon(<path d="M3 17h4v-5h5v3h4V7h5" />);
const AreaIcon = icon(
  <>
    <path d="M3 16l5-6 4 3 5-7 4 4v10H3z" fill="currentColor" fillOpacity={0.25} stroke="none" />
    <path d="M3 16l5-6 4 3 5-7 4 4" />
  </>,
);
const HlcAreaIcon = icon(
  <>
    <path
      d="M3 10l5-4 4 2 5-4 4 2v6l-4-2-5 4-4-2-5 4z"
      fill="currentColor"
      fillOpacity={0.2}
      stroke="none"
    />
    <path d="M3 10l5-4 4 2 5-4 4 2" />
    <path d="M3 14l5-4 4 2 5-4 4 2" strokeDasharray="1.5 2" />
    <path d="M3 18l5-4 4 2 5-4 4 2" />
  </>,
);
const BaselineIcon = icon(
  <>
    <path d="M3 12h18" strokeDasharray="2 2" />
    <path d="M3 16l4-2 3-6 4 9 3-3 4-7" />
  </>,
);
const ColumnsIcon = icon(
  <>
    <path d="M5 20v-7M9 20V9M13 20v-5M17 20V6M21 20v-9" strokeWidth={2.5} strokeLinecap="butt" />
  </>,
);
const HighLowIcon = icon(
  <>
    <path d="M6 6v9M12 9v10M18 4v8" strokeWidth={2.5} strokeLinecap="butt" />
  </>,
);
const HeikinAshiIcon = icon(
  <>
    <path d="M6 4v2M6 14v3M12 7v2M12 16v2M18 9v2M18 18v2" />
    <rect x="4" y="6" width="4" height="8" rx="0.5" />
    <rect x="10" y="9" width="4" height="7" rx="0.5" fill="currentColor" />
    <rect x="16" y="11" width="4" height="7" rx="0.5" fill="currentColor" />
  </>,
);
const RenkoIcon = icon(
  <>
    <rect x="3" y="15" width="5" height="4" />
    <rect x="8" y="11" width="5" height="4" />
    <rect x="13" y="7" width="5" height="4" fill="currentColor" />
    <rect x="18" y="3" width="3" height="4" fill="currentColor" />
  </>,
);
const LineBreakIcon = icon(
  <>
    <rect x="3" y="12" width="5" height="7" />
    <rect x="9.5" y="7" width="5" height="9" fill="currentColor" />
    <rect x="16" y="4" width="5" height="7" />
  </>,
);
const KagiIcon = icon(
  <>
    <path d="M4 20v-8h4v4h4V6" />
    <path d="M12 6h4v8h4V4" strokeWidth={2.5} />
  </>,
);
const PointFigureIcon = icon(
  <>
    <path d="M4 15l3 3M7 15l-3 3M4 10l3 3M7 10l-3 3" />
    <circle cx="12" cy="9" r="1.8" />
    <circle cx="12" cy="14" r="1.8" />
    <path d="M17 5l3 3M20 5l-3 3M17 10l3 3M20 10l-3 3" />
  </>,
);
const RangeIcon = icon(
  <>
    <path d="M6 9v8M3.5 11H6M6 15h2.5" />
    <path d="M12 6v8M9.5 8H12M12 12h2.5" />
    <path d="M18 3v8M15.5 5H18M18 9h2.5" />
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
