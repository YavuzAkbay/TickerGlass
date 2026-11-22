/** Tiny RFC 4180 parser plus lenient number and date parsing for broker exports. */

export type Delimiter = ',' | ';' | '\t';

/** Parse CSV text into rows of cells. Handles quotes, escaped quotes, CRLF/CR and a UTF-8 BOM. */
export function parseCsv(text: string, delimiter: Delimiter = ','): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let fieldStart = true;
  let sawQuote = false;

  const endField = () => {
    row.push(field);
    field = '';
    fieldStart = true;
    sawQuote = false;
  };
  const endRow = () => {
    endField();
    // A blank line is a single empty cell; drop it.
    if (!(row.length === 1 && row[0] === '' && !sawQuote)) rows.push(row);
    row = [];
  };

  for (let i = 0; i < src.length; i++) {
    const ch = src[i] as string;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && fieldStart) {
      inQuotes = true;
      sawQuote = true;
      fieldStart = false;
    } else if (ch === delimiter) {
      endField();
    } else if (ch === '\n') {
      endRow();
    } else if (ch === '\r') {
      if (src[i + 1] === '\n') i++;
      endRow();
    } else {
      field += ch;
      fieldStart = false;
    }
  }
  if (field !== '' || row.length > 0 || sawQuote) endRow();
  return rows;
}

/** Guess the delimiter from the first lines (counts outside quotes). Defaults to a comma. */
export function detectDelimiter(text: string): Delimiter {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = src
    .split(/\r\n|\n|\r/)
    .filter((l) => l.trim() !== '')
    .slice(0, 12);
  const candidates: Delimiter[] = [',', ';', '\t'];
  let best: Delimiter = ',';
  let bestScore = 0;
  for (const d of candidates) {
    const counts = lines.map((line) => {
      let n = 0;
      let q = false;
      for (const ch of line) {
        if (ch === '"') q = !q;
        else if (!q && ch === d) n++;
      }
      return n;
    });
    const freq = new Map<number, number>();
    for (const c of counts) if (c > 0) freq.set(c, (freq.get(c) ?? 0) + 1);
    let score = 0;
    for (const [c, f] of freq) score = Math.max(score, c * f);
    if (score > bestScore) {
      best = d;
      bestScore = score;
    }
  }
  return best;
}

const SCI = /^[+-]?\d+(\.\d+)?[eE][+-]?\d+$/;

/**
 * Parse a number as printed by brokers: "1,234.56", "1.234,56", "$1,234.56", "(12.5)", "-3", "7-".
 * With both separators the last one is the decimal mark. A single separator is resolved by `decimal`
 * (default: "," followed by exactly 3 digits is a thousands mark, anything else is a decimal point).
 */
