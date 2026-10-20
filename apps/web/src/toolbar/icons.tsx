import type { ReactElement, ReactNode } from 'react';

/** Original line-art icon set for drawing tools: 28x28 grid, 1px strokes on
 * half-pixel coordinates (crisp), anchors drawn as hollow circles. */
export type ToolIcon = (props: { size?: number }) => ReactElement;

const r2 = (n: number) => Math.round(n * 100) / 100;

function mk(body: ReactNode): ToolIcon {
  return function Icon({ size = 28 }) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 28 28"
        fill="none"
        stroke="currentColor"
        strokeWidth={1}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
      >
        {body}
      </svg>
    );
  };
}

/** Hollow anchor point. */
const A = (x: number, y: number) => <circle cx={x} cy={y} r={2} />;
/** Line segment trimmed at either end so it meets an anchor's outline. */
function seg(x1: number, y1: number, x2: number, y2: number, t1 = 2.5, t2 = 2.5) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const l = Math.hypot(dx, dy) || 1;
  const ux = dx / l;
  const uy = dy / l;
  return (
    <path d={`M${r2(x1 + ux * t1)} ${r2(y1 + uy * t1)}L${r2(x2 - ux * t2)} ${r2(y2 - uy * t2)}`} />
  );
}
const P = (d: string) => <path d={d} />;
const D = (d: string) => <path d={d} strokeDasharray="2 2" />;
const Fill = (d: string) => <path d={d} fill="currentColor" stroke="none" />;
const Soft = (d: string) => <path d={d} fill="currentColor" fillOpacity={0.18} stroke="none" />;
const T = (x: number, y: number, s: string) => (
  <text
    x={x}
    y={y}
    fontSize={6}
    fontFamily="inherit"
    fill="currentColor"
    stroke="none"
    textAnchor="middle"
  >
    {s}
  </text>
);

/** Zigzag through anchor points, trimming each segment at the anchors. */
function zig(pts: [number, number][], dashedFrom?: number) {
  return (
    <>
      {pts.map(([x, y], i) => (
        <circle key={`a${i}`} cx={x} cy={y} r={2} />
      ))}
      {pts.slice(1).map(([x, y], i) => {
        const [px, py] = pts[i]!;
        const s = seg(px, py, x, y);
        return dashedFrom !== undefined && i >= dashedFrom ? (
          <g key={`s${i}`} strokeDasharray="2 2">
            {s}
          </g>
        ) : (
          <g key={`s${i}`}>{s}</g>
        );
      })}
    </>
  );
}

// ---------------------------------------------------------------- cursors

export const IconCross = mk(P('M14.5 5v19M5 14.5h19'));
export const IconDot = mk(
  <>
    <circle cx={14.5} cy={14.5} r={2.5} fill="currentColor" stroke="none" />
    <circle cx={14.5} cy={14.5} r={6.5} strokeOpacity={0.35} />
  </>,
);
export const IconArrowCursor = mk(P('M9.5 5.5v15l4-3.5 2.6 6 2.4-1-2.6-5.9 5.1-.6z'));
export const IconEraser = mk(
  <>
    {P('M11.5 22.5l-5-5a1.4 1.4 0 0 1 0-2l9-9a1.4 1.4 0 0 1 2 0l5 5a1.4 1.4 0 0 1 0 2l-9 9z')}
    {P('M9.5 12.5l7 7M11.5 22.5h11')}
  </>,
);

// ---------------------------------------------------------------- lines

