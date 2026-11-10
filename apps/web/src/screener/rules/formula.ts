/**
 * Client-side mirror of the server's formula grammar
 * (`api/src/tickerglass_api/services/screener/formula.py`, design doc section 10): a
 * tokenizer and recursive-descent parser that report the same error code at the same
 * character offset, so the rule builder can flag a bad formula before it is sent. Both
 * implementations run the shared vectors in `api/tests/data/formula_vectors.json`; change
 * them together.
 *
 *   formula = expr
 *   expr    = term { ("+" | "-") term }
 *   term    = unary { ("*" | "/") unary }
 *   unary   = "-" unary | primary
 *   primary = number | field | call | "(" expr ")"
 *   call    = ("abs" | "min" | "max") "(" expr { "," expr } ")" | "prev" "(" field ")"
 *
 * No `eval`: the parser only builds a small AST that is never executed here.
 */
import type { FieldType } from '../server/types';

export const FORMULA_MAX_LENGTH = 200;
export const FORMULA_MAX_NODES = 64;
export const FORMULA_MAX_DEPTH = 16;
export const FORMULA_MAX_NUMBER_CHARS = 24;
export const FORMULA_MAX_ARGS = 8;
export const FORMULA_MAX_MINMAX_NESTING = 2;
/** Formula rules per filter (they also count toward the 50-rule budget). */
export const MAX_FORMULA_RULES = 10;
/** `"=<formula>"` entries of a scan's `fields`. */
export const MAX_FORMULA_FIELDS = 3;
/** Prefix of a requested field that is a formula column. */
export const FORMULA_FIELD_PREFIX = '=';

export const FORMULA_OPS = ['>', '<', '>=', '<=', 'between'] as const;
export type FormulaOp = (typeof FORMULA_OPS)[number];

/** Field types a formula may reference. */
export const FORMULA_TYPES: readonly FieldType[] = ['number', 'percent', 'money', 'int'];

/** Function name -> [min args, max args]. */
export const FORMULA_FUNCTIONS: Readonly<Record<string, readonly [number, number]>> = {
  abs: [1, 1],
  min: [2, FORMULA_MAX_ARGS],
  max: [2, FORMULA_MAX_ARGS],
  prev: [1, 1],
};

export type FormulaErrorCode =
  'bad_formula' | 'unknown_field' | 'field_unavailable' | 'too_complex';

/** Why a formula is rejected; picks the message (`scr.fx.e.<reason>`). */
export type FormulaReason =
  | 'empty'
  | 'char'
  | 'numberLong'
  | 'unexpected'
  | 'end'
  | 'close'
  | 'unknownFn'
  | 'prevArg'
  | 'maxArgs'
  | 'minArgs'
  | 'unknownField'
  | 'notNumeric'
  | 'notCrossable'
  | 'unavailable'
  | 'length'
  | 'depth'
  | 'nodes'
  | 'minmax';

export interface FormulaError {
  code: FormulaErrorCode;
  reason: FormulaReason;
  /** 0-based character offset (the formula's length for an unexpected end). */
  offset: number;
  /** Token, field or function the error is about, when there is one. */
  name?: string;
}

/** What the parser needs to know about a field (a `FieldDef` satisfies it). */
export interface FormulaField {
  id: string;
  type: FieldType;
  crossable: boolean;
  available: boolean;
}

export type FormulaNode =
  | { kind: 'num'; text: string; value: number; offset: number }
  | { kind: 'ref'; field: string; prev: boolean; offset: number }
  | { kind: 'neg'; operand: FormulaNode; offset: number }
  | {
      kind: 'bin';
      op: '+' | '-' | '*' | '/';
      left: FormulaNode;
      right: FormulaNode;
      offset: number;
    }
  | { kind: 'call'; name: 'abs' | 'min' | 'max'; args: FormulaNode[]; offset: number };

export type ParseResult = { ok: true; node: FormulaNode } | { ok: false; error: FormulaError };

class Fail extends Error {
  constructor(readonly error: FormulaError) {
    super(error.reason);
  }
}

