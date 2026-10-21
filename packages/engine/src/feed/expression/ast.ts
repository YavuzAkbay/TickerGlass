/** Binary operators of the symbol expression language. */
export type BinOp = '+' | '-' | '*' | '/';

export type ExprNode =
  /** `text` is the normalized literal ("007.50" -> "7.5"). */
  | { kind: 'num'; value: number; text: string }
  | { kind: 'sym'; symbol: string }
  /** Unary minus. Unary '+' produces no node. */
  | { kind: 'neg'; arg: ExprNode }
  | { kind: 'bin'; op: BinOp; left: ExprNode; right: ExprNode };

export interface ParsedSymbol {
  ast: ExprNode;
  /** Canonical text; re-parses to the same AST (plain symbols quoted if needed). */
  canonical: string;
  /** Distinct symbols in first-appearance order; `symbols[0]` is the primary leg. */
  symbols: string[];
  /** The root is a single symbol. */
  plain: boolean;
  /** No symbol * symbol and no division by a symbol (currency is meaningful). */
  linear: boolean;
  /** Some divisor depends on a symbol (ratios need more decimals). */
  dividesBySymbol: boolean;
}

/** Lex/parse failure. `pos` is a 0-based index into the raw input. */
export class ExpressionError extends Error {
  readonly pos: number;

  constructor(message: string, pos: number) {
    super(message);
    this.name = 'ExpressionError';
    this.pos = pos;
  }
}

export const EXPR_LIMITS = {
  maxInput: 256,
  maxSymbolLength: 32,
  maxLegs: 8,
  maxDepth: 32,
} as const;
