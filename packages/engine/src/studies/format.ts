import { formatPrice, formatVolume } from '../scale/price-ticks';
import type { StudyValueFormat } from './types';

/** Study value text for legends and axis labels; '' for NaN. */
export function formatStudyValue(
  v: number,
  format: StudyValueFormat,
  precision: number | null,
  symbolDecimals: number,
): string {
  if (!Number.isFinite(v)) return '';
  switch (format) {
    case 'volume':
      return formatVolume(v);
    case 'percent':
      return `${formatPrice(v, precision ?? 2)}%`;
    default:
      return formatPrice(v, precision ?? symbolDecimals);
  }
}

/** Axis tick text for a study pane (ticks use step-derived decimals). */
export function formatStudyTick(
  v: number,
  format: StudyValueFormat,
  stepDecimals: number,
): string | null {
  switch (format) {
    case 'volume':
      return formatVolume(v);
    case 'percent':
      return `${formatPrice(v, Math.min(8, stepDecimals))}%`;
    default:
      return null;
  }
}
