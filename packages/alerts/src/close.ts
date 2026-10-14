/**
 * Bar close detection (docs/alerts.md §2.4). Bar i (open T_i) is closed at the
 * first of: the feed delivers a bar with time > T_i (rule 1), or the clock
 * reaches end_i + grace (rule 2).
 */
import {
  createTzConverter,
  intervalSeconds,
  isIntraday,
  parseInterval,
  stepTime,
  type Interval,
  type SymbolInfo,
  type TzConverter,
} from '@investopen/engine/node';
import { DEFAULT_CLOSE_GRACE_S } from './trigger';

const DAY = 86_400;
const SESSION_RE = /^(\d{2})(\d{2})-(\d{2})(\d{2})$/;

export type CloseSymbolInfo = Pick<SymbolInfo, 'timezone' | 'session'>;

/** Bar open times, ascending. */
export interface CloseSeries {
  readonly time: ArrayLike<number>;
  readonly length: number;
}

/** Regular session "HHMM-HHMM" as [start, end] local seconds of day, or null. */
function parseSession(session: string | null | undefined): [number, number] | null {
  const m = SESSION_RE.exec(session?.trim() ?? '');
  if (!m) return null;
  const [sh, sm, eh, em] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (sh > 23 || sm > 59 || eh > 24 || em > 59) return null;
  const end = eh === 24 ? DAY : eh * 3600 + em * 60;
  return [sh * 3600 + sm * 60, end];
}

/** UTC time of local seconds `l` (DST-safe outside the transition hour). */
function fromLocal(tz: TzConverter, l: number): number {
  const guess = l - tz.offsetSeconds(l);
  return l - tz.offsetSeconds(guess);
}

const weekday = (localDay: number) => (localDay + 4) % 7; // 1970-01-01 was a Thursday
const isWeekday = (localDay: number) => {
  const wd = weekday(localDay);
  return wd !== 0 && wd !== 6;
};

/** Last Mon-Fri local day in [first, last] (falls back to `last`). */
function lastWeekdayIn(first: number, last: number): number {
  for (let d = last; d >= first; d--) if (isWeekday(d)) return d;
  return last;
}

/** Local day `count - 1` trading (Mon-Fri) days after `day` (a 2D bar covers two). */
function addWeekdays(day: number, count: number): number {
  let d = day;
  for (let left = count - 1; left > 0;) {
    d++;
    if (isWeekday(d)) left--;
  }
  return d;
}

function toInterval(interval: Interval | string): Interval {
  return typeof interval === 'string' ? parseInterval(interval) : interval;
}

/**
 * End of bar i in unix s (§2.4 rule 2, before the grace):
 * - intraday: T_i + interval, capped at the regular session end of that
 *   trading day when `prepost` is false and the session (and timezone) are known;
 * - 1D and above with a known session: the session end on the last trading day
 *   covered by the bar (the bar's local day for 1D; the last weekday of the
 *   week or month for W/M), in the exchange timezone;
 * - otherwise: `stepTime(T_i, 1, interval)`.
 */
export function barEnd(
  i: number,
  series: CloseSeries,
  symbolInfo: CloseSymbolInfo | null,
  prepost: boolean,
  interval: Interval | string,
): number {
  const t = series.time[i];
  if (t === undefined || i < 0 || i >= series.length) throw new RangeError(`bar ${i} out of range`);
  const iv = toInterval(interval);
  const sess = parseSession(symbolInfo?.session);
  const tzName = symbolInfo?.timezone ?? null;
  const plain = stepTime(t, 1, iv);
  if (!sess || !tzName) {
    return isIntraday(iv) ? t + intervalSeconds(iv) : plain;
  }
  const tz = createTzConverter(tzName);
  const [start, end] = sess;
  const local = tz.toLocal(t);
  const day = Math.floor(local / DAY);
  if (isIntraday(iv)) {
    const nominal = t + intervalSeconds(iv);
    if (prepost) return nominal;
    // The trading day of the bar: a session wrapping midnight ends on the next local day.
    const tod = local - day * DAY;
    const endDay = start < end ? day : tod >= start ? day + 1 : day;
    const sessionEnd = fromLocal(tz, endDay * DAY + end);
    return sessionEnd > t ? Math.min(nominal, sessionEnd) : nominal;
  }
  let lastDay: number;
  if (iv.unit === 'day') lastDay = addWeekdays(day, iv.count);
  else {
    // Last local day covered by the bar: the day before the next bar's nominal open.
    const nextLocalDay = Math.floor(tz.toLocal(plain) / DAY);
    lastDay = lastWeekdayIn(day, Math.max(day, nextLocalDay - 1));
  }
  return fromLocal(tz, lastDay * DAY + end);
}

