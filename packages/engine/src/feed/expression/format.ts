import type { ExprNode } from './ast';
import { isBareSymbol } from './lexer';

function precedence(n: ExprNode): number {
  if (n.kind !== 'bin') return 3;
  return n.op === '+' || n.op === '-' ? 1 : 2;
}

/**
 * Canonical text of an AST. Parenthesizes an operand only if it binds weaker
 * than its parent, or binds equally and is the right operand; associativity is
 * never exploited, so parsing the output yields the same AST.
 */
export function formatExpression(ast: ExprNode): string {
  switch (ast.kind) {
    case 'num':
      return ast.text;
    case 'sym':
      return isBareSymbol(ast.symbol) ? ast.symbol : `"${ast.symbol}"`;
    case 'neg': {
      const arg = formatExpression(ast.arg);
      return ast.arg.kind === 'bin' ? `-(${arg})` : `-${arg}`;
    }
    case 'bin': {
      const p = precedence(ast);
      const lp = precedence(ast.left);
      const rp = precedence(ast.right);
      let left = formatExpression(ast.left);
      let right = formatExpression(ast.right);
      if (lp < p) left = `(${left})`;
      if (rp <= p) right = `(${right})`;
      return ast.op === '-' ? `${left} - ${right}` : `${left}${ast.op}${right}`;
    }
  }
}
