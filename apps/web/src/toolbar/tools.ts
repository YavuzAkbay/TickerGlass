import type { CrosshairMode } from '@investopen/engine';
import { useAppStore } from '../store/app';
import { useUiStore, type DrawingToolId } from '../store/ui';
import * as I from './icons';
import type { ToolIcon } from './icons';

export interface ToolDef {
  id: DrawingToolId;
  name: string;
  icon: ToolIcon;
  /** Command shortcut, e.g. "Alt+t". */
  shortcut?: string;
  /** Command id registered for the shortcut. */
  commandId?: string;
}

export interface ToolSection {
  title?: string;
  tools: ToolDef[];
}

export interface ToolGroup {
  id: string;
  label: string;
  sections: ToolSection[];
}

const t = (
  id: string,
  name: string,
  icon: ToolIcon,
  shortcut?: string,
  commandId?: string,
): ToolDef => ({
  id,
  name,
  icon,
  ...(shortcut ? { shortcut } : {}),
  ...(commandId ? { commandId } : {}),
});

export const CURSOR_IDS = ['cross', 'dot', 'arrow'] as const;

export const TOOL_GROUPS: ToolGroup[] = [
  {
    id: 'cursors',
    label: 'Cursors',
    sections: [
      {
        tools: [
          t('cross', 'Cross', I.IconCross),
          t('dot', 'Dot', I.IconDot),
          t('arrow', 'Arrow', I.IconArrowCursor),
          t('eraser', 'Eraser', I.IconEraser),
        ],
      },
    ],
  },
  {
    id: 'lines',
    label: 'Trend line tools',
    sections: [
      {
        title: 'Lines',
        tools: [
          t('trend-line', 'Trend line', I.IconTrendLine, 'Alt+t', 'tool.trendLine'),
          t('ray', 'Ray', I.IconRay),
          t('info-line', 'Info line', I.IconInfoLine),
          t('extended-line', 'Extended line', I.IconExtendedLine),
          t('trend-angle', 'Trend angle', I.IconTrendAngle),
          t(
            'horizontal-line',
            'Horizontal line',
            I.IconHorizontalLine,
            'Alt+h',
            'tool.horizontalLine',
          ),
          t('horizontal-ray', 'Horizontal ray', I.IconHorizontalRay, 'Alt+j', 'tool.horizontalRay'),
          t('vertical-line', 'Vertical line', I.IconVerticalLine, 'Alt+v', 'tool.verticalLine'),
          t('cross-line', 'Cross line', I.IconCrossLine, 'Alt+c', 'tool.crossLine'),
        ],
      },
      {
        title: 'Channels',
        tools: [
          t('parallel-channel', 'Parallel channel', I.IconParallelChannel),
          t('regression-trend', 'Regression trend', I.IconRegressionTrend),
          t('flat-top-bottom', 'Flat top/bottom', I.IconFlatTopBottom),
          t('disjoint-channel', 'Disjoint channel', I.IconDisjointChannel),
        ],
      },
      {
        title: 'Pitchforks',
        tools: [
          t('pitchfork', 'Pitchfork', I.IconPitchfork),
          t('schiff-pitchfork', 'Schiff pitchfork', I.IconSchiffPitchfork),
          t(
            'modified-schiff-pitchfork',
            'Modified Schiff pitchfork',
            I.IconModifiedSchiffPitchfork,
          ),
          t('inside-pitchfork', 'Inside pitchfork', I.IconInsidePitchfork),
        ],
      },
    ],
  },
  {
    id: 'fib',
    label: 'Gann and Fibonacci tools',
    sections: [
      {
        title: 'Fibonacci',
        tools: [
          t(
            'fib-retracement',
            'Fib retracement',
            I.IconFibRetracement,
            'Alt+f',
            'tool.fibRetracement',
          ),
          t('fib-extension', 'Trend-based fib extension', I.IconFibExtension),
          t('fib-channel', 'Fib channel', I.IconFibChannel),
          t('fib-time-zone', 'Fib time zone', I.IconFibTimeZone),
          t('fib-speed-fan', 'Fib speed resistance fan', I.IconFibSpeedFan),
          t('fib-trend-time', 'Trend-based fib time', I.IconFibTrendTime),
          t('fib-circles', 'Fib circles', I.IconFibCircles),
          t('fib-spiral', 'Fib spiral', I.IconFibSpiral),
          t('fib-speed-arcs', 'Fib speed resistance arcs', I.IconFibSpeedArcs),
          t('fib-wedge', 'Fib wedge', I.IconFibWedge),
          t('pitchfan', 'Pitchfan', I.IconPitchfan),
        ],
      },
      {
        title: 'Gann',
        tools: [
          t('gann-box', 'Gann box', I.IconGannBox),
          t('gann-square-fixed', 'Gann square fixed', I.IconGannSquareFixed),
          t('gann-square', 'Gann square', I.IconGannSquare),
          t('gann-fan', 'Gann fan', I.IconGannFan),
        ],
      },
    ],
  },
  {
    id: 'patterns',
    label: 'Patterns',
    sections: [
      {
        title: 'Chart patterns',
        tools: [
          t('xabcd', 'XABCD pattern', I.IconXabcd),
          t('cypher', 'Cypher pattern', I.IconCypher),
          t('head-shoulders', 'Head and shoulders', I.IconHeadShoulders),
          t('abcd', 'ABCD pattern', I.IconAbcd),
          t('triangle-pattern', 'Triangle pattern', I.IconTrianglePattern),
          t('three-drives', 'Three drives pattern', I.IconThreeDrives),
        ],
      },
      {
        title: 'Elliott waves',
        tools: [
          t('elliott-impulse', 'Elliott impulse wave (12345)', I.IconElliottImpulse),
          t('elliott-correction', 'Elliott correction wave (ABC)', I.IconElliottCorrection),
          t('elliott-triangle', 'Elliott triangle wave (ABCDE)', I.IconElliottTriangle),
          t('elliott-double-combo', 'Elliott double combo wave (WXY)', I.IconElliottDoubleCombo),
          t('elliott-triple-combo', 'Elliott triple combo wave (WXYXZ)', I.IconElliottTripleCombo),
        ],
      },
      {
        title: 'Cycles',
        tools: [
          t('cyclic-lines', 'Cyclic lines', I.IconCyclicLines),
          t('time-cycles', 'Time cycles', I.IconTimeCycles),
          t('sine-line', 'Sine line', I.IconSineLine),
        ],
      },
    ],
  },
  {
    id: 'forecasting',
    label: 'Forecasting and measurement tools',
    sections: [
      {
        title: 'Forecasting',
        tools: [
          t('long-position', 'Long position', I.IconLongPosition),
          t('short-position', 'Short position', I.IconShortPosition),
          t('forecast', 'Forecast', I.IconForecast),
          t('bars-pattern', 'Bars pattern', I.IconBarsPattern),
          t('ghost-feed', 'Ghost feed', I.IconGhostFeed),
          t('projection', 'Projection', I.IconProjection),
        ],
      },
      {
        title: 'Volume-based',
        tools: [
          t('anchored-vwap', 'Anchored VWAP', I.IconAnchoredVwap),
          t('fixed-range-vp', 'Fixed range volume profile', I.IconFixedRangeVp),
          t('anchored-vp', 'Anchored volume profile', I.IconAnchoredVp),
        ],
      },
      {
        title: 'Measurers',
        tools: [
          t('price-range', 'Price range', I.IconPriceRange),
          t('date-range', 'Date range', I.IconDateRange),
          t('date-price-range', 'Date and price range', I.IconDatePriceRange),
        ],
      },
    ],
  },
  {
    id: 'shapes',
    label: 'Geometric shapes',
    sections: [
      {
        title: 'Brushes',
        tools: [
          t('brush', 'Brush', I.IconBrush),
          t('highlighter', 'Highlighter', I.IconHighlighter),
        ],
      },
      {
        title: 'Arrows',
        tools: [
          t('arrow-marker', 'Arrow marker', I.IconArrowMarker),
          t('arrow-line', 'Arrow', I.IconArrowLine),
          t('arrow-mark-up', 'Arrow mark up', I.IconArrowMarkUp),
          t('arrow-mark-down', 'Arrow mark down', I.IconArrowMarkDown),
        ],
      },
      {
        title: 'Shapes',
        tools: [
          t('rectangle', 'Rectangle', I.IconRectangle),
          t('rotated-rectangle', 'Rotated rectangle', I.IconRotatedRectangle),
          t('path', 'Path', I.IconPath),
          t('circle', 'Circle', I.IconCircle),
          t('ellipse', 'Ellipse', I.IconEllipse),
          t('polyline', 'Polyline', I.IconPolyline),
          t('triangle', 'Triangle', I.IconTriangle),
          t('arc', 'Arc', I.IconArc),
          t('curve', 'Curve', I.IconCurve),
          t('double-curve', 'Double curve', I.IconDoubleCurve),
        ],
      },
    ],
  },
  {
    id: 'annotation',
    label: 'Annotation tools',
    sections: [
      {
        tools: [
          t('text', 'Text', I.IconText),
          t('anchored-text', 'Anchored text', I.IconAnchoredText),
          t('note', 'Note', I.IconNote),
          t('anchored-note', 'Anchored note', I.IconAnchoredNote),
          t('callout', 'Callout', I.IconCallout),
          t('comment', 'Comment', I.IconComment),
          t('price-label', 'Price label', I.IconPriceLabel),
          t('price-note', 'Price note', I.IconPriceNote),
          t('signpost', 'Signpost', I.IconSignpost),
          t('flag-mark', 'Flag mark', I.IconFlagMark),
          t('table', 'Table', I.IconTable),
          t('image', 'Image', I.IconImage),
        ],
      },
    ],
  },
];