export const IconTrendLine = mk(
  <>
    {A(6.5, 21.5)}
    {A(21.5, 6.5)}
    {seg(6.5, 21.5, 21.5, 6.5)}
  </>,
);
export const IconRay = mk(
  <>
    {A(5.5, 21.5)}
    {A(13.5, 13.5)}
    {seg(5.5, 21.5, 13.5, 13.5)}
    {seg(13.5, 13.5, 24, 3, 2.5, 0)}
  </>,
);
export const IconMeasuredLine = mk(
  <>
    {A(5.5, 22.5)}
    {A(17.5, 10.5)}
    {seg(5.5, 22.5, 17.5, 10.5)}
    {P('M16.5 15.5h8v7h-8z')}
    {P('M18.5 18h4M18.5 20.5h2.5')}
  </>,
);
export const IconExtendedLine = mk(
  <>
    {A(10.5, 17.5)}
    {A(17.5, 10.5)}
    {seg(3, 25, 10.5, 17.5, 0, 2.5)}
    {seg(10.5, 17.5, 17.5, 10.5)}
    {seg(17.5, 10.5, 25, 3, 2.5, 0)}
  </>,
);
export const IconTrendAngle = mk(
  <>
    {A(6.5, 20.5)}
    {A(20.5, 8.5)}
    {seg(6.5, 20.5, 20.5, 8.5)}
    {D('M9 20.5h14')}
    {P('M14.5 20.5a8 8 0 0 0-1.9-5.2')}
  </>,
);
export const IconHorizontalLine = mk(
  <>
    {A(14.5, 14.5)}
    {P('M3 14.5h9M17 14.5h9')}
  </>,
);
export const IconHorizontalRay = mk(
  <>
    {A(7.5, 14.5)}
    {P('M10 14.5h16')}
  </>,
);
export const IconVerticalLine = mk(
  <>
    {A(14.5, 14.5)}
    {P('M14.5 3v9M14.5 17v9')}
  </>,
);
export const IconCrossLine = mk(
  <>
    {A(14.5, 14.5)}
    {P('M3 14.5h9M17 14.5h9M14.5 3v9M14.5 17v9')}
  </>,
);

// ---------------------------------------------------------------- channels

export const IconParallelChannel = mk(
  <>
    {A(5.5, 15.5)}
    {A(20.5, 6.5)}
    {A(22.5, 14.5)}
    {seg(5.5, 15.5, 20.5, 6.5)}
    {seg(20.5, 6.5, 25, 3.8, 2.5, 0)}
    {seg(4, 25.4, 22.5, 14.5, 0, 2.5)}
  </>,
);
export const IconRegressionTrend = mk(
  <>
    {A(5.5, 17.5)}
    {A(22.5, 10.5)}
    {seg(5.5, 17.5, 22.5, 10.5)}
    {D('M4 12.5l20-8.2M4 24.2l20-8.2')}
  </>,
);
export const IconFlatChannel = mk(
  <>
    {A(5.5, 22.5)}
    {A(21.5, 14.5)}
    {seg(5.5, 22.5, 21.5, 14.5)}
    {A(14.5, 6.5)}
    {P('M3 6.5h9M17 6.5h9')}
  </>,
);
export const IconSplitChannel = mk(
  <>
    {A(5.5, 9.5)}
    {A(21.5, 4.5)}
    {seg(5.5, 9.5, 21.5, 4.5)}
    {A(5.5, 18.5)}
    {A(21.5, 24.5)}
    {seg(5.5, 18.5, 21.5, 24.5)}
  </>,
);

// ---------------------------------------------------------------- pitchforks

function pitchfork(hx: number, hy: number, inner = false) {
  return mk(
    <>
      {A(hx, hy)}
      {A(14.5, 6.5)}
      {A(14.5, 22.5)}
      {seg(14.5, 6.5, 14.5, 22.5)}
      {seg(hx, hy, 14.5, 14.5, 2.5, 0)}
      {P('M14.5 14.5H25')}
      {seg(14.5, 6.5, 25, 6.5, 2.5, 0)}
      {seg(14.5, 22.5, 25, 22.5, 2.5, 0)}
      {inner ? D('M14.5 10.5H25M14.5 18.5H25') : null}
    </>,
  );
}
export const IconPitchfork = pitchfork(4.5, 14.5);
export const IconSchiffPitchfork = mk(
  <>
    {A(4.5, 22.5)}
    {A(14.5, 6.5)}
    {A(14.5, 22.5)}
    {seg(14.5, 6.5, 14.5, 22.5)}
    {D('M6.5 18.5L14.5 14.5')}
    {P('M14.5 14.5L25 9.2')}
    {seg(14.5, 6.5, 25, 1.2, 2.5, 0)}
    {seg(14.5, 22.5, 25, 17.2, 2.5, 0)}
    {seg(4.5, 22.5, 12, 22.5)}
  </>,
);
export const IconModifiedSchiffPitchfork = mk(
  <>
    {A(4.5, 18.5)}
    {A(14.5, 6.5)}
    {A(14.5, 22.5)}
    {seg(14.5, 6.5, 14.5, 22.5)}
    {D('M6.8 17.4L14.5 14.5')}
    {P('M14.5 14.5L25 10.5')}
    {seg(14.5, 6.5, 25, 2.5, 2.5, 0)}
    {seg(14.5, 22.5, 25, 18.5, 2.5, 0)}
  </>,
);
export const IconInnerPitchfork = pitchfork(4.5, 14.5, true);

