import { describe, expect, it } from 'vitest';
import { detectDelimiter, inferDecimalSeparator, parseCsv, parseDate, parseNumber } from './parse';
import { fnv1a } from './common';

describe('parseCsv', () => {
  it('parses plain rows and ignores a trailing newline', () => {
    expect(parseCsv('a,b,c\n1,2,3\n')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  it('handles quotes, escaped quotes, delimiters and newlines inside quotes', () => {
    expect(parseCsv('"a,b","say ""hi""","line1\nline2",x')).toEqual([
      ['a,b', 'say "hi"', 'line1\nline2', 'x'],
    ]);
  });

  it('handles CRLF, lone CR, blank lines and a BOM', () => {
    expect(parseCsv('﻿a,b\r\n\r\n1,2\r3,4')).toEqual([
      ['a', 'b'],
      ['1', '2'],
      ['3', '4'],
    ]);
  });

  it('keeps empty fields, including a trailing one and a quoted empty line', () => {
    expect(parseCsv('a,,c,\n"",x')).toEqual([
      ['a', '', 'c', ''],
      ['', 'x'],
    ]);
  });

  it('supports other delimiters and literal quotes mid-field', () => {
    expect(parseCsv('a;b"c;d', ';')).toEqual([['a', 'b"c', 'd']]);
    expect(parseCsv('a\tb', '\t')).toEqual([['a', 'b']]);
  });

  it('survives an unterminated quote', () => {
    expect(parseCsv('a,"b\nc')).toEqual([['a', 'b\nc']]);
  });
});

describe('detectDelimiter', () => {
  it('picks the delimiter outside quotes', () => {
    expect(detectDelimiter('a,b,c\n1,2,3')).toBe(',');
    expect(detectDelimiter('a;b;c\n"1,5";2;3')).toBe(';');
    expect(detectDelimiter('a\tb\tc\n1\t2\t3')).toBe('\t');
    expect(detectDelimiter('title only\n')).toBe(',');
  });
});

describe('parseNumber', () => {
  it.each([
    ['1234.56', undefined, 1234.56],
    ['1,234.56', undefined, 1234.56],
    ['1.234,56', undefined, 1234.56],
    ['1,234,567', undefined, 1234567],
    ['1.234.567,8', undefined, 1234567.8],
    ['12,5', undefined, 12.5],
    ['1,234', undefined, 1234],
    ['1,234', ',', 1.234],
    ['1.234', ',', 1234],
    ['$1,234.56', undefined, 1234.56],
    ['-$3.50', undefined, -3.5],
    ['(12.50)', undefined, -12.5],
    ['7-', undefined, -7],
    ['+4', undefined, 4],
    ['€ 2 000,50', undefined, 2000.5],
    ['1.5E-05', undefined, 0.000015],
    ['  42  ', undefined, 42],
  ] as const)('%s -> %s', (input, hint, expected) => {
    expect(parseNumber(input, hint)).toBeCloseTo(expected, 10);
  });

  it.each([[''], ['-'], ['abc'], [undefined], [null]])('rejects %s', (input) => {
    expect(parseNumber(input as string | undefined)).toBeNull();
  });
});

describe('inferDecimalSeparator', () => {
  it('votes by the samples', () => {
    expect(inferDecimalSeparator(['185,50', '1.234,56', '3'])).toBe(',');
    expect(inferDecimalSeparator(['185.50', '1,234.56'])).toBe('.');
    expect(inferDecimalSeparator([])).toBe('.');
    expect(inferDecimalSeparator(['1,234', '2,000'])).toBe('.');
  });
});

describe('parseDate', () => {
  it.each([
    ['2024-01-15', '2024-01-15T12:00:00.000Z'],
    ['2024-01-15 09:30:05', '2024-01-15T09:30:05.000Z'],
    ['2024-01-15T09:30:05.123Z', '2024-01-15T09:30:05.000Z'],
    ['2024-01-15T09:30:00+02:00', '2024-01-15T07:30:00.000Z'],
    ['20240115;093000', '2024-01-15T09:30:00.000Z'],
    ['20240115', '2024-01-15T12:00:00.000Z'],
    ['2024-01-15, 09:30:00', '2024-01-15T09:30:00.000Z'],
    ['01/15/2024', '2024-01-15T12:00:00.000Z'],
    ['15/01/2024', '2024-01-15T12:00:00.000Z'],
    ['15.01.2024 09:30', '2024-01-15T09:30:00.000Z'],
    ['15-01-2024', '2024-01-15T12:00:00.000Z'],
    ['1/5/24', '2024-01-05T12:00:00.000Z'],
    ['2024/01/15', '2024-01-15T12:00:00.000Z'],
  ])('%s', (input, expected) => {
    expect(parseDate(input)).toBe(expected);
  });

  it('respects the day/month order for ambiguous dates', () => {
    expect(parseDate('03/04/2024')).toBe('2024-03-04T12:00:00.000Z');
    expect(parseDate('03/04/2024', { order: 'dmy' })).toBe('2024-04-03T12:00:00.000Z');
  });

  it('uses the separate time when the date has none', () => {
    expect(parseDate('15-01-2024', { order: 'dmy', time: '09:30' })).toBe(
      '2024-01-15T09:30:00.000Z',
    );
    expect(parseDate('20240115', { time: '093000' })).toBe('2024-01-15T09:30:00.000Z');
  });

  it.each([[''], ['hello'], ['2024-13-01'], ['31/02/2024'], ['2024-01-15 25:00']])(
    'rejects %s',
    (input) => {
      expect(parseDate(input)).toBeNull();
    },
  );
});

describe('fnv1a', () => {
  it('is deterministic and sensitive to input', () => {
    expect(fnv1a('a')).toBe('e40c292c');
    expect(fnv1a('a')).toBe(fnv1a('a'));
    expect(fnv1a('a')).not.toBe(fnv1a('b'));
  });
});