/** Single-tool buttons below the groups. */
export const MEASURE_TOOL = t('measure', 'Measure', I.IconRuler);
export const ZOOM_TOOL = t('zoom-in', 'Zoom in', I.IconZoomIn);

/** Placeholder stickers for the Icons flyout (rendered as glyphs). */
export const ICON_TABS: {
  id: string;
  label: string;
  items: { id: string; glyph: string; name: string }[];
}[] = [
  {
    id: 'emojis',
    label: 'Emojis',
    items: [
      ['smile', '\u{1F600}', 'Grinning face'],
      ['think', '\u{1F914}', 'Thinking face'],
      ['fire', '\u{1F525}', 'Fire'],
      ['rocket', '\u{1F680}', 'Rocket'],
      ['up', '\u{1F4C8}', 'Chart increasing'],
      ['down', '\u{1F4C9}', 'Chart decreasing'],
      ['money', '\u{1F4B0}', 'Money bag'],
      ['warn', '⚠️', 'Warning'],
      ['check', '✅', 'Check mark'],
      ['cross', '❌', 'Cross mark'],
      ['eyes', '\u{1F440}', 'Eyes'],
      ['bell', '\u{1F514}', 'Bell'],
    ].map(([id, glyph, name]) => ({ id: `emoji-${id}`, glyph: glyph!, name: name! })),
  },
  {
    id: 'stickers',
    label: 'Stickers',
    items: [
      ['bull', '\u{1F402}', 'Bull'],
      ['bear', '\u{1F43B}', 'Bear'],
      ['moon', '\u{1F315}', 'To the moon'],
      ['diamond', '\u{1F48E}', 'Diamond hands'],
      ['whale', '\u{1F433}', 'Whale'],
      ['target', '\u{1F3AF}', 'Target'],
      ['trophy', '\u{1F3C6}', 'Trophy'],
      ['bomb', '\u{1F4A3}', 'Bomb'],
    ].map(([id, glyph, name]) => ({ id: `sticker-${id}`, glyph: glyph!, name: name! })),
  },
  {
    id: 'icons',
    label: 'Icons',
    items: [
      ['arrow-up', '↑', 'Arrow up'],
      ['arrow-down', '↓', 'Arrow down'],
      ['star', '★', 'Star'],
      ['flag', '⚑', 'Flag'],
      ['pin', '\u{1F4CC}', 'Pin'],
      ['info', 'ℹ️', 'Info'],
      ['question', '❓', 'Question'],
      ['bolt', '⚡', 'Lightning'],
    ].map(([id, glyph, name]) => ({ id: `icon-${id}`, glyph: glyph!, name: name! })),
  },
];
export const ICONS_GROUP_ID = 'icons';