// ---------------------------------------------------------------- fibonacci

export const IconFibRetracement = mk(
  <>
    {P('M3 4.5h22M3 10.5h22M3 17.5h22M3 23.5h22')}
    {A(6.5, 23.5)}
    {A(21.5, 4.5)}
    {D('M8 21.5L20 6.5')}
  </>,
);
export const IconFibExtension = mk(
  <>
    {P('M14 5.5h11M14 11.5h11M14 17.5h11')}
    {zig(
      [
        [4.5, 22.5],
        [9.5, 9.5],
        [14.5, 22.5],
      ],
      0,
    )}
  </>,
);
export const IconFibChannel = mk(
  <>
    {A(4.5, 12.5)}
    {A(17.5, 4.5)}
    {seg(4.5, 12.5, 17.5, 4.5)}
    {P('M3 18.5L25 5M3 22.5L25 9M5 25.5L25 13.2')}
  </>,
);
export const IconFibTimeZone = mk(
  <>
    {P('M4.5 4v20M7.5 4v20M10.5 4v20M15.5 4v20M23.5 4v20')}
    {P('M3 24.5h22')}
  </>,
);
export const IconFibFan = mk(
  <>
    {A(5.5, 22.5)}
    {seg(5.5, 22.5, 24, 4, 2.5, 0)}
    {seg(5.5, 22.5, 24, 10, 2.5, 0)}
    {seg(5.5, 22.5, 24, 16, 2.5, 0)}
    {seg(5.5, 22.5, 12, 4, 2.5, 0)}
    {D('M24 4v18.5M8 22.5h16')}
  </>,
);
export const IconFibTimeExtension = mk(
  <>
    {P('M17.5 4v20M21.5 4v20M24.5 4v20')}
    {zig(
      [
        [4.5, 20.5],
        [9.5, 8.5],
        [14.5, 16.5],
      ],
      0,
    )}
  </>,
);
export const IconFibCircles = mk(
  <>
    {A(14.5, 14.5)}
    <circle cx={14.5} cy={14.5} r={5.5} />
    <circle cx={14.5} cy={14.5} r={9.5} />
    <circle cx={14.5} cy={14.5} r={12} strokeDasharray="2 2" />
  </>,
);
export const IconFibSpiral = mk(
  P(
    'M15.5 15a1.5 1.5 0 0 1-2-1a2.5 2.5 0 0 1 2.5-2.5a4 4 0 0 1 4 4a6.5 6.5 0 0 1-6.5 6.5a10 10 0 0 1-10-10a14 14 0 0 1 9-13',
  ),
);
export const IconFibArcs = mk(
  <>
    {A(5.5, 22.5)}
    {P(
      'M5.5 15a7.5 7.5 0 0 1 7.5 7.5M5.5 10a12.5 12.5 0 0 1 12.5 12.5M5.5 5a17.5 17.5 0 0 1 17.5 17.5',
    )}
    {D('M8 22.5h16')}
  </>,
);
export const IconFibSector = mk(
  <>
    {A(4.5, 14.5)}
    {seg(4.5, 14.5, 24, 5, 2.5, 0)}
    {seg(4.5, 14.5, 24, 24, 2.5, 0)}
    {P('M12.5 10.6a9 9 0 0 1 0 7.8M17.5 8.2a14.5 14.5 0 0 1 0 12.6M22.5 5.8a20 20 0 0 1 0 17.4')}
  </>,
);
export const IconForkFan = mk(
  <>
    {A(4.5, 14.5)}
    {A(16.5, 6.5)}
    {A(16.5, 22.5)}
    {seg(16.5, 6.5, 16.5, 22.5)}
    {seg(4.5, 14.5, 25, 14.5, 2.5, 0)}
    {seg(4.5, 14.5, 25, 3, 2.5, 0)}
    {seg(4.5, 14.5, 25, 26, 2.5, 0)}
  </>,
);