/** Rule 2 deadline of bar i in unix s: `barEnd + grace`. */
export function closeDeadline(
  i: number,
  series: CloseSeries,
  symbolInfo: CloseSymbolInfo | null,
  prepost: boolean,
  interval: Interval | string,
  graceS: number = DEFAULT_CLOSE_GRACE_S,
): number {
  return barEnd(i, series, symbolInfo, prepost, interval) + graceS;
}

/**
 * Close event time of a bar from history, ms: the earlier of the next bar's
 * open (rule 1, when a next bar exists) and the rule 2 deadline. This is the
 * `closedAt` the evaluator's close-mode activation rule expects.
 */
export function closeEventTime(
  i: number,
  series: CloseSeries,
  symbolInfo: CloseSymbolInfo | null,
  prepost: boolean,
  interval: Interval | string,
  graceS: number = DEFAULT_CLOSE_GRACE_S,
): number {
  const deadline = closeDeadline(i, series, symbolInfo, prepost, interval, graceS);
  const next = i + 1 < series.length ? series.time[i + 1] : undefined;
  return (next === undefined ? deadline : Math.min(next, deadline)) * 1000;
}

export interface CloseEvent {
  /** Open time of the bar that closed. */
  barTime: number;
  rule: 'nextBar' | 'clock';
  /** ms */
  at: number;
}

export interface CloseTrackerOptions {
  interval: Interval | string;
  symbolInfo: CloseSymbolInfo | null;
  prepost: boolean;
  /** `ALERTS_CLOSE_GRACE_S` (default 60). */
  graceS?: number;
}

/**
 * Close state of the newest bar of one series. Each bar closes at most once:
 * later revisions of a closed bar (a restated daily bar) or of an older bar do
 * not close it again, and a day without a bar (holiday) emits nothing.
 */
export class CloseTracker {
  private readonly interval: Interval;
  private readonly info: CloseSymbolInfo | null;
  private readonly prepost: boolean;
  private readonly grace: number;
  private last: number | null = null;
  private lastClosed = false;
  private deadline = Infinity;

  constructor(opts: CloseTrackerOptions) {
    this.interval = toInterval(opts.interval);
    this.info = opts.symbolInfo;
    this.prepost = opts.prepost;
    this.grace = opts.graceS ?? DEFAULT_CLOSE_GRACE_S;
  }

  /** Open time of the newest bar, or null. */
  get lastBarTime(): number | null {
    return this.last;
  }

  /** Whether the newest bar is closed. */
  get closed(): boolean {
    return this.lastClosed;
  }

  /**
   * Reset to a loaded history whose newest bar opens at `barTime`, closed or
   * not (for example from `closeEventTime(...) <= now`).
   */
  reset(barTime: number | null, closed: boolean): void {
    this.last = barTime;
    this.lastClosed = barTime !== null && closed;
    this.deadline = barTime === null ? Infinity : this.deadlineOf(barTime);
  }

  /**
   * A feed bar with open time `time` arrived at `now` (ms). Returns the close
   * of the previous newest bar if this bar is newer and that bar was still open.
   * `kind`: same bar (update), newer (append) or older (ignored).
   */
  onBar(
    time: number,
    now: number,
  ): { kind: 'update' | 'append' | 'old'; closed: CloseEvent | null } {
    if (this.last !== null && time < this.last) return { kind: 'old', closed: null };
    if (this.last !== null && time === this.last) return { kind: 'update', closed: null };
    const prev = this.last;
    const closed: CloseEvent | null =
      prev !== null && !this.lastClosed ? { barTime: prev, rule: 'nextBar', at: now } : null;
    this.last = time;
    this.lastClosed = false;
    this.deadline = this.deadlineOf(time);
    return { kind: 'append', closed };
  }

  /** Clock tick at `now` (ms): rule 2 for the newest bar. */
  onClock(now: number): CloseEvent | null {
    if (this.last === null || this.lastClosed) return null;
    if (now < this.deadline * 1000) return null;
    this.lastClosed = true;
    return { barTime: this.last, rule: 'clock', at: now };
  }

  private deadlineOf(time: number): number {
    return closeDeadline(
      0,
      { time: [time], length: 1 },
      this.info,
      this.prepost,
      this.interval,
      this.grace,
    );
  }
}
