import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { buildTable, type ExportInput } from './exportData';
import { buildXlsx, sheetName, xmlText } from './xlsx';

const input = (): ExportInput => ({
  time: Float64Array.from([1_705_208_400, 1_705_208_700]),
  open: Float64Array.from([1, 2]),
  high: Float64Array.from([2, 3]),
  low: Float64Array.from([0, 1]),
  close: Float64Array.from([1.5, 2.5]),
  volume: Float64Array.from([10, 20]),
  studies: [
    {
      title: 'A <b> & "b"',
      plots: [{ id: 'p', title: 'P', offset: 0 }],
      values: { p: Float64Array.from([NaN, 7]) },
      length: 2,
    },
  ],
});

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe('buildXlsx', () => {
  it('produces a zip with the required package parts', () => {
    const files = unzipSync(buildXlsx(buildTable(input()), () => '2024-01-14 05:00', 'AAPL'));
    expect(Object.keys(files).sort()).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/_rels/workbook.xml.rels',
      'xl/styles.xml',
      'xl/workbook.xml',
      'xl/worksheets/sheet1.xml',
    ]);
  });

  it('declares the workbook and sheet in content types and rels', () => {
    const files = unzipSync(buildXlsx(buildTable(input()), () => 't', 'AAPL'));
    const types = decode(files['[Content_Types].xml']!);
    expect(types).toContain('/xl/workbook.xml"');
    expect(types).toContain('/xl/worksheets/sheet1.xml"');
    const root = decode(files['_rels/.rels']!);
    expect(root).toContain('Target="xl/workbook.xml"');
    const rels = decode(files['xl/_rels/workbook.xml.rels']!);
    expect(rels).toContain('Target="worksheets/sheet1.xml"');
    expect(rels).toContain('Target="styles.xml"');
  });

  it('names the sheet after the symbol', () => {
    const files = unzipSync(buildXlsx(buildTable(input()), () => 't', 'BRK/B'));
    const workbook = decode(files['xl/workbook.xml']!);
    expect(workbook).toContain('name="BRKB"');
  });

  it('writes a header row and data rows with inline strings and numbers', () => {
    const xml = decode(
      unzipSync(buildXlsx(buildTable(input()), () => '2024-01-14 05:00', 'AAPL'))[
        'xl/worksheets/sheet1.xml'
      ]!,
    );
    expect(xml).toContain('<row r="1"><c r="A1" t="inlineStr"><is><t xml:space="preserve">time</t></is></c>');
    expect(xml).toContain('<c r="F1" t="inlineStr"><is><t xml:space="preserve">volume</t></is></c>');
    // Time cell of the first bar.
    expect(xml).toContain('<c r="A2" t="inlineStr"><is><t xml:space="preserve">2024-01-14 05:00</t></is></c>');
    // Numeric cells of the first bar (open/high/low/close/volume).
    expect(xml).toContain('<c r="B2"><v>1</v></c>');
    expect(xml).toContain('<c r="E2"><v>1.5</v></c>');
    expect(xml).toContain('<c r="F2"><v>10</v></c>');
    // Header and cells escape XML text.
    expect(xml).toContain('A &lt;b&gt; &amp; &quot;b&quot;');
    // NaN cells are omitted (study column G has no value on row 2).
    expect(xml).not.toContain('<c r="G2"');
    expect(xml).toContain('<c r="G3"><v>7</v></c>');
  });
});

describe('xmlText', () => {
  it('escapes markup and strips XML 1.0-illegal control characters', () => {
    expect(xmlText('a<b>&"c')).toBe('a&lt;b&gt;&amp;&quot;c');
    expect(xmlText('a\u0000b\u0008c\u000bd\u000ce\u000ef\u001fg')).toBe('abcdefg');
    // Tab, LF and CR are legal.
    expect(xmlText('a\tb\nc\rd')).toBe('a\tb\nc\rd');
  });

  it('keeps a study title with control characters out of the sheet XML', () => {
    const table = buildTable({ ...input(), studies: [{ ...input().studies[0]!, title: 'bad\u0001\u0000' }] });
    const xml = decode(unzipSync(buildXlsx(table, () => 't', 'AAPL'))['xl/worksheets/sheet1.xml']!);
    expect(xml).toContain('>bad</t>');
    expect([...xml].filter((ch) => ch < ' ' && !'\t\n\r'.includes(ch))).toEqual([]);
  });
});

describe('sheetName', () => {
  it('removes the characters Excel forbids and keeps ordinary names', () => {
    expect(sheetName('AAPL')).toBe('AAPL');
    expect(sheetName('BRK/B')).toBe('BRKB');
    expect(sheetName('a[b]c:d*e?f\\g')).toBe('abcdefg');
  });

  it('limits the name to 31 characters', () => {
    expect(sheetName('x'.repeat(40))).toBe('x'.repeat(31));
  });

  it('never begins or ends with an apostrophe', () => {
    expect(sheetName("'AAPL'")).toBe('AAPL');
    expect(sheetName(`${'x'.repeat(30)}'y`)).toBe('x'.repeat(30));
    expect(sheetName("it's")).toBe("it's");
  });

  it('falls back to Data when empty or reserved', () => {
    expect(sheetName('')).toBe('Data');
    expect(sheetName('  ')).toBe('Data');
    expect(sheetName('/:*')).toBe('Data');
    expect(sheetName("''")).toBe('Data');
    expect(sheetName('History')).toBe('Data');
    expect(sheetName('hIsToRy')).toBe('Data');
    expect(sheetName('History2')).toBe('History2');
  });
});
