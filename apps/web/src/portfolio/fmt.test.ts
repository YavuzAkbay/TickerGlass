import { afterEach, describe, expect, it } from 'vitest';
import { setFormatLocale } from '../sidebar/format';
import { fmtMoney, fmtMoneySigned, fmtPct, tone } from './fmt';

afterEach(() => setFormatLocale());

describe('money formatting', () => {
  it('never signs a value that rounds to zero', () => {
    setFormatLocale('en-US');
    expect(fmtMoney(-0.001, 'USD')).toBe('$0.00');
    expect(fmtMoney(-0, 'USD')).toBe('$0.00');
    expect(fmtMoney(-0.006, 'USD')).toBe('-$0.01');
    expect(fmtMoneySigned(-0.004, 'USD')).toBe('$0.00');
    expect(fmtMoneySigned(0.004, 'USD')).toBe('$0.00');
    expect(fmtMoneySigned(-12.3, 'USD')).toBe('−$12.30');
    expect(fmtMoneySigned(12.3, 'USD')).toBe('+$12.30');
    expect(fmtMoneySigned(-0.4, 'JPY')).toBe('¥0');
    expect(fmtMoneySigned(-0.6, 'JPY')).toBe('−¥1');
    expect(fmtPct(-0.004)).toBe('0.00%');
  });

  it('tone follows the rounded value when given the precision', () => {
    expect(tone(-0.004)).toBe('pf-down');
    expect(tone(-0.004, 2)).toBe('');
    expect(tone(0.02, 2)).toBe('pf-up');
  });
});
