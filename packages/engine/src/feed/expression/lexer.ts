import { EXPR_LIMITS, ExpressionError } from './ast';

export type Token =
  | { kind: 'num'; pos: number; value: number; text: string }
  | { kind: 'sym'; pos: number; symbol: string }
  | { kind: 'op'; pos: number; op: '+' | '-' | '*' | '/' }
  | { kind: 'lparen'; pos: number }
  | { kind: 'rparen'; pos: number };

const NUMBER_RE = /^([0-9]+)(?:\.([0-9]+))?$/;
const MAX_SIGNIFICANT_DIGITS = 15;
/** Charset allowed inside quotes (a leading '.' is rejected separately). */
const QUOTED_RE = /^[A-Z0-9^_.=&/ -]+$/;

const isUpper = (c: string): boolean => c >= 'A' && c <= 'Z';
const isDigit = (c: string): boolean => c >= '0' && c <= '9';
const isRunStart = (c: string): boolean => isUpper(c) || isDigit(c) || c === '^' || c === '_';
const isRunContinue = (c: string): boolean =>
  isUpper(c) || isDigit(c) || c === '_' || c === '.' || c === '=' || c === '&';

/** ASCII-only upper-casing, so positions never shift. */
function upperAscii(c: string): string {
  return c >= 'a' && c <= 'z' ? String.fromCharCode(c.charCodeAt(0) - 32) : c;
}

/**
 * Tokenize a symbol expression. Letters are upper-cased (inside quotes too).
 * Throws ExpressionError.
 */
export function lex(input: string): Token[] {
  if (input.length > EXPR_LIMITS.maxInput) {
    throw new ExpressionError(
      `Expression too long (max ${EXPR_LIMITS.maxInput} characters)`,
      EXPR_LIMITS.maxInput,
    );
  }
  const tokens: Token[] = [];
  const n = input.length;
  let i = 0;
  while (i < n) {
    const c = upperAscii(input.charAt(i));
    if (c === ' ' || c === '\t') {
      i++;
      continue;
    }
    switch (c) {
      case '+':
      case '-':
      case '*':
      case '/':
        tokens.push({ kind: 'op', pos: i, op: c });
        i++;
        continue;
      case '(':
        tokens.push({ kind: 'lparen', pos: i });
        i++;
        continue;
      case ')':
        tokens.push({ kind: 'rparen', pos: i });
        i++;
        continue;
      case '"':
        i = lexQuoted(input, i, tokens);
        continue;
      default:
        break;
    }
    if (!isRunStart(c)) throw new ExpressionError(`Unexpected character '${c}'`, i);
    i = lexRun(input, i, tokens);
  }
  return tokens;
}

function lexQuoted(input: string, start: number, out: Token[]): number {
  const end = input.indexOf('"', start + 1);
  if (end < 0) throw new ExpressionError(`Unexpected character '"'`, start);
  let symbol = '';
  for (let k = start + 1; k < end; k++) {
    const ch = input.charAt(k);
    if (isControl(ch)) throw new ExpressionError(`Unexpected character '${ch}'`, k);
    symbol += upperAscii(ch);
  }
  if (symbol.length === 0) throw new ExpressionError(`Unexpected character '"'`, start);
  // Quoted symbols become URL path segments: no '..', no leading '.', and only
  // the unquoted-run charset plus '/' (and the space the parser tests rely on).
  if (!QUOTED_RE.test(symbol) || symbol.startsWith('.')) {
    throw new ExpressionError(`Invalid number or symbol '${symbol}'`, start);
  }
  if (symbol.length > EXPR_LIMITS.maxSymbolLength) {
    throw new ExpressionError(`Symbol too long (max ${EXPR_LIMITS.maxSymbolLength})`, start);
  }
  out.push({ kind: 'sym', pos: start, symbol });
  return end + 1;
}

function isControl(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return code < 0x20 || code === 0x7f;
}

function lexRun(input: string, start: number, out: Token[]): number {
  const n = input.length;
  let run = upperAscii(input.charAt(start));
  let hasLetter = isUpper(run);
  let i = start + 1;
  while (i < n) {
    const c = upperAscii(input.charAt(i));
    if (isRunContinue(c)) {
      if (isUpper(c)) hasLetter = true;
      run += c;
      i++;
      continue;
    }
    if (c === '-' && hasLetter && i + 1 < n) {
      const next = upperAscii(input.charAt(i + 1));
      if (isUpper(next) || isDigit(next)) {
        run += c;
        i++;
        continue;
      }
    }
    break;
  }

  const m = NUMBER_RE.exec(run);
  if (m) {
    const intPart = m[1] ?? '';
    const fracPart = m[2] ?? '';
    const digits = (intPart + fracPart).replace(/^0+/, '');
    const fracTrimmed = fracPart.replace(/0+$/, '');
    // Trailing zeros of the fraction are not significant; integer zeros are.
    const significant = digits.length - (fracPart.length - fracTrimmed.length);
    if (significant > MAX_SIGNIFICANT_DIGITS) {
      throw new ExpressionError(`Invalid number or symbol '${run}'`, start);
    }
    const intNorm = intPart.replace(/^0+(?=.)/, '');
    const text = fracTrimmed.length > 0 ? `${intNorm}.${fracTrimmed}` : intNorm;
    out.push({ kind: 'num', pos: start, value: Number(text), text });
    return i;
  }
  if (!hasLetter && !run.startsWith('^')) {
    throw new ExpressionError(`Invalid number or symbol '${run}'`, start);
  }
  if (run.length > EXPR_LIMITS.maxSymbolLength) {
    throw new ExpressionError(`Symbol too long (max ${EXPR_LIMITS.maxSymbolLength})`, start);
  }
  out.push({ kind: 'sym', pos: start, symbol: run });
  return i;
}

/** True if `symbol` lexes back to exactly one bare symbol token with the same text. */
export function isBareSymbol(symbol: string): boolean {
  if (symbol.length === 0 || !isRunStart(symbol.charAt(0))) return false;
  try {
    const out: Token[] = [];
    const end = lexRun(symbol, 0, out);
    const t = out[0];
    return end === symbol.length && t !== undefined && t.kind === 'sym' && t.symbol === symbol;
  } catch (err) {
    if (err instanceof ExpressionError) return false;
    throw err;
  }
}