const fail = (
  code: FormulaErrorCode,
  reason: FormulaReason,
  offset: number,
  name?: string,
): never => {
  throw new Fail({ code, reason, offset, ...(name !== undefined ? { name } : {}) });
};

// ------------------------------------------------------------ tokenizer

interface Tok {
  kind: 'num' | 'ident' | 'punct' | 'end';
  text: string;
  offset: number;
}

const isDigit = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '9';
const isIdentStart = (c: string | undefined): boolean =>
  c !== undefined && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_');
const isIdentChar = (c: string | undefined): boolean => isIdentStart(c) || isDigit(c);
const SPACE = ' \t\r\n';
const PUNCT = '+-*/(),';

function tokenize(text: string): Tok[] {
  const out: Tok[] = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i]!;
    if (SPACE.includes(c)) {
      i++;
    } else if (isDigit(c) || (c === '.' && isDigit(text[i + 1]))) {
      const start = i;
      while (i < n && isDigit(text[i])) i++;
      if (i + 1 < n && text[i] === '.' && isDigit(text[i + 1])) {
        i++;
        while (i < n && isDigit(text[i])) i++;
      }
      if (i - start > FORMULA_MAX_NUMBER_CHARS) fail('bad_formula', 'numberLong', start);
      out.push({ kind: 'num', text: text.slice(start, i), offset: start });
    } else if (isIdentStart(c)) {
      const start = i;
      while (i < n && isIdentChar(text[i])) i++;
      out.push({ kind: 'ident', text: text.slice(start, i), offset: start });
    } else if (PUNCT.includes(c)) {
      out.push({ kind: 'punct', text: c, offset: i });
      i++;
    } else {
      fail('bad_formula', 'char', i, c);
    }
  }
  out.push({ kind: 'end', text: '', offset: n });
  return out;
}

// ------------------------------------------------------------ parser

type Built = [FormulaNode, number];

class Parser {
  private readonly toks: Tok[];
  private pos = 0;
  private nodes = 0;
  private nesting = 0;
  private minmax = 0;

  constructor(
    text: string,
    private readonly fields: FieldLookup,
  ) {
    this.toks = tokenize(text);
  }

  private peek(): Tok {
    return this.toks[this.pos]!;
  }

  private next(): Tok {
    const tok = this.toks[this.pos]!;
    if (tok.kind !== 'end') this.pos++;
    return tok;
  }

  private at(...punct: string[]): boolean {
    const tok = this.peek();
    return tok.kind === 'punct' && punct.includes(tok.text);
  }

  private expectClose(): void {
    const tok = this.next();
    if (!(tok.kind === 'punct' && tok.text === ')')) fail('bad_formula', 'close', tok.offset);
  }

  private enter(offset: number): void {
    this.nesting++;
    if (this.nesting > FORMULA_MAX_DEPTH) fail('too_complex', 'depth', offset);
  }

  private make(node: FormulaNode, depth: number): Built {
    this.nodes++;
    if (this.nodes > FORMULA_MAX_NODES) fail('too_complex', 'nodes', node.offset);
    if (depth > FORMULA_MAX_DEPTH) fail('too_complex', 'depth', node.offset);
    return [node, depth];
  }

  formula(): FormulaNode {
    if (this.peek().kind === 'end') fail('bad_formula', 'empty', this.peek().offset);
    const [node] = this.expr();
    const tok = this.peek();
    if (tok.kind !== 'end') fail('bad_formula', 'unexpected', tok.offset, tok.text);
    return node;
  }

  private expr(): Built {
    let [left, ld] = this.term();
    while (this.at('+', '-')) {
      const op = this.next();
      const [right, rd] = this.term();
      [left, ld] = this.make(
        { kind: 'bin', op: op.text as '+' | '-', left, right, offset: op.offset },
        1 + Math.max(ld, rd),
      );
    }
    return [left, ld];
  }

