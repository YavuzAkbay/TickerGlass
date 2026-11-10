import { describe, expect, it } from 'vitest';
import type { LiveQuote } from '../../quotes/types';
import type { ScanRow } from '../server/types';
import type { UniverseSymbol } from '../universe/types';
import {
  aggregateRows,
  effectiveGroupBy,
  groupByChoices,
  groupByLabelKey,
  groupKeyOf,
  rowCap,
  rowChange,
} from './groupBy';

const u = (symbol: string, group: string, cap?: number): UniverseSymbol => ({
  symbol,
  name: symbol,
  rank: 1,
  group,
  ...(cap ? { cap } : {}),
});
const scanRow = (symbol: string, values: ScanRow['values']): ScanRow => ({
  symbol,
  name: symbol,
  cls: 'stocks',
  group: 'g',
  exchange: null,
  stale: false,
  values,
});
const q = (over: Partial<LiveQuote>): LiveQuote =>
  ({ symbol: 'X', changePercent: null, marketCap: null, ...over }) as LiveQuote;

describe('groupKeyOf', () => {
  it('groups by the universe group, or in server mode by the snapshot sector', () => {
    const s = u('A', 'Tech');
    expect(groupKeyOf('group', s, undefined)).toBe('Tech');
    expect(groupKeyOf('sector', s, scanRow('A', { sector: 'Technology' }))).toBe('Technology');
    // No sector value: the universe group stands in.
    expect(groupKeyOf('sector', s, scanRow('A', { sector: null }))).toBe('Tech');
    expect(groupKeyOf('sector', s, undefined)).toBe('Tech');
    expect(groupKeyOf('group', s, scanRow('A', { sector: 'Technology' }))).toBe('Tech');
    expect(groupKeyOf('group', u('B', ''), undefined)).toBe('');
  });
});

describe('group choices', () => {
  it('the server offers sector and group, the client only the universe group', () => {
    expect(groupByChoices(true)).toEqual(['none', 'sector', 'group']);
    expect(groupByChoices(false)).toEqual(['none', 'group']);
    expect(effectiveGroupBy('sector', false)).toBe('group');
    expect(effectiveGroupBy('sector', true)).toBe('sector');
    expect(effectiveGroupBy('none', false)).toBe('none');
  });

  it('labels the client group after the class (sector / category / group)', () => {
    expect(groupByLabelKey('group', { groupLabel: 'sector' }, false)).toBe('hm.group.sector');
    expect(groupByLabelKey('group', { groupLabel: 'category' }, false)).toBe('hm.group.category');
    expect(groupByLabelKey('group', { groupLabel: 'group' }, false)).toBe('hm.group.group');
    expect(groupByLabelKey('group', { groupLabel: 'sector' }, true)).toBe('hm.group.group');
    expect(groupByLabelKey('none', { groupLabel: 'sector' }, true)).toBe('hm.group.none');
  });
});

describe('row values and aggregates', () => {
  it('change: live quote, snapshot otherwise', () => {
    expect(rowChange(q({ changePercent: 2 }), scanRow('A', { chg1d: 1 }))).toBe(2);
    expect(rowChange(undefined, scanRow('A', { chg1d: 1 }))).toBe(1);
    expect(rowChange(undefined, undefined)).toBeNull();
  });

  it('cap: live, snapshot, then the static cap (billions) in USD', () => {
    const s = u('A', 'g', 5);
    expect(rowCap(s, q({ marketCap: 9e9 }), scanRow('A', { mcap: 1e9 }))).toBe(9e9);
    expect(rowCap(s, undefined, scanRow('A', { mcap: 1e9 }))).toBe(1e9);
    expect(rowCap(s, undefined, undefined)).toBe(5e9);
    expect(rowCap(u('B', 'g'), undefined, undefined)).toBeNull();
  });

  it('aggregates a group: count, mean change, total cap', () => {
    const rows = [u('A', 'g', 1), u('B', 'g', 2), u('C', 'g')];
    const agg = aggregateRows(
      rows,
      { A: q({ changePercent: 3 }), B: q({ changePercent: -1 }) },
      undefined,
    );
    expect(agg.count).toBe(3);
    expect(agg.avgChange).toBeCloseTo(1);
    expect(agg.totalCap).toBe(3e9);
  });
});
