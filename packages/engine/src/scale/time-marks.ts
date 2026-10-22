import type { IntervalUnit } from '../types';
import type { TzConverter } from './timezone';

export const W_MINUTE = 20;
export const W_MINUTE5 = 21;
export const W_MINUTE15 = 22;
export const W_MINUTE30 = 23;
export const W_HOUR = 30;
export const W_HOUR3 = 31;
export const W_HOUR6 = 32;
export const W_HOUR12 = 33;
export const W_DAY = 50;
export const W_MONTH = 60;
export const W_YEAR = 70;

const DAY = 86400;

/** Bucket sizes (seconds) with their weights, coarsest first. */
const BUCKET_SIZES = [43200, 21600, 10800, 3600, 1800, 900, 300, 60] as const;
const BUCKET_WEIGHTS = [
  W_HOUR12,
  W_HOUR6,
  W_HOUR3,
  W_HOUR,
  W_MINUTE30,
  W_MINUTE15,
  W_MINUTE5,
  W_MINUTE,
] as const;

/**
 * Per-bar weight: the highest local-time calendar boundary crossed between the
 * previous bar and this one (0 = none).
 */
export function computeTimeWeights(
  times: Float64Array,
  tz: TzConverter,
  out?: Uint8Array,
): Uint8Array {
  const n = times.length;
  const res = out && out.length >= n ? out : new Uint8Array(n);
  if (n === 0) return res;

  const t0 = times[0] as number;
  let prevLocal = tz.toLocal(t0);
  let prevDay = Math.floor(prevLocal / DAY);
  const prevDate = new Date(prevLocal * 1000);
  let prevYear = prevDate.getUTCFullYear();
  let prevMonth = prevDate.getUTCMonth();

  // Bar 0: largest unit it aligns to.
  {
    let w: number = W_DAY;
    if (prevLocal - prevDay * DAY === 0) {
      if (prevDate.getUTCMonth() === 0 && prevDate.getUTCDate() === 1) w = W_YEAR;
      else if (prevDate.getUTCDate() === 1) w = W_MONTH;
    } else {
      for (let k = 0; k < BUCKET_SIZES.length; k++) {
        if (prevLocal % (BUCKET_SIZES[k] as number) === 0) {
          w = BUCKET_WEIGHTS[k] as number;
          break;
        }
      }
    }
    res[0] = w;
  }

  for (let i = 1; i < n; i++) {
    const local = tz.toLocal(times[i] as number);
    const day = Math.floor(local / DAY);
    let w = 0;
    if (day !== prevDay) {
      const d = new Date(local * 1000);
      const y = d.getUTCFullYear();
      const m = d.getUTCMonth();
      if (y !== prevYear) w = W_YEAR;
      else if (m !== prevMonth) w = W_MONTH;
      else w = W_DAY;
      prevYear = y;
      prevMonth = m;
    } else {
      for (let k = 0; k < BUCKET_SIZES.length; k++) {
        const size = BUCKET_SIZES[k] as number;
        if (Math.floor(local / size) !== Math.floor(prevLocal / size)) {
          w = BUCKET_WEIGHTS[k] as number;
          break;
        }
      }
    }
    res[i] = w;
    prevLocal = local;
    prevDay = day;
  }
  return res;
}

export interface TimeMark {
  index: number;
  weight: number;
  label: string;
  x: number;
}

export interface SelectTimeMarksParams {
  times: Float64Array;
  weights: Uint8Array;
  /** Empty slots after the last bar (indices `times.length` and up), for marks past the data. */
  future?: { times: Float64Array; weights: Uint8Array } | undefined;
  from: number;
  to: number;
  indexToX: (i: number) => number;
  minSpacingPx: number;
  tz: TzConverter;
  locale?: string;
}

/** Greedy label selection: heaviest weight first, right to left within a weight. */
export function selectTimeMarks(params: SelectTimeMarksParams): TimeMark[] {
  const { times, weights, future, indexToX, minSpacingPx, tz, locale } = params;
  const nData = Math.min(times.length, weights.length);
  const n = nData + (future ? Math.min(future.times.length, future.weights.length) : 0);
  const weightAt = (i: number) =>
    i < nData ? (weights[i] as number) : (future!.weights[i - nData] as number);
  const timeAt = (i: number) =>
    i < nData ? (times[i] as number) : (future!.times[i - nData] as number);
  const from = Math.max(0, Math.floor(params.from));
  const to = Math.min(n - 1, Math.ceil(params.to));
  if (n === 0 || to < from) return [];

  // Counting sort of candidate indices by weight.
  const counts = new Int32Array(257);
  let total = 0;
  for (let i = from; i <= to; i++) {
    const w = weightAt(i);
    if (w > 0) {
      counts[w + 1] = (counts[w + 1] as number) + 1;
      total++;
    }
  }
  if (total === 0) return [];
  for (let w = 1; w < 257; w++) counts[w] = (counts[w] as number) + (counts[w - 1] as number);
  // counts[w] is now the start offset of weight w.
  const order = new Int32Array(total);
  for (let i = from; i <= to; i++) {
    const w = weightAt(i);
    if (w > 0) {
      const pos = counts[w] as number;
      order[pos] = i;
      counts[w] = pos + 1;
    }
  }
  // After placement counts[w] is the end offset of weight w (= start of w+1).

  const acceptedX: number[] = [];
  const accepted: TimeMark[] = [];
  for (let w = 255; w >= 1; w--) {
    const end = counts[w] as number;
    const start = w === 1 ? 0 : (counts[w - 1] as number);
    for (let p = end - 1; p >= start; p--) {
      const idx = order[p] as number;
      const x = indexToX(idx);
      let ok = true;
      for (let k = 0; k < acceptedX.length; k++) {
        if (Math.abs((acceptedX[k] as number) - x) < minSpacingPx) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      acceptedX.push(x);
      accepted.push({
        index: idx,
        weight: w,
        label: formatTimeMark(timeAt(idx), w, tz, locale),
        x,
      });
    }
  }
  accepted.sort((a, b) => a.x - b.x);
  return accepted;
}

const DEFAULT_LOCALE = 'en-US';
const monthFormatters = new Map<string, Intl.DateTimeFormat>();
const weekdayFormatters = new Map<string, Intl.DateTimeFormat>();

function monthName(d: Date, locale: string): string {
  let f = monthFormatters.get(locale);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' });
    monthFormatters.set(locale, f);
  }
  return f.format(d);
}

function weekdayName(d: Date, locale: string): string {
  let f = weekdayFormatters.get(locale);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' });
    weekdayFormatters.set(locale, f);
  }
  return f.format(d);
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function formatTimeMark(
  t: number,
  weight: number,
  tz: TzConverter,
  locale: string = DEFAULT_LOCALE,
): string {
  const d = new Date(tz.toLocal(t) * 1000);
  if (weight >= W_YEAR) return String(d.getUTCFullYear());
  if (weight >= W_MONTH) return monthName(d, locale);
  if (weight >= W_DAY) return String(d.getUTCDate());
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

export function formatCrosshairTime(
  t: number,
  unit: IntervalUnit,
  tz: TzConverter,
  locale: string = DEFAULT_LOCALE,
): string {
  const d = new Date(tz.toLocal(t) * 1000);
  const mon = monthName(d, locale);
  const yy = `'${pad2(d.getUTCFullYear() % 100)}`;
  if (unit === 'month') return `${mon} ${yy}`;
  const date = `${weekdayName(d, locale)} ${d.getUTCDate()} ${mon} ${yy}`;
  if (unit === 'day' || unit === 'week') return date;
  return `${date} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}
