import { describe, expect, it } from 'vitest';
import { translate } from '../i18n';
import {
  daysLabel,
  daysUntil,
  dividendEvent,
  fmtEventDate,
  finiteOrNull,
  fmtSplitRatio,
  lastSplit,
  nextEarnings,
  periodReturn,
  plainText,
  rangePercent,
  relativeTime,
  safeHttpUrl,
  textOrDash,
} from './helpers';

const t: Parameters<typeof relativeTime>[2] = (k, p) => translate('en', k, p);
const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).getTime();
/** Unix seconds of midnight UTC of the date. */
const utc = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d) / 1000;

describe('safeHttpUrl', () => {
  it('accepts http and https links', () => {
    expect(safeHttpUrl('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(safeHttpUrl('  http://example.com ')).toBe('http://example.com/');
  });

  it('rejects other schemes, relative and malformed urls', () => {
    for (const bad of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      ' javascript:alert(1)',
      'data:text/html,<script>1</script>',
      'vbscript:x',
      'file:///etc/passwd',
      'ftp://example.com',
      '//example.com/x',
      '/relative',
      'example.com',
      'https://',
      '',
      '   ',
    ])
      expect(safeHttpUrl(bad), bad).toBeNull();
    expect(safeHttpUrl(null)).toBeNull();
    expect(safeHttpUrl(42)).toBeNull();
    expect(safeHttpUrl(`https://example.com/${'a'.repeat(3000)}`)).toBeNull();
  });
});

describe('plainText', () => {
  it('flattens whitespace and control characters, and clips', () => {
    expect(plainText('  a\n\tb\u0000c  ')).toBe('a b c');
    expect(plainText('x'.repeat(10), 5)).toBe('xxxx…');
    expect(plainText(undefined)).toBe('');
  });

  it('keeps markup as text (React escapes it)', () => {
    expect(plainText('<img src=x onerror=alert(1)>')).toBe('<img src=x onerror=alert(1)>');
  });
});

describe('relativeTime', () => {
  const now = 1_700_000_000_000;
  const sec = now / 1000;
  it('steps through minutes, hours and days', () => {
    expect(relativeTime(sec - 5, now, t)).toBe('just now');
    expect(relativeTime(sec + 30, now, t)).toBe('just now'); // clock skew
    expect(relativeTime(sec - 5 * 60, now, t)).toBe('5m ago');
    expect(relativeTime(sec - 3 * 3600 - 10, now, t)).toBe('3h ago');
    expect(relativeTime(sec - 2 * 86400, now, t)).toBe('2d ago');
  });
  it('falls back to a short date after a week, and to nothing without a time', () => {
    expect(relativeTime(sec - 10 * 86400, now, t)).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/);
    expect(relativeTime(null, now, t)).toBe('');
    expect(relativeTime(Number.NaN, now, t)).toBe('');
  });
});

describe('event dates', () => {
  it('counts calendar days from local today, reading midnight-UTC times as that date', () => {
    const now = at(2026, 11, 6);
    expect(daysUntil(utc(2026, 11, 6), now)).toBe(0);
    expect(daysUntil(utc(2026, 11, 7), now)).toBe(1);
    expect(daysUntil(utc(2026, 11, 12), now)).toBe(6);
    expect(daysUntil(utc(2026, 11, 5), now)).toBe(-1);
  });

  it('writes midnight-UTC times as their UTC date in any time zone', () => {
    expect(fmtEventDate(utc(2026, 11, 12))).toBe('Nov 12, 2026');
  });

  it('labels the distance', () => {
    expect(daysLabel(0, t)).toBe('today');
    expect(daysLabel(1, t)).toBe('tomorrow');
    expect(daysLabel(6, t)).toBe('in 6 days');
    expect(daysLabel(-1, t)).toBe('yesterday');
    expect(daysLabel(-12, t)).toBe('12 days ago');
  });
});

describe('events picks', () => {
  const now = at(2026, 11, 6);
  it('nextEarnings is the earliest one not yet past', () => {
    const events = {
      earnings: [
        { t: utc(2026, 8, 1) },
        { t: utc(2027, 2, 1) },
        { t: utc(2026, 11, 6) },
        { t: utc(2026, 12, 1) },
      ],
    };
    expect(nextEarnings(events, now)?.t).toBe(utc(2026, 11, 6));
    expect(nextEarnings({ earnings: [{ t: utc(2026, 8, 1) }] }, now)).toBeNull();
    expect(nextEarnings(undefined, now)).toBeNull();
  });

  it('dividendEvent prefers an upcoming ex-date, else the latest past one', () => {
    const past = [
      { t: utc(2026, 2, 1), amount: 0.2 },
      { t: utc(2026, 8, 1), amount: 0.25 },
    ];
    expect(dividendEvent({ dividends: past }, now)).toEqual({ event: past[1], upcoming: false });
    const future = { t: utc(2026, 11, 20), amount: 0.3 };
    expect(dividendEvent({ dividends: [...past, future] }, now)).toEqual({
      event: future,
      upcoming: true,
    });
    expect(dividendEvent({ dividends: [] }, now)).toBeNull();
  });

  it('lastSplit is the most recent one', () => {
    const a = { t: utc(2014, 6, 9), ratio: 7 };
    const b = { t: utc(2020, 8, 31), ratio: 4 };
    expect(lastSplit({ splits: [b, a] })).toBe(b);
    expect(lastSplit({})).toBeNull();
  });

  it('fmtSplitRatio reads forward and reverse splits', () => {
    expect(fmtSplitRatio(4)).toBe('4:1');
    expect(fmtSplitRatio(1.5)).toBe('3:2');
    expect(fmtSplitRatio(0.5)).toBe('1:2');
    expect(fmtSplitRatio(0.1)).toBe('1:10');
    expect(fmtSplitRatio(null)).toBe('—');
    expect(fmtSplitRatio(0)).toBe('—');
  });
});

describe('periodReturn', () => {
  it('uses the live price over the base close, the server value otherwise', () => {
    expect(periodReturn(110, 100, 3)).toBeCloseTo(10);
    expect(periodReturn(null, 100, 3)).toBe(3);
    expect(periodReturn(110, 0, 3)).toBe(3);
    expect(periodReturn(110, null, null)).toBeNull();
  });
});

describe('rangePercent', () => {
  it('places a value in its range and clamps', () => {
    expect(rangePercent(15, 10, 20)).toBe(50);
    expect(rangePercent(5, 10, 20)).toBe(0);
    expect(rangePercent(25, 10, 20)).toBe(100);
    expect(rangePercent(15, 20, 20)).toBeNull();
    expect(rangePercent(null, 10, 20)).toBeNull();
  });
});

describe('untrusted fundamentals fields', () => {
  it('finiteOrNull passes finite numbers only', () => {
    expect(finiteOrNull(12.5)).toBe(12.5);
    for (const v of ['12', NaN, Infinity, null, undefined, {}, []])
      expect(finiteOrNull(v)).toBeNull();
  });

  it('textOrDash passes non-blank strings only (no crash on other types)', () => {
    expect(textOrDash('Technology')).toBe('Technology');
    for (const v of ['', '  ', 7, null, undefined, {}, ['x']]) expect(textOrDash(v)).toBe('—');
  });
});
