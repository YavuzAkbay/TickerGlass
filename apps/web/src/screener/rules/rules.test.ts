import { describe, expect, it } from 'vitest';
import type { FieldDef, Group, Rule } from '../server/types';
import {
  addNode,
  canAddGroup,
  coerceField,
  coerceOp,
  countGroups,
  countRules,
  dateEdge,
  dateToSeconds,
  defaultField,
  depthOf,
  duplicateNode,
  emptyGroup,
  fieldIndex,
  formatShort,
  isGroup,
  MAX_GROUPS,
  MAX_RULES,
  newRule,
  parseGroup,
  parseNumberText,
  removeNode,
  secondsToDate,
  serializeGroup,
  setGroupOp,
  summarize,
  toRequest,
  updateRule,
  validate,
  type EditGroup,
  type EditRule,
  type SummaryLabels,
} from './rules';

const f = (over: Partial<FieldDef> & Pick<FieldDef, 'id'>): FieldDef => ({
  category: 'technical',
  type: 'number',
  unit: null,
  dimension: over.id,
  ops: ['>', '<', '>=', '<=', 'between'],
  crossable: false,
  available: true,
  enumValues: null,
  ...over,
});

const FIELDS: FieldDef[] = [
  f({
    id: 'rsi14',
    dimension: 'oscillator',
    ops: ['>', '<', '>=', '<=', 'between', 'crossesAbove', 'crossesBelow'],
    crossable: true,
  }),
  f({ id: 'mcap', type: 'money', category: 'fundamental', dimension: 'money' }),
  f({ id: 'perf1m', type: 'percent', category: 'performance', dimension: 'percent' }),
  f({ id: 'perf1y', type: 'percent', category: 'performance', dimension: 'percent' }),
  f({
    id: 'last',
    category: 'price',
    dimension: 'price',
    ops: ['>', '<', 'crossesAbove', 'abovePct', 'belowPct'],
    crossable: true,
  }),
  f({
    id: 'sma200',
    category: 'price',
    dimension: 'price',
    ops: ['>', '<', 'crossesAbove'],
    crossable: true,
  }),
  f({ id: 'newHi52', type: 'bool', ops: ['='] }),
  f({ id: 'smaCross', type: 'enum', ops: ['=', 'in'], enumValues: ['golden', 'death'] }),
  f({
    id: 'sector',
    type: 'enum',
    category: 'fundamental',
    ops: ['=', 'in'],
    enumValues: ['Technology', 'Energy', 'Utilities'],
  }),
  f({ id: 'pe', category: 'fundamental', available: false }),
  f({
    id: 'nextEarnings',
    type: 'date',
    category: 'fundamental',
    dimension: 'date',
    unit: 'unix_s',
    ops: ['>', '<', '>=', '<=', 'between'],
  }),
];
const index = fieldIndex(FIELDS);

const rule = (field: string, op: Rule['op'], value: Rule['value']): Rule => ({ field, op, value });
const group = (op: 'and' | 'or', ...rules: (Rule | Group)[]): Group => ({ op, rules });

const LABELS: SummaryLabels = {
  field: (id) =>
    ({
      rsi14: 'RSI(14)',
      mcap: 'Mkt cap',
      last: 'Price',
      sma200: 'SMA(200)',
      perf1m: 'Perf 1M',
      newHi52: 'New 52W high',
      sector: 'Sector',
    })[id] ?? id,
  op: (op) =>
    ({ '>': '>', '<': '<', '=': '=', between: 'between', in: 'in', crossesAbove: 'crosses above' })[
      op as string
    ] ?? op,
  pct: (op, a, pct, b) => `${a} is ${pct}% ${op === 'abovePct' ? 'above' : 'below'} ${b}`,
  yes: 'yes',
  no: 'no',
  and: 'AND',
  or: 'OR',
};