const byId = new Map<string, { tool: ToolDef; group: string }>();
for (const g of TOOL_GROUPS)
  for (const s of g.sections) for (const tool of s.tools) byId.set(tool.id, { tool, group: g.id });
byId.set(MEASURE_TOOL.id, { tool: MEASURE_TOOL, group: 'measure' });
byId.set(ZOOM_TOOL.id, { tool: ZOOM_TOOL, group: 'zoom' });

export function findTool(id: string): ToolDef | undefined {
  return byId.get(id)?.tool;
}

export function findSticker(id: string): { glyph: string; name: string } | undefined {
  for (const tab of ICON_TABS) {
    const it = tab.items.find((i) => i.id === id);
    if (it) return it;
  }
  return undefined;
}

/** Group id a tool belongs to (stickers belong to the Icons group). */
export function groupOf(id: string): string | undefined {
  return byId.get(id)?.group ?? (findSticker(id) ? ICONS_GROUP_ID : undefined);
}

export function isCursorTool(id: string): boolean {
  return groupOf(id) === 'cursors';
}

/** Select a tool: updates the active tool, the group's last-used tool and,
 * for cross/dot/arrow, the chart crosshair mode. */
export function selectTool(id: string): void {
  const group = groupOf(id);
  if (!group) return;
  const ui = useUiStore.getState();
  ui.set({ activeTool: id, groupTools: { ...ui.groupTools, [group]: id } });
  if ((CURSOR_IDS as readonly string[]).includes(id)) {
    useAppStore.getState().set({ crosshair: id as CrosshairMode });
  }
}

/** Back to the current crosshair cursor (Escape, or after drawing). */
export function resetToCursor(): void {
  selectTool(useAppStore.getState().crosshair);
}

export function toggleFavorite(id: string): void {
  const ui = useUiStore.getState();
  const favs = ui.favoriteTools;
  ui.set({ favoriteTools: favs.includes(id) ? favs.filter((f) => f !== id) : [...favs, id] });
}