// ---------------------------------------------------------------- gann

export const IconGannBox = mk(
  <>
    {P('M4.5 6.5h19v15h-19z')}
    {D('M9.5 6.5v15M14.5 6.5v15M18.5 6.5v15M4.5 11.5h19M4.5 16.5h19')}
  </>,
);
export const IconGannGrid = mk(
  <>
    {P('M5.5 5.5h17v17h-17z')}
    {P('M5.5 22.5l17-17M5.5 5.5l17 17')}
  </>,
);
export const IconGannSquare = mk(
  <>
    {P('M5.5 5.5h17v17h-17z')}
    {P('M5.5 22.5l17-17')}
    {D('M11.5 5.5v17M16.5 5.5v17M5.5 11.5h17M5.5 16.5h17')}
  </>,
);
export const IconGannFan = mk(
  <>
    {A(5.5, 22.5)}
    {seg(5.5, 22.5, 24, 4, 2.5, 0)}
    {seg(5.5, 22.5, 24, 13, 2.5, 0)}
    {seg(5.5, 22.5, 24, 19, 2.5, 0)}
    {seg(5.5, 22.5, 14, 4, 2.5, 0)}
    {seg(5.5, 22.5, 9, 4, 2.5, 0)}
  </>,
);

// ---------------------------------------------------------------- patterns

export const IconXabcd = mk(
  <>
    {Soft('M4.5 20.5L9.5 7.5L14.5 15.5zM14.5 15.5L19.5 6.5L24.5 21.5z')}
    {zig([
      [4.5, 20.5],
      [9.5, 7.5],
      [14.5, 15.5],
      [19.5, 6.5],
      [24.5, 21.5],
    ])}
  </>,
);
export const IconCypher = mk(
  <>
    {Soft('M3.5 21.5L9.5 9.5L13.5 15.5zM13.5 15.5L18.5 4.5L24.5 17.5z')}
    {zig([
      [3.5, 21.5],
      [9.5, 9.5],
      [13.5, 15.5],
      [18.5, 4.5],
      [24.5, 17.5],
    ])}
  </>,
);
export const IconHeadShoulders = mk(
  <>
    {P('M2.5 21.5l4-9 3.5 6 4.5-12.5 4.5 12.5 3.5-6 4 9')}
    {D('M4 18.5h20')}
  </>,
);
export const IconAbcd = mk(
  zig([
    [5.5, 21.5],
    [11.5, 8.5],
    [16.5, 16.5],
    [22.5, 5.5],
  ]),
);
export const IconTrianglePattern = mk(
  <>
    {D('M3.5 5.5L24.5 13.5M3.5 23.5L24.5 15.5')}
    {zig([
      [4.5, 6.5],
      [9.5, 21.5],
      [15.5, 10.5],
      [21.5, 17.5],
    ])}
  </>,
);
export const IconThreeDrives = mk(P('M3.5 23.5l4-8 2.5 3.5 4.5-9 2.5 3.5 5-9.5'));

