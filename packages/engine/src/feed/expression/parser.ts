import { EXPR_LIMITS, ExpressionError, type BinOp, type ExprNode, type ParsedSymbol } from './ast';
import { formatExpression } from './format';
import { lex, type Token } from './lexer';

class Parser {
  private i = 0;
  private depth = 0;
  readonly symbols: string[] = [];

  constructor(
    private readonly tokens: Token[],
    private readonly inputLength: number,
  ) {}

  parse(): ExprNode {
    const ast = this.expr();
    const t = this.tokens[this.i];
    if (t !== undefined) {
      if (t.kind === 'rparen') throw new ExpressionError(`Unexpected ')'`, t.pos);
      throw new ExpressionError('Expected an operator', t.pos);
    }
    return ast;
  }

  private peekOp(a: BinOp, b: BinOp): BinOp | null {
    const t = this.tokens[this.i];
    return t !== undefined && t.kind === 'op' && (t.op === a || t.op === b) ? t.op : null;
  }

  private expr(): ExprNode {
    let left = this.term();
    for (let op = this.peekOp('+', '-'); op !== null; op = this.peekOp('+', '-')) {
      this.i++;
      left = { kind: 'bin', op, left, right: this.term() };
    }
    return left;
  }

  private term(): ExprNode {
    let left = this.unary();
    for (let op = this.peekOp('*', '/'); op !== null; op = this.peekOp('*', '/')) {
      this.i++;
      left = { kind: 'bin', op, left, right: this.unary() };
    }
    return left;
  }

  private enter(pos: number): void {
    if (++this.depth > EXPR_LIMITS.maxDepth) {
      throw new ExpressionError(`Too deeply nested (max ${EXPR_LIMITS.maxDepth})`, pos);
    }
  }

  private unary(): ExprNode {
    const t = this.tokens[this.i];
    if (t !== undefined && t.kind === 'op' && (t.op === '-' || t.op === '+')) {
      this.i++;
      this.enter(t.pos);
      const arg = this.unary();
      this.depth--;
      return t.op === '-' ? { kind: 'neg', arg } : arg;
    }
    return this.primary();
  }

  private primary(): ExprNode {
    const t = this.tokens[this.i];
    if (t === undefined) {
      throw new ExpressionError(`Expected a symbol, number or '('`, this.inputLength);
    }
    switch (t.kind) {
      case 'num':
        this.i++;
        return { kind: 'num', value: t.value, text: t.text };
      case 'sym':
        this.i++;
        if (!this.symbols.includes(t.symbol)) {
          if (this.symbols.length >= EXPR_LIMITS.maxLegs) {
            throw new ExpressionError(`Too many symbols (max ${EXPR_LIMITS.maxLegs})`, t.pos);
          }
          this.symbols.push(t.symbol);
        }
        return { kind: 'sym', symbol: t.symbol };
      case 'lparen': {
        this.i++;
        this.enter(t.pos);
        const inner = this.expr();
        const close = this.tokens[this.i];
        if (close === undefined) throw new ExpressionError(`Missing ')'`, t.pos);
        if (close.kind !== 'rparen') throw new ExpressionError('Expected an operator', close.pos);
        this.i++;
        this.depth--;
        return inner;
      }
      case 'rparen':
        throw new ExpressionError(`Unexpected ')'`, t.pos);
      case 'op':
        throw new ExpressionError(`Expected a symbol, number or '('`, t.pos);
    }
  }
}

const hasSymbol = (n: ExprNode): boolean => {
  switch (n.kind) {
    case 'num':
      return false;
    case 'sym':
      return true;
    case 'neg':
      return hasSymbol(n.arg);
    case 'bin':
      return hasSymbol(n.left) || hasSymbol(n.right);
  }
};

/** [linear, dividesBySymbol] of a subtree. */
function analyze(n: ExprNode): { linear: boolean; divides: boolean } {
  switch (n.kind) {
    case 'num':
    case 'sym':
      return { linear: true, divides: false };
    case 'neg':
      return analyze(n.arg);
    case 'bin': {
      const l = analyze(n.left);
      const r = analyze(n.right);
      let linear = l.linear && r.linear;
      let divides = l.divides || r.divides;
      if (n.op === '*' && hasSymbol(n.left) && hasSymbol(n.right)) linear = false;
      if (n.op === '/' && hasSymbol(n.right)) {
        linear = false;
        divides = true;
      }
      return { linear, divides };
    }
  }
}

/** Parse a plain symbol or a symbol expression. Throws ExpressionError. */
export function parseSymbolExpression(input: string): ParsedSymbol {
  if (input.trim().length === 0) throw new ExpressionError('Empty expression', 0);
  const tokens = lex(input);
  if (tokens.length === 0) throw new ExpressionError('Empty expression', 0);
  const parser = new Parser(tokens, input.length);
  const ast = parser.parse();
  const symbols = parser.symbols;
  const primary = symbols[0];
  if (primary === undefined) {
    throw new ExpressionError('Expression needs at least one symbol', 0);
  }
  const plain = ast.kind === 'sym';
  const { linear, divides } = analyze(ast);
  return {
    ast,
    // Plain symbols print bare when they re-lex as one run, else quoted.
    canonical: formatExpression(ast),
    symbols,
    plain,
    linear,
    dividesBySymbol: divides,
  };
}

export function tryParseSymbolExpression(
  input: string,
): { ok: true; value: ParsedSymbol } | { ok: false; error: ExpressionError } {
  try {
    return { ok: true, value: parseSymbolExpression(input) };
  } catch (err) {
    if (err instanceof ExpressionError) return { ok: false, error: err };
    throw err;
  }
}

/** Canonical form of a symbol or expression. Throws ExpressionError. */
export function canonicalSymbol(input: string): string {
  return parseSymbolExpression(input).canonical;
}

/** True only for a valid, non-plain expression. */
export function isExpressionSymbol(s: string): boolean {
  const r = tryParseSymbolExpression(s);
  return r.ok && !r.value.plain;
}
