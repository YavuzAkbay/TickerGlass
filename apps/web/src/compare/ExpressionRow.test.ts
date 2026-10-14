import { describe, expect, it } from 'vitest';
import { classifyQuery } from './ExpressionRow';

describe('classifyQuery', () => {
  it('plain text and empty queries are plain', () => {
    expect(classifyQuery('')).toEqual({ kind: 'plain' });
    expect(classifyQuery('AAPL')).toEqual({ kind: 'plain' });
    expect(classifyQuery('apple inc')).toEqual({ kind: 'plain' });
  });

  it('valid expressions are expressions with a canonical form', () => {
    expect(classifyQuery('aapl/msft')).toEqual({ kind: 'expression', canonical: 'AAPL/MSFT' });
  });

  it('broken expressions are errors', () => {
    expect(classifyQuery('AAPL/').kind).toBe('error');
    expect(classifyQuery('(AAPL').kind).toBe('error');
    expect(classifyQuery('AAPL + ').kind).toBe('error');
  });

  it('company-name-like queries that fail to parse fall back to a normal search', () => {
    expect(classifyQuery('Alphabet - Class A')).toEqual({ kind: 'plain' });
    expect(classifyQuery('S&P (500)').kind).toBe('error');
    expect(classifyQuery('Berkshire Hathaway (B)')).toEqual({ kind: 'plain' });
  });
});