function elliott(pts: [number, number][], labels: string[]) {
  return mk(
    <>
      {P(`M${pts.map(([x, y]) => `${x} ${y}`).join('L')}`)}
      {labels.map((l, i) => {
        const p = pts[i + 1];
        const prev = pts[i];
        if (!p || !prev) return null;
        const peak = p[1] < prev[1];
        return <g key={i}>{T(p[0], peak ? p[1] - 2.5 : p[1] + 6, l)}</g>;
      })}
    </>,
  );
}
export const IconElliottImpulse = elliott(
  [
    [3, 21],
    [8, 15],
    [11, 19],
    [17, 11],
    [20, 15],
    [25, 9],
  ],
  ['1', '2', '3', '4', '5'],
);
export const IconElliottCorrection = elliott(
  [
    [4, 9],
    [11, 19],
    [16, 12],
    [24, 21],
  ],
  ['A', 'B', 'C'],
);
export const IconElliottTriangle = elliott(
  [
    [3, 9],
    [8, 20],
    [13, 11],
    [17, 18],
    [21, 13],
    [25, 16],
  ],
  ['A', 'B', 'C', 'D', 'E'],
);
export const IconElliottDoubleCombo = elliott(
  [
    [3, 9],
    [10, 18],
    [16, 12],
    [24, 20],
  ],
  ['W', 'X', 'Y'],
);
export const IconElliottTripleCombo = elliott(
  [
    [2, 9],
    [7, 17],
    [11, 11],
    [16, 19],
    [20, 13],
    [25, 21],
  ],
  ['W', 'X', 'Y', 'X', 'Z'],
);

// ---------------------------------------------------------------- cycles

export const IconCycleLines = mk(
  <>
    {A(5.5, 14.5)}
    {A(11.5, 14.5)}
    {P('M5.5 4v8M5.5 17v8M11.5 4v8M11.5 17v8M17.5 4v21M23.5 4v21')}
    {seg(5.5, 14.5, 11.5, 14.5)}
  </>,
);
export const IconCycleArcs = mk(
  <>
    {P('M3 20.5h22')}
    {P('M4.5 20.5a5 5 0 0 1 10 0a5 5 0 0 1 10 0')}
    {A(4.5, 20.5)}
    {A(14.5, 20.5)}
  </>,
);
export const IconSineWave = mk(P('M2.5 14.5c2.5-9.5 5.5-9.5 8 0s5.5 9.5 8 0 4-6.5 7-5'));

// ---------------------------------------------------------------- forecasting

export const IconLongPosition = mk(
  <>
    {Soft('M5.5 5.5h17v11h-17z')}
    {P('M5.5 5.5h17v17h-17z')}
    {P('M5.5 16.5h17')}
    {P('M14.5 13v-5M12 10.5l2.5-2.5 2.5 2.5')}
  </>,
);
export const IconShortPosition = mk(
  <>
    {Soft('M5.5 11.5h17v11h-17z')}
    {P('M5.5 5.5h17v17h-17z')}
    {P('M5.5 11.5h17')}
    {P('M14.5 15v5M12 17.5l2.5 2.5 2.5-2.5')}
  </>,
);
export const IconPriceTarget = mk(
  <>
    {A(5.5, 20.5)}
    {A(14.5, 12.5)}
    {seg(5.5, 20.5, 14.5, 12.5)}
    {D('M16.5 11l7-5.5')}
    <circle cx={23.5} cy={5.5} r={1.5} fill="currentColor" stroke="none" />
    {D('M16.5 13.5h7')}
  </>,
);
export const IconBarReplica = mk(
  <>
    {P('M6.5 9v12M4.5 12.5h2M6.5 17.5h2M12.5 6v11M10.5 8.5h2M12.5 14.5h2')}
    {D('M17.5 5.5h8v17h-8z')}
    {P('M21.5 9v10')}
  </>,
);
export const IconPathSketch = mk(
  <>
    {P('M5.5 9.5h3v9h-3zM7 7v2.5M7 18.5v3')}
    <g strokeDasharray="1.5 1.5">
      {P('M12.5 7.5h3v8h-3zM19.5 11.5h3v8h-3zM14 5v2.5M21 9v2.5M21 19.5v3')}
    </g>
  </>,
);
export const IconSwingProjection = mk(
  <>
    {A(5.5, 21.5)}
    {A(19.5, 8.5)}
    {seg(5.5, 21.5, 19.5, 8.5)}
    {D('M19.5 11v11.5M8 21.5h11.5')}
    {P('M13.5 21.5a8 8 0 0 0-2.4-5.6')}
  </>,
);