describe('parseNumberText / formatShort', () => {
  it('parses plain numbers and K/M/B/T shorthand only when enabled', () => {
    expect(parseNumberText('30')).toBe(30);
    expect(parseNumberText(' -2.5 ')).toBe(-2.5);
    expect(parseNumberText('1e3')).toBe(1000);
    expect(parseNumberText('10B', true)).toBe(1e10);
    expect(parseNumberText('$2.5m', true)).toBe(2_500_000);
    expect(parseNumberText('300K', true)).toBe(300_000);
    expect(parseNumberText('1,200', true)).toBe(1200);
    expect(parseNumberText('10B')).toBeNull();
    expect(parseNumberText('')).toBeNull();
    expect(parseNumberText('abc', true)).toBeNull();
    expect(parseNumberText('5%')).toBe(5);
  });

  it('formats back to the shorthand', () => {
    expect(formatShort(1e10)).toBe('10B');
    expect(formatShort(2_500_000)).toBe('2.5M');
    expect(formatShort(950)).toBe('950');
    expect(formatShort(1.5e12)).toBe('1.5T');
    expect(parseNumberText(formatShort(3.25e9), true)).toBe(3.25e9);
  });
});

describe('serialize / parse', () => {
  const g = group(
    'and',
    rule('rsi14', '<', 30),
    group('or', rule('mcap', '>', 1e10), rule('last', 'abovePct', { field: 'sma200', pct: 5 })),
    rule('sector', 'in', ['Energy', 'Utilities']),
    rule('rsi14', 'between', [30, 70]),
    rule('newHi52', '=', true),
    rule('smaCross', '=', 'golden'),
  );

  it('round-trips a contract group', () => {
    expect(serializeGroup(parseGroup(g))).toEqual(g);
  });

  it('drops incomplete rules and prunes empty groups', () => {
    const draft: EditGroup = {
      ...emptyGroup(),
      rules: [
        { key: 'a', field: 'rsi14', op: '<', value: null },
        { key: 'b', field: 'rsi14', op: '>', value: 50 },
        { ...emptyGroup('or'), rules: [{ key: 'c', field: 'mcap', op: '>', value: null }] },
      ],
    };
    expect(serializeGroup(draft)).toEqual(group('and', rule('rsi14', '>', 50)));
    expect(serializeGroup(emptyGroup())).toBeNull();
    expect(parseGroup(null).rules).toEqual([]);
  });
});

describe('validate / toRequest', () => {
  const codes = (g: Group | EditGroup) => validate(g, FIELDS).map((i) => i.code);

  it('accepts valid rules', () => {
    expect(codes(group('and', rule('rsi14', '<', 30), rule('mcap', '>', 1e10)))).toEqual([]);
    expect(codes(group('and', rule('last', 'crossesAbove', { field: 'sma200' })))).toEqual([]);
    expect(codes(group('and', rule('last', 'abovePct', { field: 'sma200', pct: 5 })))).toEqual([]);
    expect(codes(group('and', rule('sector', 'in', ['Energy'])))).toEqual([]);
    expect(codes(group('and', rule('newHi52', '=', false)))).toEqual([]);
  });

  it('reports contract error codes with server-style paths', () => {
    const g = group(
      'and',
      rule('nope', '>', 1),
      rule('pe', '>', 10),
      rule('rsi14', 'abovePct', { field: 'rsi14', pct: 1 }),
      rule('perf1m', 'crossesAbove', 5),
      rule('rsi14', '>', { field: 'mcap' }),
      rule('rsi14', 'between', [70, 30]),
      rule('smaCross', '=', 'sideways'),
      rule('sector', 'in', ['Mars']),
      rule('newHi52', '=', 1 as never),
    );
    const issues = validate(g, FIELDS);
    expect(issues.map((i) => [i.path, i.code])).toEqual([
      ['rules[0]', 'unknown_field'],
      ['rules[1]', 'field_unavailable'],
      ['rules[2]', 'bad_op'],
      ['rules[3]', 'bad_op'],
      ['rules[4]', 'bad_value'], // different dimension
      ['rules[5]', 'bad_value'],
      ['rules[6]', 'bad_value'],
      ['rules[7]', 'bad_value'],
      ['rules[8]', 'bad_value'],
    ]);
  });

  it('operands must share the dimension and not point at the field itself', () => {
    expect(codes(group('and', rule('perf1m', '>', { field: 'perf1y' })))).toEqual([]);
    expect(codes(group('and', rule('perf1m', '>', { field: 'perf1m' })))).toEqual(['bad_value']);
    expect(codes(group('and', rule('perf1m', '>', { field: 'rsi14' })))).toEqual(['bad_value']);
    expect(codes(group('and', rule('perf1m', '>', { field: 'ghost' })))).toEqual(['unknown_field']);
  });

  it('enforces depth 2 and 50 rules', () => {
    const deep = group('and', group('and', group('and', rule('rsi14', '<', 1))));
    expect(depthOf(deep)).toBe(3);
    expect(codes(deep)).toEqual(['too_complex']);
    const many = group(
      'and',
      ...Array.from({ length: MAX_RULES + 1 }, () => rule('rsi14', '<', 1)),
    );
    expect(codes(many)).toContain('too_complex');
    expect(countRules(many)).toBe(51);
  });

  it('toRequest ignores incomplete rules but blocks on wrong ones', () => {
    const draft = parseGroup(group('and', rule('rsi14', '<', 30)));
    draft.rules.push({ key: 'x', field: 'mcap', op: '>', value: null });
    const ok = toRequest(draft, FIELDS);
    expect(ok.blocking).toBe(false);
    expect(ok.filter).toEqual(group('and', rule('rsi14', '<', 30)));
    expect(ok.issues.map((i) => i.code)).toEqual(['incomplete']);
    expect(ok.issues[0]?.key).toBe('x');

    draft.rules.push({ key: 'y', field: 'ghost', op: '>', value: 1 });
    expect(toRequest(draft, FIELDS).blocking).toBe(true);
  });
});