export function parseNumber(raw: string | undefined | null, decimal?: '.' | ','): number | null {
  if (raw === undefined || raw === null) return null;
  let s = raw.trim();
  if (s === '' || s === '-') return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/[\s\u00a0']/g, '');
  if (SCI.test(s)) {
    const n = Number(s);
    return Number.isFinite(n) ? (negative ? -n : n) : null;
  }
  if (s.endsWith('-')) {
    negative = !negative;
    s = s.slice(0, -1);
  }
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.startsWith('+')) {
    s = s.slice(1);
  }
  s = s.replace(/[^0-9.,]/g, '');
  if (s === '' || !/\d/.test(s)) return null;

  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  let dec: '.' | ',' | null = null;
  if (lastDot >= 0 && lastComma >= 0) {
    dec = lastDot > lastComma ? '.' : ',';
  } else if (lastDot >= 0 || lastComma >= 0) {
    const sep = lastDot >= 0 ? '.' : ',';
    const count = s.split(sep).length - 1;
    if (count > 1) dec = null;
    else if (decimal) dec = sep === decimal ? sep : null;
    else if (sep === ',') dec = /,\d{3}$/.test(s) ? null : ',';
    else dec = '.';
  }
  const normalized =
    dec === '.'
      ? s.replace(/,/g, '')
      : dec === ','
        ? s.replace(/\./g, '').replace(',', '.')
        : s.replace(/[.,]/g, '');
  const n = Number(normalized);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

export interface DecimalAnalysis {
  decimal: '.' | ',';
  /** Samples that can only be read with "." / "," as the decimal mark. */
  dots: number;
  commas: number;
  /** Samples like "1,500" / "1.500" that read either as thousands or as a decimal. */
  ambiguous: number;
  /** True when the choice rests on no evidence, conflicting evidence or a minority of the samples. */
  uncertain: boolean;
}

/** Vote for the decimal mark used by a column of printed numbers, and say how sure the vote is. */
export function analyzeDecimal(samples: string[]): DecimalAnalysis {
  let dots = 0;
  let commas = 0;
  let ambiguous = 0;
  for (const raw of samples) {
    const s = raw.replace(/[^0-9.,]/g, '');
    const lastDot = s.lastIndexOf('.');
    const lastComma = s.lastIndexOf(',');
    if (lastDot >= 0 && lastComma >= 0) {
      if (lastDot > lastComma) dots++;
      else commas++;
    } else if (lastComma >= 0) {
      const multi = s.split(',').length > 2;
      if (multi) continue;
      if (!/,\d{3}$/.test(s)) commas++;
      else ambiguous++;
    } else if (lastDot >= 0) {
      const multi = s.split('.').length > 2;
      if (multi) continue;
      if (!/\.\d{3}$/.test(s)) dots++;
      else ambiguous++;
    }
  }
  const decimal = commas > dots ? ',' : '.';
  const winner = Math.max(dots, commas);
  const uncertain =
    (dots > 0 && commas > 0) || (ambiguous > 0 && (winner === 0 || winner <= ambiguous));
  return { decimal, dots, commas, ambiguous, uncertain };
}

/** Vote for the decimal mark used by a column of printed numbers. Defaults to ".". */
export function inferDecimalSeparator(samples: string[]): '.' | ',' {
  return analyzeDecimal(samples).decimal;
}

export interface DateOptions {
  /** Order of day/month in numeric dates such as 01/02/2024. Default 'mdy'. */
  order?: 'mdy' | 'dmy';
  /** Time of day (HH:MM[:SS]) used when `raw` carries none. */
  time?: string;
}

function toIso(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  s: number,
  offsetMin: number,
): string | null {
  const ms = Date.UTC(y, mo - 1, d, h, mi, s);
  const dt = new Date(ms);
  if (
    Number.isNaN(ms) ||
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== mo - 1 ||
    dt.getUTCDate() !== d ||
    h > 23 ||
    mi > 59 ||
    s > 59
  ) {
    return null;
  }
  return new Date(ms - offsetMin * 60_000).toISOString();
}

const TIME_PART = String.raw`(?:[T ,;]+(\d{1,2}):?(\d{2})(?::?(\d{2}))?(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?`;
const RE_ISO = new RegExp(String.raw`^(\d{4})-(\d{1,2})-(\d{1,2})` + TIME_PART + '$');
const RE_YMD_SLASH = new RegExp(String.raw`^(\d{4})[/.](\d{1,2})[/.](\d{1,2})` + TIME_PART + '$');
const RE_COMPACT = new RegExp(String.raw`^(\d{4})(\d{2})(\d{2})` + TIME_PART + '$');
const RE_NUMERIC = new RegExp(
  String.raw`^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2}|\d{4})` + TIME_PART + '$',
);

function offsetOf(z: string | undefined): number {
  if (!z || z === 'Z') return 0;
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(z);
  if (!m) return 0;
  const mins = Number(m[2]) * 60 + Number(m[3]);
  return m[1] === '-' ? -mins : mins;
}

/**
 * Parse a broker date or date-time into an ISO-8601 UTC string. Values without a zone are read as
 * UTC; date-only values become 12:00:00Z so they stay on the same calendar day in most zones.
 */
export function parseDate(raw: string | undefined | null, opts: DateOptions = {}): string | null {
  if (!raw) return null;
  const s = raw.trim().replace(/^"|"$/g, '');
  if (s === '') return null;
  let ymd: [number, number, number] | null = null;
  let tm: RegExpExecArray | null = null;

  let m: RegExpExecArray | null;
  if ((m = RE_ISO.exec(s)) || (m = RE_YMD_SLASH.exec(s)) || (m = RE_COMPACT.exec(s))) {
    ymd = [Number(m[1]), Number(m[2]), Number(m[3])];
    tm = m;
  } else if ((m = RE_NUMERIC.exec(s))) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    let y = Number(m[3]);
    if (m[3]?.length === 2) y += 2000;
    let day: number;
    let month: number;
    if (a > 12) {
      day = a;
      month = b;
    } else if (b > 12) {
      month = a;
      day = b;
    } else if ((opts.order ?? 'mdy') === 'dmy') {
      day = a;
      month = b;
    } else {
      month = a;
      day = b;
    }
    ymd = [y, month, day];
    tm = m;
  }
  if (!ymd || !tm) return null;

  let h = 12;
  let mi = 0;
  let sec = 0;
  let off = 0;
  if (tm[4] !== undefined) {
    h = Number(tm[4]);
    mi = Number(tm[5]);
    sec = tm[6] !== undefined ? Number(tm[6]) : 0;
    off = offsetOf(tm[7]);
  } else if (opts.time) {
    const t = /^(\d{1,2}):?(\d{2})(?::?(\d{2}))?/.exec(opts.time.trim());
    if (t) {
      h = Number(t[1]);
      mi = Number(t[2]);
      sec = t[3] !== undefined ? Number(t[3]) : 0;
    }
  }
  return toIso(ymd[0], ymd[1], ymd[2], h, mi, sec, off);
}