// ---------------------------------------------------------------- volume

export const IconAnchoredVwap = mk(
  <>
    {A(5.5, 21.5)}
    {P('M7.5 20c4-3 5-8 9-9.5s5-1 8-4')}
    {D('M5.5 4v15')}
  </>,
);
export const IconRangeVp = mk(
  <>
    {P('M4.5 4v21M23.5 4v21')}
    {P('M4.5 7.5h6M4.5 10.5h10M4.5 13.5h15M4.5 16.5h11M4.5 19.5h7M4.5 22.5h4')}
  </>,
);
export const IconAnchoredVp = mk(
  <>
    {A(5.5, 24.5)}
    {P('M5.5 4v18')}
    {P('M5.5 6.5h5M5.5 9.5h9M5.5 12.5h14M5.5 15.5h10M5.5 18.5h6')}
  </>,
);

// ---------------------------------------------------------------- measurers

export const IconPriceMeasure = mk(
  <>
    {P('M6 5.5h16M6 22.5h16M14.5 7v14')}
    {P('M12 9.5l2.5-2.5 2.5 2.5M12 18.5l2.5 2.5 2.5-2.5')}
  </>,
);
export const IconTimeMeasure = mk(
  <>
    {P('M5.5 6v16M22.5 6v16M7 14.5h14')}
    {P('M9.5 12l-2.5 2.5 2.5 2.5M18.5 12l2.5 2.5-2.5 2.5')}
  </>,
);
export const IconPriceTimeMeasure = mk(
  <>
    {P('M5.5 5.5h17v17h-17z')}
    {P('M14.5 8v13M8 14.5h13')}
    {P('M12.5 10l2-2 2 2M19 12.5l2 2-2 2')}
  </>,
);

// ---------------------------------------------------------------- brushes / arrows

export const IconBrush = mk(
  <>
    {P('M21.5 4.5l2 2-9 10-2-2z')}
    {P('M12.5 14.5c-3 0-4.5 2-4.5 4s-1 3.5-3.5 4c4 1.5 9 .5 10-3.5')}
  </>,
);
export const IconHighlighter = mk(
  <>
    {P('M17.5 4.5l6 6-8 8-6-6z')}
    {P('M9.5 12.5l-1 5 2 2 5-1')}
    {P('M8.5 19.5l-4 4h6')}
  </>,
);
export const IconArrowPointer = mk(P('M5.5 18.5l9-9-2.5-2.5h10v10l-2.5-2.5-9 9z'));
export const IconArrowLine = mk(
  <>
    {A(5.5, 22.5)}
    {seg(5.5, 22.5, 22.5, 5.5, 2.5, 0.5)}
    {P('M15.5 6h7v7')}
  </>,
);
export const IconUpMarker = mk(P('M14.5 5.5l7 8h-4v9h-6v-9h-4z'));
export const IconDownMarker = mk(P('M14.5 22.5l7-8h-4v-9h-6v9h-4z'));

// ---------------------------------------------------------------- shapes