describe('editing', () => {
  const base = parseGroup(
    group('and', rule('rsi14', '<', 30), group('or', rule('mcap', '>', 1e9))),
  );
  const first = base.rules[0] as EditRule;
  const nested = base.rules[1] as EditGroup;

  it('updates, duplicates and removes rules immutably', () => {
    const updated = updateRule(base, first.key, { value: 25 });
    expect(serializeGroup(updated)?.rules[0]).toEqual(rule('rsi14', '<', 25));
    expect(serializeGroup(base)?.rules[0]).toEqual(rule('rsi14', '<', 30));

    const dup = duplicateNode(base, first.key);
    expect(countRules(dup)).toBe(3);
    expect((dup.rules[1] as EditRule).key).not.toBe(first.key);
    expect((dup.rules[1] as EditRule).field).toBe('rsi14');

    const gone = removeNode(base, first.key);
    expect(countRules(gone)).toBe(1);
    expect(isGroup(gone.rules[0]!)).toBe(true);
    expect(countRules(removeNode(base, nested.key))).toBe(1);
  });

  it('switches the combinator of root and nested groups', () => {
    expect(setGroupOp(base, base.key, 'or').op).toBe('or');
    expect((setGroupOp(base, nested.key, 'and').rules[1] as EditGroup).op).toBe('and');
  });

  it('allows one nested level only and at most 50 rules', () => {
    expect(canAddGroup(base, base.key)).toBe(true);
    expect(canAddGroup(base, nested.key)).toBe(false);
    expect(addNode(base, nested.key, emptyGroup())).toBe(base);
    let g = emptyGroup();
    for (let i = 0; i < MAX_RULES + 5; i++) g = addNode(g, g.key, newRule(FIELDS[0]!));
    expect(countRules(g)).toBe(MAX_RULES);
    expect(duplicateNode(g, g.rules[0]!.key)).toBe(g);
  });

  it('keeps or resets the value when op or field changes', () => {
    const rsi = index.get('rsi14')!;
    const between = coerceOp(first, rsi, 'between');
    expect(between.op).toBe('between');
    expect(between.value).toBeNull();
    expect(coerceOp(first, rsi, '>').value).toBe(30);
    const toBool = coerceField(first, rsi, index.get('newHi52')!);
    expect(toBool).toMatchObject({ field: 'newHi52', op: '=', value: true });
    // A threshold carries across fields of the same type when the op exists.
    const perf = coerceField(
      { ...first, field: 'perf1m', value: 5 },
      index.get('perf1m')!,
      index.get('perf1y')!,
    );
    expect(perf.value).toBe(5);
  });

  it('starts new rules on RSI when the catalog has it', () => {
    expect(defaultField(FIELDS)?.id).toBe('rsi14');
    expect(defaultField(FIELDS.filter((x) => x.id !== 'rsi14'))?.id).toBe('mcap');
    expect(newRule(FIELDS[0]!)).toMatchObject({ field: 'rsi14', op: '>', value: null });
  });
});

