import { describe, expect, it } from 'vitest';
// Shared with the API's pytest suite: both parsers must agree on every vector.
import vectors from '../../../../../api/tests/data/formula_vectors.json';
import { parseFilter } from '../server/spec';
import type { FieldDef, FieldType, Group } from '../server/types';
import {
  applySuggestion,
  parseFormula,
  sexpr,
  suggest,
  wordAt,
  type FormulaField,
} from './formula';
import {
  addNode,
  canAddFormula,
  countFormulas,
  duplicateNode,
  emptyGroup,
  newFormula,
  parseGroup,
  serializeGroup,
  summarize,
  toRequest,
  updateFormula,
  validate,
  type EditFormula,
} from './rules';

interface VectorField {
  id: string;
  type: FieldType;
  crossable: boolean;
  fundamental: boolean;
}

const catalog = (fundamentals: boolean): FormulaField[] =>
  (vectors.fields as VectorField[]).map((f) => ({
    id: f.id,
    type: f.type,
    crossable: f.crossable,
    available: fundamentals || !f.fundamental,
  }));

describe('shared formula vectors', () => {
  it.each(vectors.valid)('parses $formula', ({ formula, sexpr: want }) => {
    const r = parseFormula(formula, catalog(true));
    expect(r.ok ? sexpr(r.node) : r.error).toBe(want);
  });

  it.each(vectors.invalid)('rejects $formula', (vec) => {
    const r = parseFormula(
      vec.formula,
      catalog((vec as { fundamentals?: boolean }).fundamentals ?? true),
    );
    expect(r.ok ? null : { code: r.error.code, offset: r.error.offset }).toEqual({
      code: vec.code,
      offset: vec.offset,
    });
  });
});

describe('formula parser', () => {
  const fields = catalog(true);

  it('applies precedence and associativity', () => {
    const p = (s: string) => {
      const r = parseFormula(s, fields);
      return r.ok ? sexpr(r.node) : r.error.reason;
    };
    expect(p('1 + 2 * 3 - 4 / 2')).toBe('(- (+ 1 (* 2 3)) (/ 4 2))');
    expect(p('-last * -2')).toBe('(* (neg last) (neg 2))');
    expect(p('max(abs(chg1d), gapPct) / prev(sma50)')).toBe(
      '(/ (max (abs chg1d) gapPct) (prev sma50))',
    );
    expect(p('last +')).toBe('end');
    expect(p('foo(1)')).toBe('unknownFn');
  });

  it('never throws on hostile input', () => {
    for (const s of [
      'constructor',
      '__proto__',
      'toString',
      'hasOwnProperty(1)',
      '\u0000',
      '\ud800',
    ])
      expect(parseFormula(s, fields).ok).toBe(false);
  });

  it('accepts a FieldDef catalog and honours availability', () => {
    const defs: FieldDef[] = [
      {
        id: 'pe',
        category: 'fundamental',
        type: 'number',
        unit: null,
        dimension: 'ratio',
        ops: ['>'],
        crossable: false,
        available: false,
        enumValues: null,
      },
    ];
    const r = parseFormula('pe * 2', defs);
    expect(r.ok ? null : r.error).toEqual({
      code: 'field_unavailable',
      reason: 'unavailable',
      offset: 0,
      name: 'pe',
    });
  });
});