  private term(): Built {
    let [left, ld] = this.unary();
    while (this.at('*', '/')) {
      const op = this.next();
      const [right, rd] = this.unary();
      [left, ld] = this.make(
        { kind: 'bin', op: op.text as '*' | '/', left, right, offset: op.offset },
        1 + Math.max(ld, rd),
      );
    }
    return [left, ld];
  }

  private unary(): Built {
    if (this.at('-')) {
      const tok = this.next();
      this.enter(tok.offset);
      const [operand, d] = this.unary();
      this.nesting--;
      return this.make({ kind: 'neg', operand, offset: tok.offset }, 1 + d);
    }
    return this.primary();
  }

  private primary(): Built {
    const tok = this.next();
    if (tok.kind === 'num')
      return this.make(
        { kind: 'num', text: tok.text, value: Number(tok.text), offset: tok.offset },
        1,
      );
    if (tok.kind === 'ident') {
      if (this.at('(')) return this.call(tok);
      return this.make(this.ref(tok, false), 1);
    }
    if (tok.kind === 'punct' && tok.text === '(') {
      this.enter(tok.offset);
      const inner = this.expr();
      this.expectClose();
      this.nesting--;
      return inner;
    }
    if (tok.kind === 'end') return fail('bad_formula', 'end', tok.offset);
    return fail('bad_formula', 'unexpected', tok.offset, tok.text);
  }

  private call(name: Tok): Built {
    const bounds = Object.hasOwn(FORMULA_FUNCTIONS, name.text)
      ? FORMULA_FUNCTIONS[name.text]
      : undefined;
    if (!bounds) return fail('bad_formula', 'unknownFn', name.offset, name.text);
    this.next(); // "("
    this.enter(name.offset);
    if (name.text === 'prev') {
      const arg = this.next();
      if (arg.kind !== 'ident' || !this.at(')')) fail('bad_formula', 'prevArg', arg.offset);
      const ref = this.ref(arg, true);
      this.expectClose();
      this.nesting--;
      return this.make(ref, 1);
    }
    const minmax = name.text === 'min' || name.text === 'max';
    if (minmax) {
      this.minmax++;
      if (this.minmax > FORMULA_MAX_MINMAX_NESTING) fail('too_complex', 'minmax', name.offset);
    }
    const [lo, hi] = bounds;
    const [first, d0] = this.expr();
    const args = [first];
    let depth = d0;
    while (this.at(',')) {
      const comma = this.next();
      if (args.length >= hi) fail('bad_formula', 'maxArgs', comma.offset, name.text);
      const [arg, d] = this.expr();
      args.push(arg);
      depth = Math.max(depth, d);
    }
    this.expectClose();
    if (args.length < lo) fail('bad_formula', 'minArgs', name.offset, name.text);
    if (minmax) this.minmax--;
    this.nesting--;
    return this.make(
      { kind: 'call', name: name.text as 'abs' | 'min' | 'max', args, offset: name.offset },
      1 + depth,
    );
  }

  private ref(tok: Tok, prev: boolean): FormulaNode {
    const def = this.fields.get(tok.text);
    if (!def) return fail('unknown_field', 'unknownField', tok.offset, tok.text);
    if (!FORMULA_TYPES.includes(def.type)) fail('bad_formula', 'notNumeric', tok.offset, tok.text);
    if (prev && !def.crossable) fail('bad_formula', 'notCrossable', tok.offset, tok.text);
    if (!def.available) fail('field_unavailable', 'unavailable', tok.offset, tok.text);
    return { kind: 'ref', field: tok.text, prev, offset: tok.offset };
  }
}

/** Character count in code points (what the server's `len()` counts; the formula length limit). */
export const codePoints = (text: string): number => {
  let n = 0;
  for (const _ of text) n++;
  return n;
};

/** How the parser resolves identifiers. */
interface FieldLookup {
  get(id: string): FormulaField | undefined;
}

/** Accepts every identifier as an available, crossable number: syntax-only checking. */
const ANY_FIELD: FieldLookup = {
  get: (id) => ({ id, type: 'number', crossable: true, available: true }),
};

