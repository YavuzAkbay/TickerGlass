/**
 * Index of the tab an arrow/Home/End key moves to, or null when the key is not
 * a tab navigation key. Wraps at both ends; `from` < 0 (no tab focused) starts at the edge.
 */
export function tabKeyTarget(from: number, count: number, key: string): number | null {
  if (count <= 0) return null;
  switch (key) {
    case 'ArrowRight':
      return from < 0 ? 0 : (from + 1) % count;
    case 'ArrowLeft':
      return from < 0 ? count - 1 : (from - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}
