/**
 * Treemap layout (pure): the squarified algorithm of Bruls, Huizing and van Wijk, a nested variant
 * for grouped maps, and keyboard neighbour search. No React, no DOM: the component only paints the
 * rectangles computed here, and recomputes them only when sizes or the box change.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Sized {
  id: string;
  value: number;
}

export interface Placed extends Rect {
  id: string;
  value: number;
}

const usable = (v: number): boolean => Number.isFinite(v) && v > 0;

/** Worst aspect ratio of a row of `areas` laid along a side of length `side`. */
function worst(sum: number, min: number, max: number, side: number): number {
  const s2 = sum * sum;
  const l2 = side * side;
  return Math.max((l2 * max) / s2, s2 / (l2 * min));
}

/**
 * Lay `items` out in `rect` so every rectangle's area is proportional to its value, rectangles do not
 * overlap and together cover `rect`. Items without a positive finite value are dropped. The result is
 * ordered by descending value (ties keep input order), which is also the keyboard order.
 */
export function squarify(items: readonly Sized[], rect: Rect): Placed[] {
  const list = items.filter((i) => usable(i.value));
  if (!list.length || !(rect.w > 0) || !(rect.h > 0)) return [];
  const sorted = list
    .map((item, index) => ({ item, index }))
    .sort((a, b) => b.item.value - a.item.value || a.index - b.index)
    .map((e) => e.item);
  const total = sorted.reduce((s, i) => s + i.value, 0);
  const scale = (rect.w * rect.h) / total;
  const areas = sorted.map((i) => i.value * scale);

  const out: Placed[] = [];
  let { x, y, w, h } = rect;
  let i = 0;
  while (i < sorted.length) {
    const wide = w >= h;
    const side = wide ? h : w;
    let j = i + 1;
    let sum = areas[i]!;
    let min = areas[i]!;
    let max = areas[i]!;
    // Grow the row while it does not worsen the worst aspect ratio.
    while (j < sorted.length) {
      const a = areas[j]!;
      if (worst(sum + a, Math.min(min, a), Math.max(max, a), side) > worst(sum, min, max, side))
        break;
      sum += a;
      min = Math.min(min, a);
      max = Math.max(max, a);
      j++;
    }
    const last = j >= sorted.length;
    // The row is a strip across the short side; its thickness is area / side.
    const thick = last ? (wide ? w : h) : sum / side;
    let offset = 0;
    for (let k = i; k < j; k++) {
      const len = k === j - 1 ? side - offset : areas[k]! / thick;
      out.push(
        wide
          ? { id: sorted[k]!.id, value: sorted[k]!.value, x, y: y + offset, w: thick, h: len }
          : { id: sorted[k]!.id, value: sorted[k]!.value, x: x + offset, y, w: len, h: thick },
      );
      offset += len;
    }
    if (wide) {
      x += thick;
      w -= thick;
    } else {
      y += thick;
      h -= thick;
    }
    i = j;
  }
  return out;
}

export interface GroupInput {
  id: string;
  items: readonly Sized[];
}

export interface PlacedGroup {
  id: string;
  /** Outer rectangle, header included. */
  rect: Rect;
  /** Header strip, or null when the group is too small to label. */
  header: Rect | null;
  /** Total value of the group's items. */
  value: number;
}

export interface PlacedTile extends Placed {
  group: string;
}

export interface GroupedLayout {
  groups: PlacedGroup[];
  tiles: PlacedTile[];
}

export interface GroupLayoutOptions {
  /** Header strip height in px (0: groups are drawn without a label). */
  headerH: number;
  /** Inset around a group's tiles in px. */
  pad: number;
  /** Smallest group box that still gets a header. */
  minHeaderW: number;
}

export const DEFAULT_GROUP_LAYOUT: GroupLayoutOptions = { headerH: 18, pad: 2, minHeaderW: 52 };

/**
 * Nested treemap: groups are squarified by their total, then each group's items inside its box
 * (below the header strip). A single group is laid out flat, with no header or padding.
 */
export function layoutGroups(
  groups: readonly GroupInput[],
  rect: Rect,
  opts: GroupLayoutOptions = DEFAULT_GROUP_LAYOUT,
  flat = false,
): GroupedLayout {
  const live = groups
    .map((g) => ({ ...g, items: g.items.filter((i) => usable(i.value)) }))
    .filter((g) => g.items.length > 0);
  if (!live.length) return { groups: [], tiles: [] };
  if (flat || live.length === 1) {
    const tiles = squarify(
      live.flatMap((g) => g.items),
      rect,
    );
    const owner = new Map<string, string>();
    for (const g of live) for (const i of g.items) owner.set(i.id, g.id);
    return {
      groups: live.map((g) => ({
        id: g.id,
        rect: live.length === 1 ? rect : { x: 0, y: 0, w: 0, h: 0 },
        header: null,
        value: g.items.reduce((s, i) => s + i.value, 0),
      })),
      tiles: tiles.map((t) => ({ ...t, group: owner.get(t.id) ?? '' })),
    };
  }
  const totals = live.map((g) => ({
    id: g.id,
    value: g.items.reduce((s, i) => s + i.value, 0),
  }));
  const boxes = squarify(totals, rect);
  const byId = new Map(live.map((g) => [g.id, g]));
  const outGroups: PlacedGroup[] = [];
  const tiles: PlacedTile[] = [];
  for (const box of boxes) {
    const g = byId.get(box.id)!;
    const labelled = opts.headerH > 0 && box.w >= opts.minHeaderW && box.h >= opts.headerH * 2.2;
    const header = labelled ? { x: box.x, y: box.y, w: box.w, h: opts.headerH } : null;
    const top = header ? opts.headerH : 0;
    const inner: Rect = {
      x: box.x + opts.pad,
      y: box.y + top + (header ? 0 : opts.pad),
      w: box.w - opts.pad * 2,
      h: box.h - top - opts.pad * (header ? 1 : 2),
    };
    outGroups.push({
      id: g.id,
      rect: { x: box.x, y: box.y, w: box.w, h: box.h },
      header,
      value: box.value,
    });
    for (const t of squarify(g.items, inner.w > 0 && inner.h > 0 ? inner : box))
      tiles.push({ ...t, group: g.id });
  }
  return { groups: outGroups, tiles };
}

export type Direction = 'left' | 'right' | 'up' | 'down';

/**
 * The tile to move to from `fromId` in `dir` (arrow keys): among tiles whose centre lies in that
 * direction, the one with the smallest distance along the axis plus twice the cross-axis offset
 * (so it prefers staying in line). Null when nothing lies that way.
 */
export function neighbor(
  tiles: readonly (Rect & { id: string })[],
  fromId: string,
  dir: Direction,
): string | null {
  const from = tiles.find((t) => t.id === fromId);
  if (!from) return null;
  const cx = from.x + from.w / 2;
  const cy = from.y + from.h / 2;
  let best: string | null = null;
  let bestScore = Infinity;
  for (const t of tiles) {
    if (t.id === fromId) continue;
    const dx = t.x + t.w / 2 - cx;
    const dy = t.y + t.h / 2 - cy;
    const along = dir === 'right' ? dx : dir === 'left' ? -dx : dir === 'down' ? dy : -dy;
    if (along <= 0.5) continue;
    const cross = dir === 'left' || dir === 'right' ? Math.abs(dy) : Math.abs(dx);
    const score = along + cross * 2;
    if (score < bestScore) {
      bestScore = score;
      best = t.id;
    }
  }
  return best;
}