describe('summarize', () => {
  it('reads like the screen', () => {
    expect(
      summarize(group('and', rule('rsi14', '<', 30), rule('mcap', '>', 1e10)), FIELDS, LABELS),
    ).toBe('RSI(14) < 30 AND Mkt cap > $10B');
  });

  it('formats percents, ranges, lists, booleans, field operands and nesting', () => {
    expect(summarize(group('or', rule('perf1m', '>', 5)), FIELDS, LABELS)).toBe('Perf 1M > 5%');
    expect(summarize(group('and', rule('rsi14', 'between', [30, 70])), FIELDS, LABELS)).toBe(
      'RSI(14) between 30 – 70',
    );
    expect(
      summarize(group('and', rule('sector', 'in', ['Energy', 'Utilities'])), FIELDS, LABELS),
    ).toBe('Sector in Energy, Utilities');
    expect(summarize(group('and', rule('newHi52', '=', true)), FIELDS, LABELS)).toBe(
      'New 52W high = yes',
    );
    expect(
      summarize(group('and', rule('last', 'crossesAbove', { field: 'sma200' })), FIELDS, LABELS),
    ).toBe('Price crosses above SMA(200)');
    expect(
      summarize(
        group('and', rule('last', 'abovePct', { field: 'sma200', pct: 5 })),
        FIELDS,
        LABELS,
      ),
    ).toBe('Price is 5% above SMA(200)');
    expect(
      summarize(
        group(
          'and',
          rule('rsi14', '<', 30),
          group('or', rule('mcap', '>', 1e9), rule('perf1m', '>', 1)),
        ),
        FIELDS,
        LABELS,
      ),
    ).toBe('RSI(14) < 30 AND (Mkt cap > $1B OR Perf 1M > 1%)');
    expect(summarize(null, FIELDS, LABELS)).toBe('');
  });

  it('default labels come from the catalog', () => {
    expect(summarize(group('and', rule('rsi14', '<', 30), rule('mcap', '>', 1e10)), FIELDS)).toBe(
      'RSI(14) < 30 AND Mkt cap > $10B',
    );
  });
});

describe('date rules', () => {
  const START = Date.parse('2026-11-10T00:00:00Z') / 1000;
  const END = START + 86_399;
  const earnings = index.get('nextEarnings')!;

  it('converts a UTC day to its first or last second', () => {
    expect(dateToSeconds('2026-11-10')).toBe(START);
    expect(dateToSeconds('2026-11-10', 'start')).toBe(START);
    expect(dateToSeconds('2026-11-10', 'end')).toBe(END);
    expect(secondsToDate(START)).toBe('2026-11-10');
    expect(secondsToDate(END)).toBe('2026-11-10');
    expect(dateToSeconds('')).toBeNull();
    expect(dateToSeconds('2026-13-45', 'end')).toBeNull();
  });

  it('puts the picked day on the right side of the comparison', () => {
    // `<= D` and `> D` use the end of D; `< D` and `>= D` its start; between spans whole days.
    expect(dateEdge('<=')).toBe('end');
    expect(dateEdge('>')).toBe('end');
    expect(dateEdge('<')).toBe('start');
    expect(dateEdge('>=')).toBe('start');
    expect(dateEdge('between', 'lo')).toBe('start');
    expect(dateEdge('between', 'hi')).toBe('end');
  });

  it('re-snaps the day to the new op, keeping the picked date', () => {
    const rule0: EditRule = { key: 'd', field: 'nextEarnings', op: '>=', value: START };
    const le = coerceOp(rule0, earnings, '<=');
    expect(le.value).toBe(END);
    expect(coerceOp(le, earnings, '<').value).toBe(START);
    expect(coerceOp(le, earnings, 'between').value).toBeNull(); // another widget: reset
    const empty = coerceOp({ ...rule0, value: null }, earnings, '<=');
    expect(empty.value).toBeNull();
  });
});

describe('group budget', () => {
  it('counts the root and at most 20 groups', () => {
    let g = emptyGroup();
    for (let i = 0; i < MAX_GROUPS + 5; i++) g = addNode(g, g.key, emptyGroup());
    expect(countGroups(g)).toBe(MAX_GROUPS);
    expect(canAddGroup(g, g.key)).toBe(false);
    const wide = group(
      'and',
      ...Array.from({ length: MAX_GROUPS }, () => group('or', rule('rsi14', '<', 1))),
    );
    expect(countGroups(wide)).toBe(MAX_GROUPS + 1);
    expect(validate(wide, FIELDS).map((i) => i.code)).toEqual(['too_complex']);
  });
});
