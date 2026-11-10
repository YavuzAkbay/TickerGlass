import { describe, expect, it } from 'vitest';
import { filterItems, matchesFilter } from './filter';
import type { WatchlistItem } from '../types';

const S = (symbol: string): WatchlistItem => ({ type: 'symbol', symbol });
const SEC = (id: string, title = id): WatchlistItem => ({ type: 'section', id, title });

describe('matchesFilter', () => {
  it('matches the symbol or the name, case-insensitively', () => {
    expect(matchesFilter('AAPL', 'Apple Inc.', 'app')).toBe(true);
    expect(matchesFilter('AAPL', 'Apple Inc.', 'apple')).toBe(true);
    expect(matchesFilter('AAPL', 'Apple Inc.', 'msft')).toBe(false);
    expect(matchesFilter('AAPL', undefined, 'aap')).toBe(true);
  });

  it('blank filters match everything', () => {
    expect(matchesFilter('AAPL', undefined, '')).toBe(true);
    expect(matchesFilter('AAPL', undefined, '  ')).toBe(true);
  });
});

describe('filterItems', () => {
  const items: WatchlistItem[] = [
    S('AAPL'),
    SEC('s1', 'Banks'),
    S('JPM'),
    S('BAC'),
    SEC('s2', 'Crypto'),
    S('BTC-USD'),
  ];
  const nameOf = (s: string) => (s === 'AAPL' ? 'Apple Inc.' : undefined);

  it('returns everything unchanged on a blank filter', () => {
    expect(filterItems(items, '', nameOf)).toBe(items);
  });

  it('keeps matching symbols and drops empty sections', () => {
    const out = filterItems(items, 'jpm', nameOf);
    expect(out).toEqual([SEC('s1', 'Banks'), S('JPM')]);
  });

  it('matches by resolved name', () => {
    expect(filterItems(items, 'apple', nameOf)).toEqual([S('AAPL')]);
  });

  it('a matching section title keeps the whole block', () => {
    const out = filterItems(items, 'banks', nameOf);
    expect(out).toEqual([SEC('s1', 'Banks'), S('JPM'), S('BAC')]);
  });

  it('keeps unsectioned matches before sections', () => {
    const out = filterItems(items, 'aapl', nameOf);
    expect(out).toEqual([S('AAPL')]);
  });

  it('returns nothing when nothing matches', () => {
    expect(filterItems(items, 'zzz', nameOf)).toEqual([]);
  });
});
