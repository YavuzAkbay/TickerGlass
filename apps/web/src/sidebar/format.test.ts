import { afterEach, describe, expect, it } from 'vitest';
import {
  changeClass,
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

describe('rounding at display precision', () => {
  it('drops the sign when the value rounds to zero', () => {
    setFormatLocale('en-US');
    expect(fmtSigned(-0.004, 2, '%')).toBe('0.00%');
    expect(fmtSigned(0.004, 2, '%')).toBe('0.00%');
    expect(fmtSigned(-0)).toBe('0.00');
    expect(fmtSigned(-0.005, 2)).toBe('−0.01');
    expect(fmtSigned(0.0049, 3)).toBe('+0.005');
  });

  it('keeps colour consistent with the rounded value when given the precision', () => {
    expect(changeClass(-0.004)).toBe('down');
    expect(changeClass(-0.004, 2)).toBe('');
    expect(changeClass(-0.006, 2)).toBe('down');
    expect(changeClass(0.5, 0)).toBe('up');
  });

  it('picks the compact unit after rounding', () => {
    setFormatLocale('en-US');
    expect(fmtCompact(999_999)).toBe('1.00M');
    expect(fmtCompact(-999_999)).toBe('-1.00M');
    expect(fmtCompact(999_994)).toBe('999.99K');
    expect(fmtCompact(999_999_999)).toBe('1.00B');
    expect(fmtCompact(999_999_999_999)).toBe('1.00T');
    expect(fmtCompact(995)).toBe('995');
    expect(fmtCompact(1000)).toBe('1.00K');
  });

  it('promotes market caps that round up to the next unit', () => {
    setFormatLocale('en-US');
    expect(fmtCap(999.6e6)).toBe('$1.0B');
    expect(fmtCap(999.4e6)).toBe('$999M');
    expect(fmtCap(99.96e6)).toBe('$100M');
    expect(fmtCap(999.6e9)).toBe('$1.0T');
    expect(fmtCap(42.5e6)).toBe('$42.5M');
  });
});
