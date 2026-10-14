import { describe, expect, it } from 'vitest';
import { EXPR_LIMITS, ExpressionError, type BinOp, type ExprNode } from './ast';
import { formatExpression } from './format';
import {
  canonicalSymbol,
  isExpressionSymbol,
  parseSymbolExpression,
  tryParseSymbolExpression,
} from './parser';

function errorOf(input: string): ExpressionError {
  const r = tryParseSymbolExpression(input);
  if (r.ok) throw new Error(`expected ${JSON.stringify(input)} to fail`);
  return r.error;
}

describe('canonicalSymbol', () => {
  it.each([
    ['aapl/msft', 'AAPL/MSFT'],
    ['(A+B)/2', '(A+B)/2'],
    // Spec golden `(A-B)-C` / `A-(B-C)`: unspaced `A-B` is one symbol under the
    // hyphen rule, so the subtraction goldens are written with spaces.
    ['(A - B) - C', 'A - B - C'],
    ['A - (B - C)', 'A - (B - C)'],
    ['(A-B)-C', 'A-B - C'],
    ['A-(B-C)', 'A - B-C'],
    ['(A*B)/C', 'A*B/C'],
    ['A/(B*C)', 'A/(B*C)'],
    ['A+(B+C)', 'A+(B+C)'],
    ['2*-AAPL', '2*-AAPL'],
    ['--A', '--A'],
    ['+A', 'A'],
    ['-(A+B)', '-(A+B)'],
    ['"brk/b"*2', '"BRK/B"*2'],
    ['"BRK-B"*2', 'BRK-B*2'],
    ['"0700"*A', '"0700"*A'],
    ['007.50*A', '7.5*A'],
    ['0.0*A', '0*A'],
    [' ( aapl + msft ) / 2 ', '(AAPL+MSFT)/2'],
  ])('%s -> %s', (input, expected) => {
    expect(canonicalSymbol(input)).toBe(expected);
  });

  it('is idempotent', () => {
    for (const s of ['(A - B) - C', 'A-(B-C)', 'A/(B*C)', '2*-AAPL', '"brk/b"*2', '007.50*A']) {
      const c = canonicalSymbol(s);
      expect(canonicalSymbol(c)).toBe(c);
    }
  });
});

describe('plain quoted symbols', () => {
  it('stay quoted when they would not re-lex as one symbol', () => {
    const p = parseSymbolExpression('"brk/b"');
    expect(p.canonical).toBe('"BRK/B"');
    expect(p.plain).toBe(true);
    expect(p.symbols[0]).toBe('BRK/B');
    expect(isExpressionSymbol('"BRK/B"')).toBe(false);
    expect(canonicalSymbol('"0700"')).toBe('"0700"');
    expect(canonicalSymbol('"AAPL"')).toBe('AAPL');
    expect(canonicalSymbol('AAPL')).toBe('AAPL');
  });

  it.each(['"brk/b"', '"0700"', '"A B"', '"aapl"', 'brk-b', '^gspc', 'a/b', '(a - b)*2', '"x-"/A'])(
    'canonical is a fixed point and preserves plainness: %s',
    (input) => {
      const p = parseSymbolExpression(input);
      const again = parseSymbolExpression(p.canonical);
      expect(again.canonical).toBe(p.canonical);
      expect(canonicalSymbol(canonicalSymbol(input))).toBe(canonicalSymbol(input));
      expect(again.plain).toBe(p.plain);
      expect(again.symbols).toEqual(p.symbols);
      expect(again.ast).toEqual(p.ast);
    },
  );
});

