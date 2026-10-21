import { intervalSeconds } from '../feed/intervals';
import { createTzConverter, type TzConverter } from '../scale/timezone';
import type { Interval } from '../types';

const DAY = 86_400;
/** Raw bars inspected to learn the trading week and day. */
const SAMPLE = 2000;
/** Day iterations before falling back to a plain calendar estimate. */
const MAX_DAYS = 40_000;

/** Full trading days (modal first and last bar) needed to learn an intraday day shape. */
const MIN_FULL_DAYS = 2;
/** Years of the newest raw bars searched for recurring holidays (schedules change over time). */
const HOLIDAY_YEARS = 5;
/** Occurrences (all missing) a holiday rule needs before it is trusted. */
const MIN_HOLIDAY_SEEN = 2;
/** Easter-relative offsets (days) considered: Carnival (-48) .. Corpus Christi (+60). */
const EASTER_MIN = -50;
const EASTER_MAX = 60;

/**
 * Trading calendar for anchors past the last bar (docs/drawings.md §3): bar
 * slots skip weekends (unless the data has weekend bars), recurring exchange
 * holidays learned from the data (see `learnHolidays`) and, intraday, the
 * hours outside the trading day (the regular session when given, else the
 * typical day seen in the data), so overnight gaps, weekends and holidays are
 * not counted as slots. Slot times lie on the bar grid from the day's first slot.
 */
export interface TradingCalendar {
  /** Time of slot `k` (whole, >= 0) after the slot opening at `from` (k = 0 is `from`). */
  step(from: number, k: number): number;
  /** Fractional slots from `from` to `t` (t >= from); a time in a non-trading gap maps to the next slot. */
  slots(from: number, t: number): number;
}

interface Shape {
  tz: TzConverter;
  iv: number;
  /** Data has bars on Saturday/Sunday (crypto): every day trades. */
  weekends: boolean;
  /** Intraday: first slot of the trading day, local seconds of day. */
  dayStart: number;
  /** Intraday: slots per trading day (0 = round the clock from local midnight, only weekend skipping). */
  perDay: number;
  /** Recurring holidays learned from the data; null when none. */
  holidays: Holidays | null;
}

/**
 * Recurring exchange holidays, as rules a local day number can be tested
 * against. Keys: `month * 100 + day` (fixed dates), `month * 100 + weekday * 10
 * + nth` (nth weekday of the month, 9 = last), days from Easter Sunday.
 */
interface Holidays {
  fixed: Set<number>;
  nth: Set<number>;
  easter: Set<number>;
  /** Fixed dates observed on the Friday before when they fall on a Saturday. */
  satToFri: Set<number>;
  /** Fixed dates observed on the Monday after when they fall on a Sunday. */
  sunToMon: Set<number>;
}

const SESSION_RE = /^(\d{2})(\d{2})-(\d{2})(\d{2})$/;

/** Regular session "HHMM-HHMM" as [start, end) local seconds of day; null when absent or invalid. */
function parseSession(session: string | null): [number, number] | null {
  const m = SESSION_RE.exec(session?.trim() ?? '');
  if (!m) return null;
  const [sh, sm, eh, em] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (sh > 23 || sm > 59 || eh > 24 || em > 59) return null;
  const start = sh * 3600 + sm * 60;
  const end = (eh === 23 && em === 59) || eh === 24 ? DAY : eh * 3600 + em * 60;
  return [start, end];
}

/** Most frequent value (ties: the first one reaching the top count). */
function mode(values: number[]): number {
  const counts = new Map<number, number>();
  let best = values[0]!;
  let top = 0;
  for (const v of values) {
    const c = (counts.get(v) ?? 0) + 1;
    counts.set(v, c);
    if (c > top) {
      top = c;
      best = v;
    }
  }
  return best;
}

const weekday = (localDay: number) => (localDay + 4) % 7; // 1970-01-01 was a Thursday (4)
const weekendDay = (s: Shape, localDay: number) => {
  if (s.weekends) return false;
  const wd = weekday(localDay);
  return wd === 0 || wd === 6;
};
const tradingDay = (s: Shape, localDay: number) =>
  !weekendDay(s, localDay) && !(s.holidays && isHoliday(s.holidays, localDay));

/** Civil date of a day number (days since 1970-01-01) as `year * 10000 + month * 100 + day`. */
function civil(z0: number): number {
  const z = z0 + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return (yoe + era * 400 + (m <= 2 ? 1 : 0)) * 10_000 + m * 100 + d;
}

const dayNumber = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d) / 86_400_000;
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