describe('formula autocomplete', () => {
  const fields = catalog(true);

  it('finds the word at the caret', () => {
    expect(wordAt('last / sm', 9)).toEqual({ start: 7, end: 9, word: 'sm' });
    expect(wordAt('last / ', 7).word).toBe('');
    expect(wordAt('1abc', 4).word).toBe('');
  });

  it('suggests numeric fields and functions, prefix matches first', () => {
    const ids = suggest('last / sm', 9, fields).map((s) => s.id);
    expect(ids.slice(0, 4)).toEqual(['sma20', 'sma50', 'sma200', 'pctVsSma20']);
    expect(suggest('ab', 2, fields)[0]).toEqual({ insert: 'abs(', kind: 'function', id: 'abs' });
    // Non-numeric fields are never offered.
    expect(suggest('sec', 3, fields).map((s) => s.id)).not.toContain('sector');
    expect(suggest('nextE', 5, fields)).toEqual([]);
    // Inside prev( only crossable fields.
    expect(suggest('prev(s', 6, fields).map((s) => s.id)).toEqual([
      'sma20',
      'sma50',
      'sma200',
      'last',
      'rsi14',
    ]);
    // Unavailable fields are hidden.
    expect(suggest('mca', 3, catalog(false))).toEqual([]);
  });

  it('replaces the word being typed', () => {
    const s = suggest('last / sm2 + 1', 9, fields)[0]!;
    expect(applySuggestion('last / sm2 + 1', 9, s)).toEqual({
      text: 'last / sma20 + 1',
      caret: 12,
    });
  });
});

describe('formula rules in the draft', () => {
  const fields = catalog(true) as unknown as FieldDef[];
  const group: Group = {
    op: 'and',
    rules: [
      { field: 'rsi14', op: '<', value: 30 },
      { formula: 'last / sma200 - 1', op: 'between', value: [-0.05, 0.05] },
    ],
  };

  it('round-trips through the draft and the stored-spec parser', () => {
    expect(serializeGroup(parseGroup(group))).toEqual(group);
    expect(parseFilter(JSON.parse(JSON.stringify(group)))).toEqual(group);
    expect(parseFilter({ op: 'and', rules: [{ formula: 'last', op: '=', value: 1 }] })).toBeNull();
    expect(
      parseFilter({ op: 'and', rules: [{ formula: 'last', op: 'between', value: 1 }] }),
    ).toBeNull();
  });

  it('leaves out incomplete formulas and reports errors with their offset', () => {
    const root = emptyGroup();
    let d = addNode(root, root.key, newFormula());
    const key = d.rules[0]!.key;
    expect(toRequest(d, fields)).toMatchObject({ filter: null, blocking: false });
    d = updateFormula(d, key, { formula: 'last / nope', value: 1 });
    const built = toRequest(d, fields);
    expect(built.blocking).toBe(true);
    expect(built.issues).toEqual([
      { path: 'rules[0].formula', code: 'unknown_field', key, offset: 7 },
    ]);
    d = updateFormula(d, key, { formula: 'last / sma200' });
    expect(toRequest(d, fields)).toEqual({
      filter: { op: 'and', rules: [{ formula: 'last / sma200', op: '>', value: 1 }] },
      issues: [],
      blocking: false,
    });
    d = updateFormula(d, key, { op: 'between', value: [2, 1] });
    expect(validate(d, fields)).toEqual([{ path: 'rules[0]', code: 'bad_value', key }]);
  });

  it('caps formula rules at 10', () => {
    let d = emptyGroup();
    for (let i = 0; i < 12; i++) d = addNode(d, d.key, newFormula(`last * ${i}`));
    expect(countFormulas(d)).toBe(10);
    expect(canAddFormula(d)).toBe(false);
    expect(duplicateNode(d, d.rules[0]!.key)).toBe(d);
    const tooMany: Group = {
      op: 'and',
      rules: Array.from({ length: 11 }, (_, i) => ({
        formula: `last * ${i}`,
        op: '>' as const,
        value: 1,
      })),
    };
    expect(validate(tooMany, fields)).toEqual([{ path: 'rules[10]', code: 'too_complex' }]);
  });

  it('copies a duplicated range value', () => {
    const root = emptyGroup();
    let d = addNode(root, root.key, { ...newFormula('last'), op: 'between', value: [1, 2] });
    d = duplicateNode(d, d.rules[0]!.key);
    const [a, b] = d.rules as EditFormula[];
    expect(b!.value).toEqual([1, 2]);
    expect(b!.value).not.toBe(a!.value);
  });

  it('summarizes formulas', () => {
    expect(summarize(group, fields)).toBe(
      'RSI(14) < 30 AND {last / sma200 - 1} between -0.05 – 0.05',
    );
  });
});