describe('lexing', () => {
  it.each([
    'AAPL-MSFT',
    'BRK-B',
    'BTC-USD',
    '^GSPC',
    'EURUSD=X',
    'GC=F',
    '7203.T',
    '0700.HK',
    'M&M.NS',
  ])('%s is a plain symbol', (s) => {
    const p = parseSymbolExpression(s);
    expect(p.plain).toBe(true);
    expect(p.symbols).toEqual([s]);
    expect(p.canonical).toBe(s);
    expect(isExpressionSymbol(s)).toBe(false);
  });

  it('plain symbols are upper-cased', () => {
    expect(canonicalSymbol(' brk-b ')).toBe('BRK-B');
  });

  it.each([
    ['10-AAPL', '10 - AAPL'],
    ['AAPL - MSFT', 'AAPL - MSFT'],
    ['AAPL- MSFT', 'AAPL - MSFT'],
    ['AAPL -MSFT', 'AAPL - MSFT'],
  ])('%s is an expression', (input, canonical) => {
    const p = parseSymbolExpression(input);
    expect(p.plain).toBe(false);
    expect(p.canonical).toBe(canonical);
    expect(isExpressionSymbol(input)).toBe(true);
  });

  it('normalizes numbers', () => {
    const p = parseSymbolExpression('007.50*A');
    expect(p.ast).toEqual({
      kind: 'bin',
      op: '*',
      left: { kind: 'num', value: 7.5, text: '7.5' },
      right: { kind: 'sym', symbol: 'A' },
    });
  });

  it('accepts 15 significant digits, rejects 16', () => {
    expect(canonicalSymbol('123456789012345*A')).toBe('123456789012345*A');
    expect(canonicalSymbol('0.000123456789012345*A')).toBe('0.000123456789012345*A');
    expect(errorOf('1234567890123456*A').message).toBe(
      "Invalid number or symbol '1234567890123456'",
    );
  });
});

describe('parse structure', () => {
  it('unary binds tighter than * /', () => {
    expect(parseSymbolExpression('-A*B').ast).toEqual({
      kind: 'bin',
      op: '*',
      left: { kind: 'neg', arg: { kind: 'sym', symbol: 'A' } },
      right: { kind: 'sym', symbol: 'B' },
    });
  });

  it('collects distinct symbols in first-appearance order', () => {
    expect(parseSymbolExpression('B*A+B/C').symbols).toEqual(['B', 'A', 'C']);
  });

  it.each([
    ['A+B', true, false],
    ['2*A - 3*B', true, false],
    ['(A+B)/2', true, false],
    ['A*B', false, false],
    ['A/B', false, true],
    ['2/(A-B)', false, true],
    ['-A', true, false],
  ])('%s linear=%s dividesBySymbol=%s', (s, linear, divides) => {
    const p = parseSymbolExpression(s);
    expect(p.linear).toBe(linear);
    expect(p.dividesBySymbol).toBe(divides);
  });
});

