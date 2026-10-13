export const MIN_BAR_SPACING = 0.5;
export const MAX_BAR_SPACING = 60;
export const DEFAULT_BAR_SPACING = 7;
export const DEFAULT_RIGHT_OFFSET = 8;

/**
 * Index-based horizontal scale: bar i sits at a fixed spacing regardless of its
 * time, so weekends and session gaps take no room.
 *
 * `rightOffset` is the number of (empty) bar slots between the last bar and the
 * right edge; negative when scrolled back into history.
 */
export class TimeScale {
  width = 0;
  barSpacing = DEFAULT_BAR_SPACING;
  rightOffset = DEFAULT_RIGHT_OFFSET;
  /** Index of the last bar (length - 1). */
  baseIndex = -1;

  indexToX(i: number): number {
    return this.width - (this.baseIndex + this.rightOffset - i + 0.5) * this.barSpacing;
  }

  /** Fractional logical index at x. */
  xToLogical(x: number): number {
    return this.baseIndex + this.rightOffset + 0.5 - (this.width - x) / this.barSpacing;
  }

  xToIndex(x: number): number {
    return Math.round(this.xToLogical(x));
  }

  /** Visible bar indices, clamped to data. `from > to` when nothing is visible. */
  visibleRange(): { from: number; to: number } {
    const from = Math.max(0, Math.floor(this.xToLogical(0)));
    const to = Math.min(this.baseIndex, Math.ceil(this.xToLogical(this.width)));
    return { from, to };
  }

  /** Logical (unclamped) visible span, for lazy-loading decisions. */
  logicalRange(): { from: number; to: number } {
    return { from: this.xToLogical(0), to: this.xToLogical(this.width) };
  }

  pan(dxPx: number): void {
    this.rightOffset -= dxPx / this.barSpacing;
    this.clamp();
  }

  /** Zoom keeping the bar under `anchorX` fixed. factor > 1 zooms in. */
  zoom(anchorX: number, factor: number): void {
    const logical = this.xToLogical(anchorX);
    this.barSpacing = clampSpacing(this.barSpacing * factor);
    this.rightOffset = logical - this.baseIndex - 0.5 + (this.width - anchorX) / this.barSpacing;
    this.clamp();
  }

  setBarSpacing(spacing: number): void {
    this.barSpacing = clampSpacing(spacing);
    this.clamp();
  }

  /** Called after n bars were inserted in front: the view must not move. */
  onPrepend(n: number): void {
    this.baseIndex += n;
  }

  /** Called after a bar was appended. Keeps the view pinned to the latest bar
   * when it was visible (auto-scroll), otherwise holds the view still. */
  onAppend(): void {
    const lastVisible = this.indexToX(this.baseIndex) <= this.width;
    this.baseIndex += 1;
    if (!lastVisible) this.rightOffset -= 1;
    this.clamp();
  }

  reset(baseIndex: number): void {
    this.baseIndex = baseIndex;
    this.rightOffset = DEFAULT_RIGHT_OFFSET;
    this.clamp();
  }

  /** Show bars in [from, to] (indices) across the full width. */
  fitRange(from: number, to: number): void {
    const count = Math.max(1, to - from + 1);
    this.barSpacing = clampSpacing(this.width / (count + DEFAULT_RIGHT_OFFSET));
    this.rightOffset = DEFAULT_RIGHT_OFFSET - (this.baseIndex - to);
    this.clamp();
  }

  clamp(): void {
    if (this.width <= 0 || this.baseIndex < 0) return;
    // Keep at least a couple of bars on screen at either edge.
    const max = this.width / this.barSpacing - 2.5;
    const min = 1.5 - this.baseIndex;
    this.rightOffset = Math.min(max, Math.max(min, this.rightOffset));
  }
}

function clampSpacing(s: number): number {
  return Math.min(MAX_BAR_SPACING, Math.max(MIN_BAR_SPACING, s));
}
