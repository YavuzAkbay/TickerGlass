import { beforeEach, describe, expect, it } from 'vitest';
import { serverScreenerCsv } from '../screenerCsv';
import { DEFAULT_SCREENER_PREFS, parseScreenerPrefs, useScreenerPrefs } from '../screenerPrefs';
import { formulaColumnDef, formulaText } from './columnDefs';
import {
  columnSortField,
  isFormulaColumn,
  isServerColumn,
  normalizeServerColumns,
  requestFields,
} from './columns';
import { parseFilter, parseSpec } from './spec';
import type { ScanRow } from './types';

describe('formula column ids', () => {
  it('accepts well-formed formulas only', () => {
    expect(isFormulaColumn('=last / sma200')).toBe(true);
    expect(isServerColumn('=last / sma200')).toBe(true);
    expect(isServerColumn('rsi14')).toBe(true);
    for (const bad of ['=', '=last +', '=last; DROP', '=1e5', `=${'x'.repeat(201)}`, 'last', 3])
      expect(isFormulaColumn(bad)).toBe(false);
  });

  it('normalizes: fixed columns in canonical order, then up to 3 formulas', () => {
    expect(
      normalizeServerColumns(['rsi14', '=a', 'bogus', 'name', '=a', '=b', '=c +', '=c', '=d']),
    ).toEqual(['name', 'rsi14', '=a', '=b', '=c']);
  });

  it('requests formula values and never sorts by them', () => {
    expect(requestFields(['name', '=last / sma200'], 'rsi14')).toEqual([
      'last',
      'chg1d',
      'volume',
      'rsi14',
      '=last / sma200',
    ]);
    expect(columnSortField('=last / sma200')).toBeNull();
  });

  it('formats values and labels the column', () => {
    expect(formulaText(null)).toBe('');
    expect(formulaText(1.123456)).toBe('1.1235');
    expect(formulaText(123.456)).toBe('123.46');
    expect(formulaText(-2_500_000)).toBe('-2.50M');
    const def = formulaColumnDef('=last / sma200', 'vs 200');
    expect(def).toMatchObject({ id: '=last / sma200', label: 'vs 200', sortable: false });
    expect(def.title).toBe('vs 200 = last / sma200');
    const row: ScanRow = {
      symbol: 'A',
      name: 'A',
      cls: 'stocks',
      group: 'g',
      exchange: null,
      stale: false,
      values: { '=last / sma200': 1.1 },
    };
    expect(def.render({ row } as never).text).toBe('1.1');
  });
});

describe('formula column prefs', () => {
  beforeEach(() => useScreenerPrefs.setState({ ...DEFAULT_SCREENER_PREFS }));

  it('adds (at most 3, no duplicates), keeps them across toggles and removes', () => {
    const s = () => useScreenerPrefs.getState();
    s().addFormulaColumn(' last / sma200 ', ' Dist ');
    s().addFormulaColumn('last / sma200');
    s().addFormulaColumn('last +');
    expect(s().serverColumns.filter(isFormulaColumn)).toEqual(['=last / sma200']);
    expect(s().formulaLabels).toEqual({ '=last / sma200': 'Dist' });
    s().addFormulaColumn('rsi14 * 2');
    s().addFormulaColumn('abs(chg1d)');
    s().addFormulaColumn('volume / 2');
    expect(s().serverColumns.filter(isFormulaColumn)).toHaveLength(3);
    s().toggleServerColumn('pe');
    expect(s().serverColumns).toContain('pe');
    expect(s().serverColumns.slice(-3)).toEqual(['=last / sma200', '=rsi14 * 2', '=abs(chg1d)']);
    s().removeFormulaColumn('=last / sma200');
    expect(s().serverColumns).not.toContain('=last / sma200');
    expect(s().formulaLabels).toEqual({});
  });

  it('loads formula columns from a saved spec and from storage', () => {
    useScreenerPrefs.getState().applySpec(
      {
        schemaVersion: 1,
        universe: { kind: 'class', cls: 'stocks' },
        filter: null,
        sort: { field: 'rsi14', dir: 'asc' },
        columns: ['last', '=last / sma200', '=bad +'],
      },
      'x',
    );
    expect(useScreenerPrefs.getState().serverColumns).toEqual(['last', '=last / sma200']);
    const parsed = parseScreenerPrefs({
      serverColumns: ['=rsi14 - prev(rsi14)', 'name'],
      formulaLabels: { '=rsi14 - prev(rsi14)': ' Δ RSI ', '=bad +': 'x', '=a': 7 },
    });
    expect(parsed.serverColumns).toEqual(['name', '=rsi14 - prev(rsi14)']);
    expect(parsed.formulaLabels).toEqual({ '=rsi14 - prev(rsi14)': 'Δ RSI' });
  });
});

describe('formula columns in the CSV', () => {
  it('heads them by name (else formula, injection-guarded) and writes the raw value', () => {
    const rows: ScanRow[] = [
      {
        symbol: 'AAA',
        name: 'AAA',
        cls: 'stocks',
        group: 'g',
        exchange: null,
        stale: false,
        values: { '=last / sma200': 1.1, '=-rsi14': null },
      },
    ];
    const csv = serverScreenerCsv(rows, ['=last / sma200', '=-rsi14'], {
      '=last / sma200': 'Dist',
    });
    expect(csv.split('\n')).toEqual(["Symbol,Dist,'-rsi14", 'AAA,1.1,']);
  });
});

describe('stored specs with formulas', () => {
  const base = {
    schemaVersion: 1,
    universe: { kind: 'class', cls: 'stocks' },
    sort: { field: 'rsi14', dir: 'asc' },
  };

  it('drops formula rules over the length limit (code points)', () => {
    const rule = (formula: string) => ({ formula, op: '>', value: 1 });
    const ok = 'x'.repeat(150) + '\u{1F600}'.repeat(50);
    expect(parseFilter({ op: 'and', rules: [rule(ok)] })?.rules).toHaveLength(1);
    expect(parseFilter({ op: 'and', rules: [rule(ok + 'x')] })).toBeNull();
  });

  it('keeps at most 3 well-formed formula columns of at most 201 characters', () => {
    const spec = parseSpec({
      ...base,
      columns: ['last', '=a', '=b +', `=${'x'.repeat(201)}`, '=b', '=c', '=d', 'rsi14'],
    });
    expect(spec?.columns).toEqual(['last', '=a', '=b', '=c', 'rsi14']);
    expect(isFormulaColumn(`=${'x'.repeat(200)}`)).toBe(true);
  });
});
