/**
 * Pure helpers around `ScreenSpec`: the default draft, tolerant parsing of
 * stored/untrusted specs and comparison keys.
 */
import { isObj } from '../../persist/net';
import { SCREENER_CLASSES } from '../universe/types';
import { codePoints, FORMULA_MAX_LENGTH, FORMULA_OPS } from '../rules/formula';
import { isFormulaColumn, MAX_FORMULA_COLUMNS } from './columns';
import type { FormulaRule, Group, Rule, RuleOp, ScanSort, ScreenSpec, Universe } from './types';

export const RULE_OPS: readonly RuleOp[] = [
  '>',
  '<',
  '>=',
  '<=',
  '=',
  'between',
  'in',
  'crossesAbove',
  'crossesBelow',
  'abovePct',
  'belowPct',
];

/** Server universe cap for `{kind:'symbols'}`. */
export const MAX_SYMBOLS = 1000;

export const DEFAULT_SORT: ScanSort = { field: 'avgDollarVol30', dir: 'desc' };

export const defaultSpec = (cls: (typeof SCREENER_CLASSES)[number] = 'stocks'): ScreenSpec => ({
  schemaVersion: 1,
  universe: { kind: 'class', cls },
  filter: null,
  sort: { ...DEFAULT_SORT },
});

export function parseUniverse(v: unknown): Universe | null {
  if (!isObj(v)) return null;
  switch (v.kind) {
    case 'class':
      return typeof v.cls === 'string' && (SCREENER_CLASSES as readonly string[]).includes(v.cls)
        ? { kind: 'class', cls: v.cls as (typeof SCREENER_CLASSES)[number] }
        : null;
    case 'list':
    case 'watchlist':
      return typeof v.id === 'string' && v.id ? { kind: v.kind, id: v.id } : null;
    case 'symbols': {
      if (!Array.isArray(v.symbols)) return null;
      const symbols = v.symbols.filter((s): s is string => typeof s === 'string' && s !== '');
      return { kind: 'symbols', symbols: symbols.slice(0, MAX_SYMBOLS) };
    }
    default:
      return null;
  }
}

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/** A stored formula rule (design doc section 10); its text is validated by the rule builder. */
function parseFormulaRule(v: Record<string, unknown>): FormulaRule | null {
  if (
    typeof v.formula !== 'string' ||
    v.formula.length > FORMULA_MAX_LENGTH * 2 ||
    codePoints(v.formula) > FORMULA_MAX_LENGTH ||
    !(FORMULA_OPS as readonly unknown[]).includes(v.op)
  )
    return null;
  const op = v.op as FormulaRule['op'];
  const value = v.value;
  if (op === 'between')
    return Array.isArray(value) && value.length === 2 && isNum(value[0]) && isNum(value[1])
      ? { formula: v.formula, op, value: [value[0], value[1]] }
      : null;
  return isNum(value) ? { formula: v.formula, op, value } : null;
}

function parseNode(
  v: unknown,
  depth: number,
  budget: { left: number },
): Rule | FormulaRule | Group | null {
  if (!isObj(v)) return null;
  if (Array.isArray(v.rules)) {
    if ((v.op !== 'and' && v.op !== 'or') || depth > 2) return null;
    const rules: (Rule | FormulaRule | Group)[] = [];
    for (const c of v.rules) {
      const n = parseNode(c, depth + 1, budget);
      if (n) rules.push(n);
    }
    return { op: v.op, rules };
  }
  if ('formula' in v) {
    const rule = parseFormulaRule(v);
    if (!rule || budget.left <= 0) return null;
    budget.left--;
    return rule;
  }
  if (typeof v.field !== 'string' || !RULE_OPS.includes(v.op as RuleOp) || v.value === undefined)
    return null;
  if (budget.left <= 0) return null;
  budget.left--;
  return { field: v.field, op: v.op as RuleOp, value: v.value as Rule['value'] };
}

/** A stored filter, or null when absent or malformed (depth <= 2, <= 50 rules kept). */
export function parseFilter(v: unknown): Group | null {
  const g = parseNode(v, 1, { left: 50 });
  return g && 'rules' in g && g.rules.length ? g : null;
}

export function parseSort(v: unknown): ScanSort | null {
  return isObj(v) && typeof v.field === 'string' && v.field && (v.dir === 'asc' || v.dir === 'desc')
    ? { field: v.field, dir: v.dir }
    : null;
}

/** Tolerant parse of a stored spec; null when it has no usable universe. */
export function parseSpec(v: unknown): ScreenSpec | null {
  if (!isObj(v)) return null;
  const universe = parseUniverse(v.universe);
  if (!universe) return null;
  // Formula columns (`"=<formula>"`): well-formed, at most `MAX_FORMULA_COLUMNS`.
  let formulas = 0;
  const columns = Array.isArray(v.columns)
    ? v.columns.filter((c): c is string => {
        if (typeof c !== 'string') return false;
        if (!c.startsWith('=')) return true;
        return isFormulaColumn(c) && ++formulas <= MAX_FORMULA_COLUMNS;
      })
    : undefined;
  return {
    schemaVersion: 1,
    universe,
    filter: parseFilter(v.filter),
    sort: parseSort(v.sort) ?? { ...DEFAULT_SORT },
    ...(columns ? { columns } : {}),
  };
}

/** Stable key for comparing specs (universe, filter, sort; the columns are a view setting). */
export const specKey = (s: ScreenSpec): string => JSON.stringify([s.universe, s.filter, s.sort]);

export const universeKey = (u: Universe): string =>
  u.kind === 'symbols'
    ? `symbols:${u.symbols.join(',')}`
    : u.kind === 'class'
      ? `class:${u.cls}`
      : `${u.kind}:${u.id}`;

/** Symbols pasted as text: split on whitespace/commas/semicolons, upper-cased, deduplicated. */
export function parseSymbolList(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[\s,;]+/)) {
    const s = raw.trim().toUpperCase();
    if (s && /^[A-Z0-9.\-=^/&_]{1,32}$/.test(s) && !out.includes(s)) out.push(s);
  }
  return out;
}