export const IconRectangle = mk(
  <>
    {P('M5.5 8.5h17v11h-17z')}
    {A(5.5, 8.5)}
    {A(22.5, 19.5)}
  </>,
);
export const IconRotatedRectangle = mk(P('M10.5 3.5l14 8-6 11-14-8z'));
export const IconPath = mk(
  <>
    {P('M4.5 22.5l6-9 7 4 5-11')}
    {P('M19.5 8l3-1.5 1 3.2')}
  </>,
);
export const IconCircle = mk(
  <>
    <circle cx={14.5} cy={14.5} r={9} />
    {A(14.5, 14.5)}
  </>,
);
export const IconEllipse = mk(<ellipse cx={14.5} cy={14.5} rx={10.5} ry={6.5} />);
export const IconPolyline = mk(<>{P('M5.5 18.5l5-11 8 3 5 10-11 2z')}</>);
export const IconTriangle = mk(P('M14.5 5.5l9.5 17h-19z'));
export const IconArc = mk(
  <>
    {A(5.5, 20.5)}
    {A(23.5, 20.5)}
    {P('M6.5 18.3C9 9 20 9 22.5 18.3')}
  </>,
);
export const IconCurve = mk(
  <>
    {A(4.5, 21.5)}
    {A(23.5, 21.5)}
    {P('M6.3 20C10 4 18 4 21.7 20')}
  </>,
);
export const IconSCurve = mk(
  <>
    {A(4.5, 14.5)}
    {A(23.5, 14.5)}
    {P('M6.8 13.5C9 4 12 6 14 14.5S19 25 21.2 15.5')}
  </>,
);

// ---------------------------------------------------------------- annotation

export const IconText = mk(P('M7.5 7.5v-2h13v2M14 5.5v17M11 22.5h6'));
export const IconPinnedText = mk(
  <>
    {P('M9.5 6.5v-1.5h11v1.5M15 5v12M12.5 17h5')}
    {A(7.5, 22.5)}
    {D('M9.5 21l3-3')}
  </>,
);
export const IconNote = mk(
  <>
    {P('M5.5 5.5h17v12l-5 5h-12z')}
    {P('M17.5 22.5v-5h5')}
    {P('M9 10h10M9 13.5h7')}
  </>,
);
export const IconPinnedNote = mk(
  <>
    {P('M8.5 4.5h15v10l-4 4h-11z')}
    {P('M19.5 18.5v-4h4M11.5 8.5h8M11.5 11.5h5')}
    {A(5.5, 22.5)}
  </>,
);
export const IconCallout = mk(P('M4.5 5.5h19v12h-11l-5 5v-5h-3z'));
export const IconComment = mk(
  P(
    'M14.5 5.5c5.5 0 9.5 3.4 9.5 7.5s-4 7.5-9.5 7.5c-1.2 0-2.4-.2-3.5-.5l-5 2.5 1.5-4c-1.6-1.4-2.5-3.3-2.5-5.5 0-4.1 4-7.5 9.5-7.5z',
  ),
);
export const IconPriceLabel = mk(
  <>
    {P('M4.5 9.5h14l5 5-5 5h-14z')}
    <circle cx={18.5} cy={14.5} r={1} fill="currentColor" stroke="none" />
  </>,
);
export const IconPriceTag = mk(
  <>
    {A(5.5, 21.5)}
    {seg(5.5, 21.5, 13.5, 12.5, 2.5, 0)}
    {P('M13.5 8.5h11v8h-11z')}
  </>,
);
export const IconPin = mk(
  <>
    {P('M14.5 3.5v21M10.5 24.5h8')}
    {P('M8.5 6.5h12l3 3-3 3h-12z')}
  </>,
);
export const IconFlag = mk(
  <>
    {P('M7.5 24.5v-20')}
    {P('M7.5 5.5c4-2 7 2 13 0v9c-6 2-9-2-13 0')}
  </>,
);
export const IconTable = mk(
  <>
    {P('M4.5 6.5h19v15h-19z')}
    {P('M4.5 11.5h19M4.5 16.5h19M11.5 6.5v15M17.5 6.5v15')}
  </>,
);
export const IconImage = mk(
  <>
    {P('M4.5 6.5h19v15h-19z')}
    {P('M4.5 19.5l6-6 4 4 3-3 6 6')}
    <circle cx={18.5} cy={10.5} r={1.5} />
  </>,
);

// ---------------------------------------------------------------- misc / actions

