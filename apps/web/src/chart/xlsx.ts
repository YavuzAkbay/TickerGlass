/**
 * Minimal XLSX writer: one worksheet of inline strings and numbers, zipped
 * with fflate. Imported on demand by the export command — never part of the
 * initial bundle. Row i of the table becomes sheet row i + 2 (row 1 = header).
 */
import { strToU8, zipSync } from 'fflate';
import type { ExportTable, TimeFormatter } from './exportData';

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

function xmlText(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** 0-based column index → spreadsheet letters (0 = 'A', 26 = 'AA'). */
function colRef(index: number): string {
  let out = '';
  for (let x = index; x >= 0; x = Math.floor(x / 26) - 1)
    out = String.fromCharCode(65 + (x % 26)) + out;
  return out;
}

function stringCell(ref: string, text: string): string {
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlText(text)}</t></is></c>`;
}

function sheetXml(table: ExportTable, fmtTime: TimeFormatter): string {
  const rows: string[] = [];
  let header = '';
  table.columns.forEach((col, ci) => {
    header += stringCell(`${colRef(ci + 1)}1`, col.header);
  });
  rows.push(`<row r="1">${stringCell('A1', 'time')}${header}</row>`);
  for (let i = 0; i < table.n; i++) {
    let cells = stringCell(`A${i + 2}`, fmtTime(table.time[i]!));
    for (let ci = 0; ci < table.columns.length; ci++) {
      const col = table.columns[ci]!;
      const j = i - col.offset;
      const v = j >= 0 && j < col.length ? col.values[j]! : NaN;
      // Empty cell when there is no value (matches the CSV's empty field).
      if (Number.isFinite(v)) cells += `<c r="${colRef(ci + 1)}${i + 2}"><v>${String(v)}</v></c>`;
    }
    rows.push(`<row r="${i + 2}">${cells}</row>`);
  }
  return (
    `${XML_HEAD}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetData>${rows.join('')}</sheetData></worksheet>`
  );
}

const contentTypesXml =
  XML_HEAD +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
  '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
  '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
  '</Types>';

const rootRelsXml =
  XML_HEAD +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
  '</Relationships>';

const workbookRelsXml =
  XML_HEAD +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
  '</Relationships>';

const stylesXml =
  XML_HEAD +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>' +
  '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
  '<borders count="1"><border/></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  '</styleSheet>';

/** Excel sheet names: 1–31 chars, no []:*?/\ characters. */
function sheetName(symbol: string): string {
  const name = symbol.replace(/[\\/*?:[\]]/g, '').trim().slice(0, 31);
  return name || 'Data';
}

/** Build the .xlsx file bytes for `table` (sheet named after the symbol). */
export function buildXlsx(
  table: ExportTable,
  fmtTime: TimeFormatter,
  symbol: string,
): Uint8Array<ArrayBuffer> {
  const name = sheetName(symbol);
  // fflate allocates fresh ArrayBuffers, never SharedArrayBuffer.
  return zipSync({
    '[Content_Types].xml': strToU8(contentTypesXml),
    '_rels/.rels': strToU8(rootRelsXml),
    'xl/workbook.xml': strToU8(
      XML_HEAD +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        `<sheets><sheet name="${xmlText(name)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    ),
    'xl/_rels/workbook.xml.rels': strToU8(workbookRelsXml),
    'xl/styles.xml': strToU8(stylesXml),
    'xl/worksheets/sheet1.xml': strToU8(sheetXml(table, fmtTime)),
  }) as Uint8Array<ArrayBuffer>;
}