const easterDays = new Map<number, number>();
/** Day number of (Gregorian) Easter Sunday: the anonymous Gregorian computus. */
function easterSunday(y: number): number {
  let e = easterDays.get(y);
  if (e === undefined) {
    const a = y % 19;
    const b = Math.floor(y / 100);
    const c = y % 100;
    const d = Math.floor(b / 4);
    const f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4);
    const k = c % 4;
    const l = (32 + 2 * (b % 4) + 2 * i - h - k) % 7;
    const m = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * m + 114) / 31);
    const day = ((h + l - 7 * m + 114) % 31) + 1;
    e = dayNumber(y, month, day);
    easterDays.set(y, e);
  }
  return e;
}

/** Whether local day `day` (a weekday) is a learned holiday or its observed day. */
function isHoliday(h: Holidays, day: number): boolean {
  const c = civil(day);
  const y = Math.floor(c / 10_000);
  const md = c % 10_000;
  const m = Math.floor(md / 100);
  const d = md % 100;
  const wd = weekday(day);
  if (h.fixed.has(md)) return true;
  const nth = m * 100 + wd * 10;
  if (h.nth.size > 0) {
    if (h.nth.has(nth + Math.ceil(d / 7))) return true;
    if (d + 7 > daysInMonth(y, m) && h.nth.has(nth + 9)) return true;
  }
  if (h.easter.size > 0 && h.easter.has(day - easterSunday(y))) return true;
  if (wd === 5 && h.satToFri.has(civil(day + 1) % 10_000)) return true;
  return wd === 1 && h.sunToMon.has(civil(day - 1) % 10_000);
}

/** Counts of a holiday rule: occurrences on trading weekdays and how many had no bars. */
type Tally = Map<number, [seen: number, missing: number]>;

function tally(t: Tally, key: number, missing: boolean): void {
  const v = t.get(key);
  if (v) {
    v[0]++;
    if (missing) v[1]++;
  } else t.set(key, [1, missing ? 1 : 0]);
}

/** Rules seen at least MIN_HOLIDAY_SEEN times and missing every time. */
function learned(t: Tally): Set<number> {
  const out = new Set<number>();
  for (const [key, [seen, missing]] of t)
    if (seen >= MIN_HOLIDAY_SEEN && missing === seen) out.add(key);
  return out;
}

/**
 * Recurring holidays from weekdays without bars in the newest HOLIDAY_YEARS of
 * data (all of `time`, not only the shape sample). Learned, when every
 * occurrence in that window had no bars and there were at least two: fixed
 * dates (Jan 1, Dec 25), the nth or last weekday of a month (third Monday of
 * January, last Monday of May), days relative to Easter (Good Friday, Easter
 * Monday), and, for learned fixed dates, observance on the Friday before /
 * Monday after when the date falls on a weekend (only once seen so). A new or
 * moved holiday and one-off closures are unknown until they recur; schedules
 * from other calendars (lunar new year) are not learned. A rule needs two
 * weekday occurrences, so in practice two to five years of daily or hourly
 * bars; short intraday histories learn nothing. Gaps inside the data need no
 * rules: anchors there map to bars.
 */
