import { describe, expect, it } from 'vitest';
import { subunitOf, toLedgerUnit, unitFactor } from './subunit';

describe('subunitOf', () => {
  it('knows pence, cents and agorot', () => {
    for (const c of ['GBp', 'GBX']) expect(subunitOf(c)).toEqual({ major: 'GBP', divisor: 100 });
    for (const c of ['ZAc', 'ZAC']) expect(subunitOf(c)).toEqual({ major: 'ZAR', divisor: 100 });
    expect(subunitOf('ILA')).toEqual({ major: 'ILS', divisor: 100 });
  });
  it('is null for major currencies and missing values', () => {
    for (const c of ['GBP', 'ZAR', 'ILS', 'USD', '', null, undefined])
      expect(subunitOf(c)).toBeNull();
  });
});

describe('unitFactor / toLedgerUnit', () => {
  it('divides by 100 when the ledger is the major unit', () => {
    expect(unitFactor('GBp', 'GBP')).toBe(0.01);
    expect(toLedgerUnit(7250, 'GBp', 'GBP')).toBeCloseTo(72.5);
    expect(toLedgerUnit(1234, 'ZAc', 'ZAR')).toBeCloseTo(12.34);
    expect(toLedgerUnit(500, 'ILA', 'ILS')).toBeCloseTo(5);
    expect(toLedgerUnit(100, 'GBX', 'GBP')).toBeCloseTo(1);
  });
  it('leaves prices alone when the units already agree or cannot be converted', () => {
    expect(toLedgerUnit(72.5, 'GBP', 'GBP')).toBe(72.5);
    expect(toLedgerUnit(7250, 'GBp', 'GBp')).toBe(7250); // ledger kept in pence
    expect(toLedgerUnit(7250, 'GBp', 'USD')).toBe(7250); // no sub-unit relation: unchanged
    expect(toLedgerUnit(10, null, 'GBP')).toBe(10);
    expect(toLedgerUnit(10, 'GBp', undefined)).toBe(10);
  });
  it('passes missing prices through', () => {
    expect(toLedgerUnit(undefined, 'GBp', 'GBP')).toBeUndefined();
    expect(toLedgerUnit(null, 'GBp', 'GBP')).toBeNull();
    expect(toLedgerUnit(Number.NaN, 'GBp', 'GBP')).toBeNaN();
  });
});
