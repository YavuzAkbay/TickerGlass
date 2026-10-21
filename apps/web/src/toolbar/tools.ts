import { getDrawingTool, type CrosshairMode } from '@tickerglass/engine';
import { getIndicator } from '@tickerglass/indicators';
import { useAppStore } from '../store/app';
import { useUiStore, type DrawingToolId } from '../store/ui';
import { toast } from '../ui/Toast';
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
    label: 'Lines',
    sections: [
      {
        title: 'Lines',
        tools: [
          t('trend-line', 'Trend line', I.IconTrendLine, 'Alt+t', 'tool.trendLine'),
          t('ray', 'Ray', I.IconRay),
          t('measured-line', 'Measured line', I.IconMeasuredLine),
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
          t('flat-channel', 'Flat-edge channel', I.IconFlatChannel),
          t('split-channel', 'Split channel', I.IconSplitChannel),
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
          t('inner-pitchfork', 'Inner pitchfork', I.IconInnerPitchfork),
        ],
      },
    ],
  },
  {
    id: 'fib',
    label: 'Fibonacci & Gann',
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
          t('fib-extension', 'Fib extension', I.IconFibExtension),
          t('fib-channel', 'Fib channel', I.IconFibChannel),
          t('fib-time-zone', 'Fib time zone', I.IconFibTimeZone),
          t('fib-fan', 'Fib fan', I.IconFibFan),
          t('fib-time-extension', 'Fib time extension', I.IconFibTimeExtension),
          t('fib-circles', 'Fib circles', I.IconFibCircles),
          t('fib-spiral', 'Fib spiral', I.IconFibSpiral),
          t('fib-arcs', 'Fib arcs', I.IconFibArcs),
          t('fib-sector', 'Fib sector', I.IconFibSector),
          t('fork-fan', 'Fork fan', I.IconForkFan),
        ],
      },
      {
        title: 'Gann',
        tools: [
          t('gann-box', 'Gann box', I.IconGannBox),
          t('gann-grid', 'Gann grid', I.IconGannGrid),
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
          t('elliott-impulse', 'Elliott impulse (5-wave)', I.IconElliottImpulse),
          t('elliott-correction', 'Elliott correction (3-wave)', I.IconElliottCorrection),
          t('elliott-triangle', 'Elliott triangle (5-wave)', I.IconElliottTriangle),
          t('elliott-double-combo', 'Elliott double combination', I.IconElliottDoubleCombo),
          t('elliott-triple-combo', 'Elliott triple combination', I.IconElliottTripleCombo),
        ],
      },
      {
        title: 'Cycles',
        tools: [
          t('cycle-lines', 'Cycle lines', I.IconCycleLines),
          t('cycle-arcs', 'Cycle arcs', I.IconCycleArcs),
          t('sine-wave', 'Sine wave', I.IconSineWave),
        ],
      },
    ],
  },
  {
    id: 'forecasting',
    label: 'Projection & measure',
    sections: [
      {
        title: 'Projection',
        tools: [
          t('long-position', 'Long position', I.IconLongPosition),
          t('short-position', 'Short position', I.IconShortPosition),
          t('price-target', 'Price target', I.IconPriceTarget),
          t('bar-replica', 'Bar replica', I.IconBarReplica),
          t('path-sketch', 'Path sketch', I.IconPathSketch),
          t('swing-projection', 'Swing projection', I.IconSwingProjection),
        ],
      },
      {
        title: 'Volume-based',
        tools: [
          t('anchored-vwap', 'Anchored VWAP', I.IconAnchoredVwap),
          t('range-vp', 'Range volume profile', I.IconRangeVp),
          t('anchored-vp', 'Anchored volume profile', I.IconAnchoredVp),
        ],
      },
      {
        title: 'Measure',
        tools: [
          t('price-measure', 'Price measure', I.IconPriceMeasure),
          t('time-measure', 'Time measure', I.IconTimeMeasure),
          t('price-time-measure', 'Price & time measure', I.IconPriceTimeMeasure),
        ],
      },
    ],
  },
  {
    id: 'shapes',
    label: 'Shapes',
    sections: [
      {
        title: 'Freehand',
        tools: [
          t('brush', 'Brush', I.IconBrush),
          t('highlighter', 'Highlighter', I.IconHighlighter),
        ],
      },
      {
        title: 'Arrows',
        tools: [
          t('arrow-pointer', 'Arrow pointer', I.IconArrowPointer),
          t('arrow-line', 'Arrow', I.IconArrowLine),
          t('up-marker', 'Up marker', I.IconUpMarker),
          t('down-marker', 'Down marker', I.IconDownMarker),
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
          t('s-curve', 'S-curve', I.IconSCurve),
        ],
      },
    ],
  },
  {
    id: 'annotation',
    label: 'Notes & labels',
    sections: [
      {
        tools: [
          t('text', 'Text', I.IconText),
          t('pinned-text', 'Pinned text', I.IconPinnedText),
          t('note', 'Note', I.IconNote),
          t('pinned-note', 'Pinned note', I.IconPinnedNote),
          t('callout', 'Callout', I.IconCallout),
          t('comment', 'Comment', I.IconComment),
          t('price-label', 'Price label', I.IconPriceLabel),
          t('price-tag', 'Price tag', I.IconPriceTag),
          t('pin', 'Pin', I.IconPin),
          t('flag', 'Flag', I.IconFlag),
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

/** Hint for toolbar entries whose engine tool or indicator is missing (every shipped entry resolves). */
export const UNAVAILABLE_HINT = 'Not available in this build';

/** Id of the indicator the Anchored VWAP toolbar entry adds. */
export const ANCHORED_VWAP_ID = 'anchored-vwap';

/**
 * Cursors (incl. the eraser), the measure and zoom-in modes, stickers (engine
 * `icon` tool), Anchored VWAP (needs its indicator) and tools with a registered
 * drawing definition.
 */
export function isToolAvailable(id: string): boolean {
  if (id === ANCHORED_VWAP_ID) return !!getIndicator(ANCHORED_VWAP_ID);
  return (
    isCursorTool(id) ||
    id === MEASURE_TOOL.id ||
    id === ZOOM_TOOL.id ||
    !!getDrawingTool(id) ||
    (!!findSticker(id) && !!getDrawingTool('icon'))
  );
}

/** Select a tool: updates the active tool, the group's last-used tool and,
 * for cross/dot/arrow, the chart crosshair mode. Unavailable tools only show
 * a hint. */
export function selectTool(id: string): void {
  const group = groupOf(id);
  if (!group) return;
  if (!isToolAvailable(id)) {
    const name = findTool(id)?.name ?? findSticker(id)?.name ?? id;
    toast(`${name}: ${UNAVAILABLE_HINT.toLowerCase()}`);
    return;
  }
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