function learnHolidays(
  conv: TzConverter,
  time: ArrayLike<number>,
  length: number,
  weekends: boolean,
): Holidays | null {
  const lastDay = Math.floor(conv.toLocal(time[length - 1]!) / DAY);
  const windowStart = lastDay - HOLIDAY_YEARS * 366;
  if (Math.floor(conv.toLocal(time[0]!) / DAY) > lastDay - 366) return null;
  // First bar of the window (UTC times are sorted; allow a day of offset slack).
  let lo = 0;
  let hi = length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (time[mid]! < (windowStart - 1) * DAY) lo = mid + 1;
    else hi = mid;
  }
  let firstDay = NaN;
  let present = new Uint8Array(0);
  for (let i = lo; i < length; i++) {
    const day = Math.floor(conv.toLocal(time[i]!) / DAY);
    if (day < windowStart) continue;
    if (Number.isNaN(firstDay)) {
      firstDay = day;
      present = new Uint8Array(lastDay - firstDay + 1);
    }
    present[day - firstDay] = 1;
  }
  if (Number.isNaN(firstDay)) return null;
  const has = (day: number) => day >= firstDay && day <= lastDay && present[day - firstDay] === 1;
  const fixed: Tally = new Map();
  const nth: Tally = new Map();
  const easter: Tally = new Map();
  for (let day = firstDay; day <= lastDay; day++) {
    const wd = weekday(day);
    if (!weekends && (wd === 0 || wd === 6)) continue;
    const missing = !has(day);
    const c = civil(day);
    const y = Math.floor(c / 10_000);
    const md = c % 10_000;
    const m = Math.floor(md / 100);
    const d = md % 100;
    tally(fixed, md, missing);
    tally(nth, m * 100 + wd * 10 + Math.ceil(d / 7), missing);
    if (d + 7 > daysInMonth(y, m)) tally(nth, m * 100 + wd * 10 + 9, missing);
    const off = day - easterSunday(y);
    if (off >= EASTER_MIN && off <= EASTER_MAX) tally(easter, off, missing);
  }
  const h: Holidays = {
    fixed: learned(fixed),
    nth: learned(nth),
    easter: learned(easter),
    satToFri: new Set(),
    sunToMon: new Set(),
  };
  if (!weekends) {
    // Weekend observance of learned fixed dates: the adjacent weekday had no
    // bars every time the date fell on that weekend day (inside the data).
    const firstYear = Math.floor(civil(firstDay) / 10_000);
    const lastYear = Math.floor(civil(lastDay) / 10_000);
    for (const md of h.fixed) {
      const sat: Tally = new Map();
      const sun: Tally = new Map();
      for (let y = firstYear; y <= lastYear; y++) {
        const day = dayNumber(y, Math.floor(md / 100), md % 100);
        const wd = weekday(day);
        if (wd === 6 && day - 1 >= firstDay && day - 1 <= lastDay) tally(sat, 0, !has(day - 1));
        if (wd === 0 && day + 1 >= firstDay && day + 1 <= lastDay) tally(sun, 0, !has(day + 1));
      }
      const s = sat.get(0);
      if (s && s[0] === s[1]) h.satToFri.add(md);
      const u = sun.get(0);
      if (u && u[0] === u[1]) h.sunToMon.add(md);
    }
  }
  const any = h.fixed.size + h.nth.size + h.easter.size;
  return any > 0 ? h : null;
}

/** UTC time of local seconds `l` (handles DST up to the transition hour). */
function fromLocal(tz: TzConverter, l: number): number {
  const guess = l - tz.offsetSeconds(l);
  return l - tz.offsetSeconds(guess);
}

/**
 * Calendar for the newest raw bars (times in unix s) of an intraday or daily
 * `interval` in exchange timezone `tz`. Null for weekly and monthly intervals
 * or too little data (callers then step plain intervals).
 *
 * The intraday day shape is the regular `session` ("HHMM-HHMM", exchange
 * time) when given; pass null when the data includes extended hours. Without
 * it, the shape is the modal first and last bar time of day, and at least two
 * full days must match it (so an odd after-hours print or a partial day does
 * not change the shape). Build it once per load / symbol / interval, not per
 * bar: a shape that changes with new bars moves anchors past the last bar.
 * When it is null for lack of data, retrying once per new exchange day is
 * enough (a day completes at most once per day).
 */
export function buildTradingCalendar(
  time: ArrayLike<number>,
  length: number,
  interval: Interval,
  tz: string,
  session: string | null = null,
): TradingCalendar | null {
  const iv = intervalSeconds(interval);
  if (length < 2 || !(iv > 0) || interval.unit === 'week' || interval.unit === 'month') return null;
  const conv = createTzConverter(tz);
  const from = Math.max(0, length - SAMPLE);
  let weekends = false;
  const firsts: number[] = [];
  const lasts: number[] = [];
  let curDay = NaN;
  for (let i = from; i < length; i++) {
    const l = conv.toLocal(time[i]!);
    const day = Math.floor(l / DAY);
    const wd = weekday(day);
    if (wd === 0 || wd === 6) weekends = true;
    const tod = l - day * DAY;
    if (day !== curDay) {
      curDay = day;
      firsts.push(tod);
      lasts.push(tod);
    } else lasts[lasts.length - 1] = tod;
  }
  if (iv >= DAY) {
    const holidays = learnHolidays(conv, time, length, weekends);
    const s: Shape = { tz: conv, iv, weekends, dayStart: 0, perDay: 0, holidays };
    return dailyCalendar(s, Math.max(1, Math.round(iv / DAY)));
  }
  let dayStart: number;
  let span: number;
  const sess = parseSession(session);
  if (sess) {
    const [start, end] = sess;
    // Sessions wrapping midnight (futures, FX) trade round the clock on weekdays.
    span = start < end ? end - start : DAY;
    dayStart = start < end ? start : 0;
  } else {
    const first = mode(firsts);
    const last = mode(lasts);
    let full = 0;
    for (let d = 0; d < firsts.length; d++) if (firsts[d] === first && lasts[d] === last) full++;
    if (last < first || full < MIN_FULL_DAYS) return null;
    dayStart = first;
    span = last - first + iv;
  }
  // Round-the-clock data (or sessions wrapping midnight): only weekends are skipped.
  const perDay = span >= DAY - iv ? 0 : Math.max(1, Math.ceil(span / iv));
  if (weekends && perDay === 0) return null; // 24/7: plain stepping
  return intradayCalendar({
    tz: conv,
    iv,
    weekends,
    dayStart: perDay === 0 ? 0 : dayStart,
    perDay,
    holidays: learnHolidays(conv, time, length, weekends),
  });
}