/** Parse a formula against the field catalog; never throws. */
export function parseFormula(
  text: string,
  fields: readonly FormulaField[] | ReadonlyMap<string, FormulaField>,
): ParseResult {
  const index: FieldLookup =
    fields instanceof Map
      ? fields
      : new Map((fields as readonly FormulaField[]).map((f) => [f.id, f]));
  return run(text, index);
}

/**
 * Whether a formula is well-formed (grammar and limits) without a field catalog, e.g. for
 * stored column ids before `/screener/fields` has loaded. The server still checks the fields.
 */
export function formulaSyntaxOk(text: string): boolean {
  return run(text, ANY_FIELD).ok;
}

function run(text: string, index: FieldLookup): ParseResult {
  try {
    if (codePoints(text) > FORMULA_MAX_LENGTH) fail('too_complex', 'length', FORMULA_MAX_LENGTH);
    return { ok: true, node: new Parser(text, index).formula() };
  } catch (e) {
    if (e instanceof Fail) return { ok: false, error: e.error };
    throw e;
  }
}

/** Canonical prefix form, e.g. `(- (/ last sma200) 1)` (shared test vectors). */
export function sexpr(node: FormulaNode): string {
  switch (node.kind) {
    case 'num':
      return node.text;
    case 'ref':
      return node.prev ? `(prev ${node.field})` : node.field;
    case 'neg':
      return `(neg ${sexpr(node.operand)})`;
    case 'bin':
      return `(${node.op} ${sexpr(node.left)} ${sexpr(node.right)})`;
    case 'call':
      return `(${node.name} ${node.args.map(sexpr).join(' ')})`;
  }
}

// ------------------------------------------------------------ autocomplete

export interface FormulaSuggestion {
  /** Text inserted in place of the word being typed. */
  insert: string;
  kind: 'field' | 'function';
  id: string;
}

/** The identifier being typed at `caret`: `[start, end)` of `text` (empty when none). */
export function wordAt(text: string, caret: number): { start: number; end: number; word: string } {
  let start = caret;
  while (start > 0 && isIdentChar(text[start - 1])) start--;
  let end = caret;
  while (end < text.length && isIdentChar(text[end])) end++;
  const word = text.slice(start, caret);
  return isIdentStart(word[0]) ? { start, end, word } : { start: caret, end: caret, word: '' };
}

/**
 * Field ids and functions starting with the word at the caret (case-insensitive, prefix
 * matches first, then substring matches), at most `limit`. Only fields a formula may use
 * are offered; after `prev(` only crossable ones.
 */
export function suggest(
  text: string,
  caret: number,
  fields: readonly FormulaField[],
  limit = 8,
): FormulaSuggestion[] {
  const { start, word } = wordAt(text, caret);
  if (!word) return [];
  const before = text.slice(0, start).replace(/\s+$/, '');
  const inPrev = /(^|[^A-Za-z0-9_])prev\s*\($/.test(before);
  const q = word.toLowerCase();
  const usable = fields.filter(
    (f) => f.available && FORMULA_TYPES.includes(f.type) && (!inPrev || f.crossable),
  );
  const items: FormulaSuggestion[] = [
    ...(inPrev
      ? []
      : Object.keys(FORMULA_FUNCTIONS).map((id): FormulaSuggestion => ({
          insert: `${id}(`,
          kind: 'function',
          id,
        }))),
    ...usable.map((f): FormulaSuggestion => ({ insert: f.id, kind: 'field', id: f.id })),
  ];
  const prefix = items.filter((s) => s.id.toLowerCase().startsWith(q));
  const inner = items.filter(
    (s) => !s.id.toLowerCase().startsWith(q) && s.id.toLowerCase().includes(q),
  );
  return [...prefix, ...inner].filter((s) => s.id !== word).slice(0, limit);
}

/** Replace the word at the caret with a suggestion; returns the new text and caret. */
export function applySuggestion(
  text: string,
  caret: number,
  s: FormulaSuggestion,
): { text: string; caret: number } {
  const { start, end } = wordAt(text, caret);
  const next = text.slice(0, start) + s.insert + text.slice(end);
  return { text: next, caret: start + s.insert.length };
}
