/**
 * Drawing tool ids renamed over time (old -> current). Saved drawings,
 * templates and toolbar preferences can still carry an old id; map it with
 * `resolveDrawingType` wherever stored data is read.
 */
export const LEGACY_DRAWING_TYPES: Readonly<Record<string, string>> = Object.freeze({
  'info-line': 'measured-line',
  'flat-top-bottom': 'flat-channel',
  'disjoint-channel': 'split-channel',
  'inside-pitchfork': 'inner-pitchfork',
  'fib-trend-time': 'fib-time-extension',
  'fib-speed-fan': 'fib-fan',
  'fib-speed-arcs': 'fib-arcs',
  'fib-wedge': 'fib-sector',
  pitchfan: 'fork-fan',
  'gann-square-fixed': 'gann-grid',
  'cyclic-lines': 'cycle-lines',
  'time-cycles': 'cycle-arcs',
  'sine-line': 'sine-wave',
  forecast: 'price-target',
  'bars-pattern': 'bar-replica',
  'ghost-feed': 'path-sketch',
  projection: 'swing-projection',
  'fixed-range-vp': 'range-vp',
  'price-range': 'price-measure',
  'date-range': 'time-measure',
  'date-price-range': 'price-time-measure',
  'arrow-marker': 'arrow-pointer',
  'arrow-mark-up': 'up-marker',
  'arrow-mark-down': 'down-marker',
  'double-curve': 's-curve',
  'anchored-text': 'pinned-text',
  'anchored-note': 'pinned-note',
  'price-note': 'price-tag',
  signpost: 'pin',
  'flag-mark': 'flag',
});

/** The current id of a (possibly legacy) drawing tool id; other ids pass through. */
export function resolveDrawingType(type: string): string {
  return Object.hasOwn(LEGACY_DRAWING_TYPES, type) ? LEGACY_DRAWING_TYPES[type]! : type;
}
