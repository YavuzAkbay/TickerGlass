import { afterEach, describe, expect, it } from 'vitest';
import {
  currencyPrefix,
  fmtCap,
  fmtCompact,
  fmtInt,
  fmtMultiple,
  fmtPrice,
  fmtSigned,
  formatLocale,
  setFormatLocale,
} from './format';

afterEach(() => setFormatLocale());

describe('number formatting locale', () => {
  it('defaults to the browser language, en-US without one', () => {
    expect(formatLocale()).toBe(navigator.language || 'en-US');
    setFormatLocale('de-DE');
    expect(formatLocale()).toBe('de-DE');
  });

  it('formats with the active locale and recovers from a malformed tag', () => {
    setFormatLocale('en-US');
    expect(fmtPrice(1234.5)).toBe('1,234.50');
    expect(fmtInt(1234567)).toBe('1,234,567');
    expect(fmtSigned(-1234.5, 2, '%')).toBe('−1,234.50%');
    setFormatLocale('de-DE');
    expect(fmtPrice(1234.5)).toBe('1.234,50');
    expect(fmtCompact(12.5)).toBe('12,5');
    setFormatLocale('not a locale!!');
    expect(fmtPrice(1234.5)).toBe('1,234.50');
  });

  it('dashes non-numbers', () => {
    expect(fmtPrice(null)).toBe('—');
    expect(fmtCap(undefined)).toBe('—');
    expect(fmtMultiple(NaN)).toBe('—');
  });
});

describe('fmtCap', () => {
  it('compacts to one decimal below 100 units, none above', () => {
    setFormatLocale('en-US');
    expect(fmtCap(1.2e12)).toBe('$1.2T');
    expect(fmtCap(350e9)).toBe('$350B');
    expect(fmtCap(12.34e9)).toBe('$12.3B');
    expect(fmtCap(950_000)).toBe('$950,000');
  });
});

describe('currencyPrefix', () => {
  it('is empty for USD and missing currencies, a symbol otherwise', () => {
    setFormatLocale('en-US');
    expect(currencyPrefix('USD')).toBe('');
    expect(currencyPrefix(null)).toBe('');
    expect(currencyPrefix('EUR')).toBe('€');
    expect(currencyPrefix('JPY')).toBe('¥');
    expect(currencyPrefix('GBp')).toBe('p');
    expect(currencyPrefix('??')).toBe('');
  });

  it('does not print a bare $ for non-USD dollar currencies', () => {
    setFormatLocale('en-US');
    expect(currencyPrefix('CAD')).toBe('CA$');
    expect(currencyPrefix('AUD')).toBe('A$');
    expect(currencyPrefix('HKD')).toBe('HK$');
    for (const c of ['CAD', 'AUD', 'HKD', 'SGD', 'NZD', 'MXN'])
      expect(currencyPrefix(c), c).not.toBe('$');
    // Where even the plain symbol is `$`, the ISO code tells them apart.
    setFormatLocale('en-CA');
    expect(currencyPrefix('CAD')).not.toBe('$');
    expect(currencyPrefix('CAD')).not.toBe('');
  });
});
