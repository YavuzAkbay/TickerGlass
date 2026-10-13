import { describe, expect, it } from 'vitest';
import {
  formatInterval,
  intervalSeconds,
  intervalsEqual,
  isIntraday,
  parseInterval,
  resampleBase,
  toApiInterval,
} from './intervals';

describe('parseInterval / formatInterval', () => {
  const canonical = [
    '1m',
    '2m',
    '3m',
    '5m',
    '10m',
    '15m',
    '30m',
    '45m',
    '90m',
    '1h',
    '2h',
    '3h',
    '4h',
    '1D',
    '2D',
    '3D',
    '1W',
    '2W',
    '1M',
    '3M',
    '6M',
    '12M',
  ];

  it.each(canonical)('round-trips %s', (s) => {
    expect(formatInterval(parseInterval(s))).toBe(s);
  });

  it('distinguishes minutes from months by case', () => {
    expect(parseInterval('1m')).toEqual({ unit: 'minute', count: 1 });
    expect(parseInterval('1M')).toEqual({ unit: 'month', count: 1 });
  });

  it('accepts H for hours and normalizes whole-hour minutes', () => {
    expect(parseInterval('4H')).toEqual({ unit: 'hour', count: 4 });
    expect(formatInterval(parseInterval('60m'))).toBe('1h');
    expect(formatInterval(parseInterval('240m'))).toBe('4h');
  });

  it.each(['', 'm', '0m', '-1m', '1x', '1.5h', '1 m', 'abc', '1Y', '1mo', '100001m'])(
    'throws on %j',
    (s) => {
      expect(() => parseInterval(s)).toThrow();
    },
  );
});

describe('interval helpers', () => {
  it('computes nominal seconds', () => {
    expect(intervalSeconds(parseInterval('3m'))).toBe(180);
    expect(intervalSeconds(parseInterval('4h'))).toBe(14_400);
    expect(intervalSeconds(parseInterval('2D'))).toBe(172_800);
    expect(intervalSeconds(parseInterval('1W'))).toBe(604_800);
    expect(intervalSeconds(parseInterval('1M'))).toBe(30 * 86_400);
  });

  it('classifies intraday', () => {
    expect(isIntraday(parseInterval('45m'))).toBe(true);
    expect(isIntraday(parseInterval('4h'))).toBe(true);
    expect(isIntraday(parseInterval('1D'))).toBe(false);
  });

  it('treats 60m and 1h as equal', () => {
    expect(intervalsEqual(parseInterval('60m'), parseInterval('1h'))).toBe(true);
    expect(intervalsEqual(parseInterval('7D'), parseInterval('1W'))).toBe(false);
  });

  it('maps native intervals to API strings', () => {
    const cases: [string, string | null][] = [
      ['1m', '1m'],
      ['2m', '2m'],
      ['5m', '5m'],
      ['15m', '15m'],
      ['30m', '30m'],
      ['1h', '60m'],
      ['60m', '60m'],
      ['90m', '90m'],
      ['1D', '1d'],
      ['1W', '1wk'],
      ['1M', '1mo'],
      ['3M', '3mo'],
      ['3m', null],
      ['4h', null],
      ['5D', null],
      ['2W', null],
      ['6M', null],
    ];
    for (const [s, api] of cases) expect(toApiInterval(parseInterval(s)), s).toBe(api);
  });
});

describe('resampleBase', () => {
  const cases: [string, string, number][] = [
    ['3m', '1m', 3],
    ['10m', '5m', 2],
    ['45m', '15m', 3],
    ['2h', '1h', 2],
    ['3h', '1h', 3],
    ['4h', '1h', 4],
    ['2D', '1D', 2],
    ['3D', '1D', 3],
    ['2W', '1W', 2],
    ['2M', '1M', 2],
    ['6M', '1M', 6],
    ['12M', '1M', 12],
    ['5M', '1M', 5],
    ['5m', '5m', 1],
    ['1h', '1h', 1],
  ];
  it.each(cases)('%s <- %s x%d', (target, base, factor) => {
    const r = resampleBase(parseInterval(target));
    expect(formatInterval(r.base)).toBe(base);
    expect(r.factor).toBe(factor);
  });
});
