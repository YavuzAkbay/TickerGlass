/**
 * DOM id for a symbol row, shared by the row (`id`) and the grid's
 * `aria-activedescendant` / `getElementById` lookups. Symbols carry `^ = . /`
 * and friends; anything outside `[A-Za-z0-9-]` is escaped as `_<hex>_`
 * (`_` itself too), so ids stay selector-safe and distinct symbols never collide.
 */
export function rowDomId(prefix: string, symbol: string): string {
  return `${prefix}-${symbol.replace(/[^A-Za-z0-9-]/g, (c) => `_${c.charCodeAt(0).toString(16)}_`)}`;
}