/** Advance `n` trading days from local day `day` (n >= 0). */
function addTradingDays(s: Shape, day: number, n: number): number {
  let d = day;
  for (let left = n, guard = 0; left > 0 && guard < MAX_DAYS; guard++) {
    d++;
    if (tradingDay(s, d)) left--;
  }
  return d;
}

/** Trading days in (a, b] (b >= a). */
function tradingDaysBetween(s: Shape, a: number, b: number): number {
  if (b - a > MAX_DAYS) return Math.round(((b - a) * (s.weekends ? 7 : 5)) / 7);
  let n = 0;
  for (let d = a + 1; d <= b; d++) if (tradingDay(s, d)) n++;
  return n;
}

/** First trading day >= day. */
function nextTradingDay(s: Shape, day: number): number {
  let d = day;
  for (let guard = 0; !tradingDay(s, d) && guard < 31; guard++) d++;
  return d;
}

function dailyCalendar(s: Shape, count: number): TradingCalendar {
  return {
    step(from, k) {
      const l = s.tz.toLocal(from);
      const day = Math.floor(l / DAY);
      const tod = l - day * DAY;
      return fromLocal(s.tz, addTradingDays(s, day, k * count) * DAY + tod);
    },
    slots(from, t) {
      const l0 = s.tz.toLocal(from);
      const d0 = Math.floor(l0 / DAY);
      const tod0 = l0 - d0 * DAY;
      const l = s.tz.toLocal(t);
      let d = Math.floor(l / DAY);
      let frac = (l - d * DAY - tod0) / DAY;
      if (frac < 0) {
        // Before the bar's time of day: still inside the previous day's slot.
        d--;
        frac += 1;
      }
      if (!tradingDay(s, d)) {
        d = nextTradingDay(s, d);
        frac = 0;
      }
      return (tradingDaysBetween(s, d0, d) + Math.min(Math.max(frac, 0), 1)) / count;
    },
  };
}

function intradayCalendar(s: Shape): TradingCalendar {
  const { iv, dayStart } = s;
  const perDay = s.perDay;
  // Whole slots: with an interval not dividing a day (7m) the grid restarts at
  // each day's first slot, so the last slot of a day may be short.
  const slotsPerDay = perDay === 0 ? Math.ceil(DAY / iv) : perDay;
  /**
   * Trading day and slot number of a local time (slot may be fractional). A
   * time outside the trading hours (`gap`) maps to the next day's slot 0.
   */
  const position = (t: number): { day: number; slot: number; gap: boolean } => {
    const l = s.tz.toLocal(t);
    let day = Math.floor(l / DAY);
    if (perDay === 0) {
      // Round the clock on weekdays.
      if (!tradingDay(s, day)) return { day: nextTradingDay(s, day), slot: 0, gap: true };
      return { day, slot: (l - day * DAY) / iv, gap: false };
    }
    const rel = l - day * DAY - dayStart;
    if (rel < 0 || !tradingDay(s, day)) {
      if (rel >= 0 || !tradingDay(s, day)) day = nextTradingDay(s, rel >= 0 ? day + 1 : day);
      return { day, slot: 0, gap: true };
    }
    const slot = rel / iv;
    if (slot >= perDay) return { day: nextTradingDay(s, day + 1), slot: 0, gap: true };
    return { day, slot, gap: false };
  };
  /** Whole slot of a bar opening at `from`; a bar in a gap (an odd after-hours
   * print) sits just before the next day's first slot, which stays free. */
  const origin = (from: number): { day: number; slot: number } => {
    const p = position(from);
    return { day: p.day, slot: p.gap ? -1 : Math.round(p.slot) };
  };
  return {
    step(from, k) {
      const p = origin(from);
      const total = p.slot + k;
      const days = Math.floor(total / slotsPerDay);
      const slot = total - days * slotsPerDay;
      const day = addTradingDays(s, p.day, days);
      const base = perDay === 0 ? 0 : dayStart;
      return fromLocal(s.tz, day * DAY + base + slot * iv);
    },
    slots(from, t) {
      const a = origin(from);
      const b = position(t);
      return tradingDaysBetween(s, a.day, b.day) * slotsPerDay + b.slot - a.slot;
    },
  };
}
