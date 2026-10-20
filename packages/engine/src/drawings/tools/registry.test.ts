import { describe, expect, it } from 'vitest';
import { listDrawingTools } from '../registry';
import type { DrawingPoint } from '../types';
import { geometryOf, IDLE, makeDrawing, pt, recordingContext, SELECTED, tool } from './test-utils';

const TYPES = [
  'trend-line',
  'ray',
  'measured-line',
  'extended-line',
  'trend-angle',
  'horizontal-line',
  'horizontal-ray',
  'vertical-line',
  'cross-line',
  'parallel-channel',
  'regression-trend',
  'flat-channel',
  'split-channel',
  'pitchfork',
  'schiff-pitchfork',
  'modified-schiff-pitchfork',
  'inner-pitchfork',
  'fib-retracement',
  'fib-extension',
  'fib-channel',
  'fib-time-zone',
  'fib-fan',
  'fib-time-extension',
  'fib-circles',
  'fib-spiral',
  'fib-arcs',
  'fib-sector',
  'fork-fan',
  'gann-box',
  'gann-grid',
  'gann-square',
  'gann-fan',
  'xabcd',
  'cypher',
  'head-shoulders',
  'abcd',
  'triangle-pattern',
  'three-drives',
  'elliott-impulse',
  'elliott-correction',
  'elliott-triangle',
  'elliott-double-combo',
  'elliott-triple-combo',
  'cycle-lines',
  'cycle-arcs',
  'sine-wave',
  'long-position',
  'short-position',
  'price-target',
  'bar-replica',
  'path-sketch',
  'swing-projection',
  'range-vp',
  'anchored-vp',
  'price-measure',
  'time-measure',
  'price-time-measure',
  'brush',
  'highlighter',
  'arrow-pointer',
  'arrow-line',
  'up-marker',
  'down-marker',
  'rectangle',
  'rotated-rectangle',
  'path',
  'circle',
  'ellipse',
  'polyline',
  'triangle',
  'arc',
  'curve',
  's-curve',
  'text',
  'pinned-text',
  'note',
  'pinned-note',
  'callout',
  'comment',
  'price-label',
  'price-tag',
  'pin',
  'flag',
  'table',
  'image',
  'icon',
];

const PROP_KINDS = [
  'color',
  'lineWidth',
  'lineStyle',
  'bool',
  'number',
  'enum',
  'fontSize',
  'levels',
  'string',
  'image',
];

describe('built-in tools', () => {
  it('registers every core tool in toolbar order', () => {
    expect(listDrawingTools().map((t) => t.type)).toEqual(TYPES);
  });

  it.each(TYPES)('%s: schema keys exist in defaults', (type) => {
    const def = tool(type);
    for (const p of def.properties) {
      expect(def.defaults, `${type}.${p.key}`).toHaveProperty(p.key);
      expect(PROP_KINDS).toContain(p.kind);
    }
  });

  it.each(TYPES)('%s: renders/hit-tests drafts with 1..n anchors and offscreen', (type) => {
    const def = tool(type);
    const c = def.creation;
    const n = c.kind === 'points' ? c.count : c.kind === 'multi' ? Math.min(c.max ?? 3, 3) : 3;
    const all: DrawingPoint[] = [pt(20, 20), pt(40, 60), pt(30, 50)];
    for (let k = 1; k <= n; k++) {
      const d = makeDrawing(type, all.slice(0, k), {}, 'txt');
      const g = geometryOf(d);
      const { rc } = recordingContext();
      expect(() => def.render(rc, g, d.style, SELECTED)).not.toThrow();
      expect(() => def.hitTest(g, d.style, 100, 100, 4)).not.toThrow();
      expect(() => def.handles?.(g, d.style)).not.toThrow();
      def.priceAxisLabels?.(d, d.style, IDLE);
    }
    // Lines extending right of far-left anchors are legitimately visible (also
    // fan rays and cycles/waves repeating across the pane).
    const far = makeDrawing(type, [pt(-500, 20), pt(-480, 30), pt(-490, 25)]);
    if (
      def.isVisible &&
      ![
        'horizontal-line',
        'cross-line',
        'ray',
        'extended-line',
        'horizontal-ray',
        'fib-fan',
        'gann-fan',
        'cycle-lines',
        'cycle-arcs',
        'sine-wave',
      ].includes(type)
    )
      expect(def.isVisible(geometryOf(far), far.style)).toBe(false);
  });
});
