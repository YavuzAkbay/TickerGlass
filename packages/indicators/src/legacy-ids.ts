/**
 * Indicator ids that were renamed. Saved layouts, indicator templates,
 * starred lists and alert specs may still carry the old id; every loader maps
 * it through `resolveIndicatorId` so those documents keep working.
 */
export const LEGACY_INDICATOR_IDS: Readonly<Record<string, string>> = {
  'pivots-hl': 'swing-hl',
  'auto-fib': 'swing-fib',
  'relative-volume': 'tod-relative-volume',
};

/** The current id for `id` (itself when it was never renamed). */
export function resolveIndicatorId(id: string): string {
  return Object.prototype.hasOwnProperty.call(LEGACY_INDICATOR_IDS, id)
    ? LEGACY_INDICATOR_IDS[id]!
    : id;
}