export const IconSmile = mk(
  <>
    <circle cx={14.5} cy={14.5} r={9} />
    {P('M10.5 16.5c1 2 2.5 3 4 3s3-1 4-3')}
    <circle cx={11.5} cy={12} r={1} fill="currentColor" stroke="none" />
    <circle cx={17.5} cy={12} r={1} fill="currentColor" stroke="none" />
  </>,
);
export const IconRuler = mk(
  <>
    {P('M3.5 18.5l15-15 6 6-15 15z')}
    {P('M7.5 14.5l2 2M10.5 11.5l3 3M13.5 8.5l2 2M16.5 5.5l3 3')}
  </>,
);
export const IconZoomIn = mk(
  <>
    <circle cx={12.5} cy={12.5} r={7} />
    {P('M17.5 17.5l6 6M12.5 9.5v6M9.5 12.5h6')}
  </>,
);
const magnetBody = P('M7.5 5.5h4v9a3 3 0 0 0 6 0v-9h4v9a7 7 0 0 1-14 0z');
export const IconMagnet = mk(
  <>
    {magnetBody}
    {P('M7.5 9.5h4M17.5 9.5h4')}
  </>,
);
export const IconMagnetStrong = mk(
  <>
    {Soft('M7.5 5.5h4v4h-4zM17.5 5.5h4v4h-4z')}
    {magnetBody}
    {P('M7.5 9.5h4M17.5 9.5h4')}
    {P('M4 3.5l1.5 1.5M24.5 5l1.5-1.5')}
  </>,
);
export const IconStayDrawing = mk(
  <>
    {P('M17.5 5.5l4 4-10 10-5 1 1-5z')}
    {P('M15.5 7.5l4 4')}
    {P('M17.5 19.5h7v5h-7zM19 19.5v-1.5a2 2 0 0 1 4 0v1.5')}
  </>,
);
/** Two linked chain rings: new drawings synced to all symbols. */
export const IconSyncDrawings = mk(
  <>
    {P('M12.5 16.5l4-4')}
    {P('M11 13.5l-2 2a3.5 3.5 0 0 0 5 5l2-2')}
    {P('M18 15.5l2-2a3.5 3.5 0 0 0-5-5l-2 2')}
  </>,
);
export const IconLock = mk(
  <>
    {P('M8.5 13.5h12v10h-12z')}
    {P('M10.5 13.5v-3a4 4 0 0 1 8 0v3M14.5 17.5v2')}
  </>,
);
export const IconUnlock = mk(
  <>
    {P('M8.5 13.5h12v10h-12z')}
    {P('M10.5 13.5v-3a4 4 0 0 1 7.7-1.5M14.5 17.5v2')}
  </>,
);
export const IconEye = mk(
  <>
    {P('M3.5 14.5c2.5-5 6.5-7.5 11-7.5s8.5 2.5 11 7.5c-2.5 5-6.5 7.5-11 7.5s-8.5-2.5-11-7.5z')}
    <circle cx={14.5} cy={14.5} r={3.5} />
  </>,
);
export const IconEyeOff = mk(
  <>
    {P('M7.3 9.4c-1.5 1.3-2.8 3-3.8 5.1 2.5 5 6.5 7.5 11 7.5 1.9 0 3.7-.5 5.3-1.4')}
    {P('M11.5 7.5c1-.3 2-.5 3-.5 4.5 0 8.5 2.5 11 7.5-.7 1.4-1.6 2.7-2.6 3.8')}
    {P('M12 12a3.5 3.5 0 0 0 5 5M5.5 5.5l18 18')}
  </>,
);
export const IconTrash = mk(
  <>
    {P('M5.5 8.5h18M11.5 8.5v-3h6v3')}
    {P('M7.5 8.5l1 15h12l1-15')}
    {P('M12.5 12v8M16.5 12v8')}
  </>,
);
export const IconStar = mk(
  P('M14.5 4.5l2.9 6.2 6.6.8-4.9 4.5 1.3 6.5-5.9-3.3-5.9 3.3 1.3-6.5-4.9-4.5 6.6-.8z'),
);
export const IconStarFilled = mk(
  Fill('M14.5 4.5l2.9 6.2 6.6.8-4.9 4.5 1.3 6.5-5.9-3.3-5.9 3.3 1.3-6.5-4.9-4.5 6.6-.8z'),
);
