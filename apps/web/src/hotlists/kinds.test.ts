import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emptyQuote } from '../quotes/merge';
import type { ListInfo } from '../screener/server/types';
import { setFormatLocale } from '../sidebar/format';
import {
  HOTLIST_KINDS,
  KIND_META,
  defaultUniverse,
  formatMetric,
  hotlistPath,
  isHotlistKind,
  liveChange,
  liveLast,
  liveSymbols,
  resolveUniverse,
  universeOptions,
  type HotlistRow,
} from './kinds';
import { parseHotlistPrefs } from './prefs';

beforeEach(() => setFormatLocale('en-US'));
afterEach(() => setFormatLocale());

const list = (id: string, name: string): ListInfo => ({
  id,
  name,
  kind: id === 'mine' ? 'custom' : 'index',
  asOf: '2026-01',
  source: 'bundled',
  count: 10,
});
const SP = list('sp500', 'S&P 500');
const NDX = list('ndx100', 'Nasdaq-100');

const row = (symbol: string, over: Partial<HotlistRow> = {}): HotlistRow => ({
  symbol,
  name: `${symbol} Inc`,
  value: 1,
  last: 100,
  chg1d: 1.5,
  ...over,
});

describe('kinds', () => {
  it('describes every kind', () => {
    expect(HOTLIST_KINDS).toHaveLength(11);
    for (const k of HOTLIST_KINDS) {
      expect(KIND_META[k].label).toBe(`hl.kind.${k}`);
      expect(isHotlistKind(k)).toBe(true);
    }
    expect(isHotlistKind('nope')).toBe(false);
    expect(isHotlistKind(3)).toBe(false);
  });
});

describe('formatMetric', () => {
  it('formats per kind', () => {
    expect(formatMetric('gainers', 3)).toBe('+3.00%');
    expect(formatMetric('losers', -4.256)).toBe('−4.26%');
    expect(formatMetric('unusualVolume', 3.2)).toBe('3.20x');
    expect(formatMetric('oversold', 27.4)).toBe('27');
    expect(formatMetric('overbought', 71.6)).toBe('72');
    expect(formatMetric('active', 9e9)).toBe('$9.0B');
    expect(formatMetric('goldenCross', 2)).toBe('2d');
    expect(formatMetric('gapUp', 1.5)).toBe('+1.50%');
  });
  it('shows a dash without a value', () => {
    for (const k of HOTLIST_KINDS) {
      expect(formatMetric(k, null)).toBe('—');
      expect(formatMetric(k, Number.NaN)).toBe('—');
    }
  });
});

describe('universes', () => {
  it('offers index lists first, then the classes', () => {
    const o = universeOptions([NDX, list('mine', 'Mine'), SP]);
    expect(o.map((x) => x.id)).toEqual([
      'list:sp500',
      'list:ndx100',
      'list:mine',
      'stocks',
      'etfs',
      'crypto',
      'commodities',
    ]);
    expect(o[0]).toMatchObject({ key: null, name: 'S&P 500' });
    expect(o[3]).toMatchObject({ key: 'hl.uni.stocks' });
  });
  it('defaults to the S&P 500 when it exists, else stocks', () => {
    expect(defaultUniverse(universeOptions([NDX, SP]))).toBe('list:sp500');
    expect(defaultUniverse(universeOptions([NDX]))).toBe('stocks');
    expect(defaultUniverse(universeOptions([]))).toBe('stocks');
  });
  it('keeps a saved choice only while it is offered', () => {
    const o = universeOptions([SP, NDX]);
    expect(resolveUniverse('list:ndx100', o)).toBe('list:ndx100');
    expect(resolveUniverse('crypto', o)).toBe('crypto');
    expect(resolveUniverse('list:gone', o)).toBe('list:sp500');
    expect(resolveUniverse(null, o)).toBe('list:sp500');
  });
});

describe('hotlistPath', () => {
  it('encodes the query', () => {
    expect(hotlistPath('unusualVolume', 'list:sp500')).toBe(
      '/screener/hotlists?kind=unusualVolume&universe=list%3Asp500&limit=25',
    );
    expect(hotlistPath('gainers', 'etfs', 10)).toBe(
      '/screener/hotlists?kind=gainers&universe=etfs&limit=10',
    );
  });
});

describe('live overlay', () => {
  it('subscribes the first 25 rows only', () => {
    const rows = Array.from({ length: 40 }, (_, i) => row(`S${i}`));
    expect(liveSymbols(rows)).toHaveLength(25);
    expect(liveSymbols(rows)[24]).toBe('S24');
    expect(liveSymbols(rows, 3)).toEqual(['S0', 'S1', 'S2']);
  });
  it('prefers the live quote and falls back to the snapshot', () => {
    const r = row('AAA');
    expect(liveLast(r, undefined)).toBe(100);
    expect(liveChange(r, undefined)).toBe(1.5);
    expect(liveLast(r, emptyQuote('AAA'))).toBe(100);
    expect(liveChange(r, emptyQuote('AAA'))).toBe(1.5);
    const q = { ...emptyQuote('AAA'), last: 105, changePercent: 5 };
    expect(liveLast(r, q)).toBe(105);
    expect(liveChange(r, q)).toBe(5);
    expect(liveChange(row('BBB', { chg1d: null }), undefined)).toBeNull();
  });
});

describe('parseHotlistPrefs', () => {
  it('validates persisted prefs', () => {
    expect(parseHotlistPrefs({ kind: 'oversold', universe: 'etfs' })).toEqual({
      kind: 'oversold',
      universe: 'etfs',
    });
    expect(parseHotlistPrefs({ kind: 'bogus', universe: 3 })).toEqual({
      kind: 'gainers',
      universe: null,
    });
    expect(parseHotlistPrefs(null)).toEqual({ kind: 'gainers', universe: null });
  });
});
