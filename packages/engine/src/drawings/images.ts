// Decoded-image cache for drawing tools (image, sticker): data URL -> image.
// Decoding is async, so the first render gets null and the tool asks for a
// redraw through `rc.invalidate` once the image is ready.

/** Most recently used images kept decoded. */
const MAX_IMAGES = 32;

interface Entry {
  img: HTMLImageElement;
  state: 'loading' | 'ready' | 'error';
  /** Redraw requests to run once loading ends (deduplicated: pass a stable function). */
  waiters: Set<() => void>;
}

/** Insertion order = LRU order (oldest first). */
const cache = new Map<string, Entry>();

/**
 * Decoded image for `src` (a data URL), or null while it decodes, when it
 * failed, or without a DOM (Node, tests without an `Image` global). `onReady`
 * runs once when a pending decode ends (success or failure); pass
 * `rc.invalidate`. Keeps the last MAX_IMAGES sources.
 */
export function drawingImage(src: string, onReady: () => void): HTMLImageElement | null {
  if (!src || typeof Image === 'undefined') return null;
  let e = cache.get(src);
  if (e) {
    // Touch: move to the most recent end.
    cache.delete(src);
    cache.set(src, e);
  } else {
    e = load(src);
    cache.set(src, e);
    for (const [key, old] of cache) {
      if (cache.size <= MAX_IMAGES) break;
      cache.delete(key);
      old.img.onload = old.img.onerror = null;
      old.waiters.clear();
    }
  }
  if (e.state === 'ready') return e.img;
  if (e.state === 'loading') e.waiters.add(onReady);
  return null;
}

function load(src: string): Entry {
  const img = new Image();
  const e: Entry = { img, state: 'loading', waiters: new Set() };
  const done = (state: Entry['state']) => {
    e.state = state;
    img.onload = img.onerror = null;
    const waiters = [...e.waiters];
    e.waiters.clear();
    for (const fn of waiters) fn();
  };
  img.onload = () => done('ready');
  img.onerror = () => done('error');
  img.src = src;
  return e;
}

/** Drop every cached image (tests). */
export function clearDrawingImages(): void {
  for (const e of cache.values()) {
    e.img.onload = e.img.onerror = null;
    e.waiters.clear();
  }
  cache.clear();
}