describe('errors', () => {
  it.each([
    ['', 'Empty expression', 0],
    ['   ', 'Empty expression', 0],
    ['AAPL/', "Expected a symbol, number or '('", 5],
    ['(AAPL', "Missing ')'", 0],
    ['A*(B+(C', "Missing ')'", 5],
    ['AAPL$', "Unexpected character '$'", 4],
    ['.5*A', "Unexpected character '.'", 0],
    ['2.*A', "Invalid number or symbol '2.'", 0],
    ['1.2.3*A', "Invalid number or symbol '1.2.3'", 0],
    ['2+3', 'Expression needs at least one symbol', 0],
    ['AAPL MSFT', 'Expected an operator', 5],
    ['(A B)', 'Expected an operator', 3],
    ['A)', "Unexpected ')'", 1],
    ['A*)', "Unexpected ')'", 2],
    ['A**B', "Expected a symbol, number or '('", 2],
    ['"A', `Unexpected character '"'`, 0],
    ['""*A', `Unexpected character '"'`, 0],
    ['A\u0001', "Unexpected character '\u0001'", 1],
  ])('%j -> %s @%d', (input, message, pos) => {
    const e = errorOf(input);
    expect(e).toBeInstanceOf(ExpressionError);
    expect(e.message).toBe(message);
    expect(e.pos).toBe(pos);
  });

  it('allows tabs as separators', () => {
    expect(canonicalSymbol('A\t-\tB')).toBe('A - B');
  });

  it('rejects more than 8 distinct symbols', () => {
    expect(canonicalSymbol('A+B+C+D+E+F+G+H+A')).toBe('A+B+C+D+E+F+G+H+A');
    const e = errorOf('A+B+C+D+E+F+G+H+I');
    expect(e.message).toBe('Too many symbols (max 8)');
    expect(e.pos).toBe(16);
  });

  it('rejects symbols longer than 32', () => {
    expect(canonicalSymbol('A'.repeat(32))).toBe('A'.repeat(32));
    const e = errorOf(`X+${'A'.repeat(33)}`);
    expect(e.message).toBe('Symbol too long (max 32)');
    expect(e.pos).toBe(2);
    expect(errorOf(`"${'A'.repeat(33)}"`).message).toBe('Symbol too long (max 32)');
  });

  it('rejects input longer than 256', () => {
    const ok = `A${'+1'.repeat(127)}`;
    expect(ok.length).toBe(255);
    expect(tryParseSymbolExpression(ok).ok).toBe(true);
    const e = errorOf(`${ok}+1`);
    expect(e.message).toBe('Expression too long (max 256 characters)');
  });

  it('rejects nesting deeper than 32', () => {
    expect(tryParseSymbolExpression(`${'('.repeat(32)}A${')'.repeat(32)}`).ok).toBe(true);
    const e = errorOf(`${'('.repeat(33)}A${')'.repeat(33)}`);
    expect(e.message).toBe('Too deeply nested (max 32)');
    expect(e.pos).toBe(32);
    expect(errorOf(`${'-'.repeat(33)}A`).message).toBe('Too deeply nested (max 32)');
  });

  it('canonicalSymbol throws ExpressionError', () => {
    expect(() => canonicalSymbol('AAPL/')).toThrow(ExpressionError);
    expect(isExpressionSymbol('AAPL/')).toBe(false);
  });
});

describe('round-trip', () => {
  // Deterministic LCG (Numerical Recipes constants).
  function lcg(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0;
      return s / 2 ** 32;
    };
  }

  const SYMBOLS = ['A', 'MSFT', 'BRK-B', 'BTC-USD', '^GSPC', 'EURUSD=X', '7203.T', 'BRK/B', '0700'];
  const NUMBERS = ['0', '1', '2', '10', '0.5', '7.5', '100.25', '3.14159'];
  const OPS: BinOp[] = ['+', '-', '*', '/'];

  function gen(rand: () => number, depth: number): ExprNode {
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
    const r = rand();
    if (depth <= 0 || r < 0.25) {
      if (rand() < 0.7) return { kind: 'sym', symbol: pick(SYMBOLS) };
      const text = pick(NUMBERS);
      return { kind: 'num', value: Number(text), text };
    }
    if (r < 0.4) return { kind: 'neg', arg: gen(rand, depth - 1) };
    return { kind: 'bin', op: pick(OPS), left: gen(rand, depth - 1), right: gen(rand, depth - 1) };
  }

  const syms = (n: ExprNode, out = new Set<string>()): Set<string> => {
    if (n.kind === 'sym') out.add(n.symbol);
    else if (n.kind === 'neg') syms(n.arg, out);
    else if (n.kind === 'bin') {
      syms(n.left, out);
      syms(n.right, out);
    }
    return out;
  };

  it('parse(format(ast)) equals ast for 500 random ASTs', () => {
    const rand = lcg(12345);
    let checked = 0;
    while (checked < 500) {
      const ast = gen(rand, 5);
      const text = formatExpression(ast);
      const distinct = syms(ast).size;
      if (distinct === 0 || distinct > EXPR_LIMITS.maxLegs || text.length > EXPR_LIMITS.maxInput) {
        continue;
      }
      const parsed = parseSymbolExpression(text);
      expect(parsed.ast, text).toEqual(ast);
      expect(formatExpression(parsed.ast)).toBe(text);
      expect(parsed.canonical).toBe(text);
      expect(parseSymbolExpression(parsed.canonical).plain).toBe(parsed.plain);
      checked++;
    }
  });
});
