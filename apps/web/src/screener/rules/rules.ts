/**
 * Pure helpers of the rule builder: the editable draft model (rules may be
 * incomplete while typing), validation against the server's field catalog,
 * conversion to/from the frozen `Group` contract, value text parsing and a
 * human-readable summary. No React; unit-tested.
 */
import { en } from '../../i18n/en';
import { t as translate, type MessageKey } from '../../i18n';
import type {
  FieldDef,
  FieldType,
  FormulaRule,
  Group,
  Rule,
  RuleOp,
  RuleValue,
} from '../server/types';
import { FORMULA_OPS, MAX_FORMULA_RULES, parseFormula, type FormulaOp } from './formula';

/** Contract limits: a group may nest one level (depth 2), 50 rules and 20 groups in total. */
export const MAX_DEPTH = 2;
export const MAX_RULES = 50;
/** Groups of a filter, the root included. */
export const MAX_GROUPS = 20;

// ------------------------------------------------------------ draft model

export interface EditRule {
  key: string;
  field: string;
  op: RuleOp;
  /** `null` while the user has not entered a value yet. */
  value: RuleValue | null;
}

/** A formula rule being edited (design doc section 10). */
export interface EditFormula {
  key: string;
  formula: string;
  op: FormulaOp;
  /** `null` while the user has not entered a value yet. */
  value: number | [number, number] | null;
}

export interface EditGroup {
  key: string;
  op: 'and' | 'or';
  rules: (EditRule | EditFormula | EditGroup)[];
}

export type EditNode = EditRule | EditFormula | EditGroup;

export const isGroup = <G extends { rules: unknown }>(n: object): n is G => 'rules' in n;

/** A formula rule (draft or contract): told apart by its `formula` key. */
export const isFormula = <F extends { formula: string }>(n: object): n is F => 'formula' in n;

let keySeq = 0;
export const newKey = (): string => `r${++keySeq}`;

export const emptyGroup = (op: 'and' | 'or' = 'and'): EditGroup => ({
  key: newKey(),
  op,
  rules: [],
});

/** Contract group (or none) -> editable draft with fresh keys; always a group at the root. */
export function parseGroup(g: Group | null | undefined): EditGroup {
  if (!g) return emptyGroup();
  const conv = (n: Rule | FormulaRule | Group): EditNode =>
    isGroup<Group>(n)
      ? { key: newKey(), op: n.op, rules: n.rules.map(conv) }
      : isFormula<FormulaRule>(n)
        ? { key: newKey(), formula: n.formula, op: n.op, value: n.value }
        : { key: newKey(), field: n.field, op: n.op, value: n.value };
  return { key: newKey(), op: g.op, rules: g.rules.map(conv) };
}

const isEmptyValue = (v: RuleValue | null | undefined): boolean =>
  v === null ||
  v === undefined ||
  (typeof v === 'number' && !Number.isFinite(v)) ||
  (typeof v === 'string' && v === '') ||
  (Array.isArray(v) && (v.length === 0 || v.some((x) => x === null || x === undefined))) ||
  (typeof v === 'object' &&
    !Array.isArray(v) &&
    ('field' in v ? v.field === '' || ('pct' in v && !Number.isFinite(v.pct)) : false));

/**
 * Draft -> contract group. Incomplete rules (no value yet) are left out, empty
 * groups are pruned; `null` when nothing is left. Does not validate.
 */
export function serializeGroup(g: EditGroup): Group | null {
  const rules: (Rule | FormulaRule | Group)[] = [];
  for (const n of g.rules) {
    if (isGroup<EditGroup>(n)) {
      const sub = serializeGroup(n);
      if (sub) rules.push(sub);
    } else if (isFormula<EditFormula>(n)) {
      if (n.formula.trim() !== '' && !isEmptyValue(n.value))
        rules.push({ formula: n.formula, op: n.op, value: n.value as FormulaRule['value'] });
    } else if (!isEmptyValue(n.value)) {
      rules.push({ field: n.field, op: n.op, value: n.value as RuleValue });
    }
  }
  return rules.length ? { op: g.op, rules } : null;
}

// ------------------------------------------------------------ structure

/** Rules (not groups) in a draft or contract tree. */
export function countRules(g: { rules: unknown[] }): number {
  let n = 0;
  for (const c of g.rules as { rules?: unknown[] }[]) n += c.rules ? countRules(c as never) : 1;
  return n;
}

/** Groups in the tree, the root included. */
export function countGroups(g: { rules: unknown[] }): number {
  let n = 1;
  for (const c of g.rules as { rules?: unknown[] }[]) if (c.rules) n += countGroups(c as never);
  return n;
}

/** Nesting depth: a group of plain rules is 1. */
export function depthOf(g: { rules: unknown[] }): number {
  let d = 0;
  for (const c of g.rules as { rules?: unknown[] }[])
    if (c.rules) d = Math.max(d, depthOf(c as never));
  return d + 1;
}

export function findNode(g: EditGroup, key: string): { node: EditNode; depth: number } | null {
  if (g.key === key) return { node: g, depth: 1 };
  for (const c of g.rules) {
    if (c.key === key) return { node: c, depth: 2 };
    if (isGroup<EditGroup>(c)) {
      const sub = findNode(c, key);
      if (sub) return { node: sub.node, depth: sub.depth + 1 };
    }
  }
  return null;
}

export const canAddRule = (root: EditGroup): boolean => countRules(root) < MAX_RULES;

/** Formula rules in a draft or contract tree. */
export function countFormulas(g: { rules: unknown[] }): number {
  let n = 0;
  for (const c of g.rules as object[])
    if (isGroup<{ rules: unknown[] }>(c)) n += countFormulas(c);
    else if (isFormula(c)) n++;
  return n;
}

export const canAddFormula = (root: EditGroup): boolean =>
  canAddRule(root) && countFormulas(root) < MAX_FORMULA_RULES;

/** A new formula rule (`>` with no value yet). */
export const newFormula = (formula = ''): EditFormula => ({
  key: newKey(),
  formula,
  op: '>',
  value: null,
});

/** A nested group can be added to `groupKey` only below the depth limit. */
export function canAddGroup(root: EditGroup, groupKey: string): boolean {
  const hit = findNode(root, groupKey);
  return (
    !!hit &&
    isGroup(hit.node) &&
    hit.depth < MAX_DEPTH &&
    canAddRule(root) &&
    countGroups(root) < MAX_GROUPS
  );
}

function mapGroup(
  g: EditGroup,
  fn: (n: EditNode, parent: EditGroup) => EditNode | null,
): EditGroup {
  const rules: EditNode[] = [];
  for (const c of g.rules) {
    const mapped = fn(c, g);
    if (!mapped) continue;
    rules.push(isGroup<EditGroup>(mapped) ? mapGroup(mapped, fn) : mapped);
  }
  return { ...g, rules };
}

export function updateRule(root: EditGroup, key: string, patch: Partial<EditRule>): EditGroup {
  return mapGroup(root, (n) =>
    n.key === key && !isGroup(n) && !isFormula(n) ? { ...n, ...patch } : n,
  );
}

export function updateFormula(
  root: EditGroup,
  key: string,
  patch: Partial<Omit<EditFormula, 'key'>>,
): EditGroup {
  return mapGroup(root, (n) =>
    n.key === key && isFormula<EditFormula>(n) ? { ...n, ...patch } : n,
  );
}

/** Switch a formula rule's operator: a number stays for the comparisons, a range for `between`. */
export function coerceFormulaOp(rule: EditFormula, op: FormulaOp): EditFormula {
  const wasRange = rule.op === 'between';
  return { ...rule, op, value: wasRange === (op === 'between') ? rule.value : null };
}

export function setGroupOp(root: EditGroup, key: string, op: 'and' | 'or'): EditGroup {
  if (root.key === key) return { ...root, op };
  return mapGroup(root, (n) => (n.key === key && isGroup(n) ? { ...n, op } : n));
}

export function removeNode(root: EditGroup, key: string): EditGroup {
  return mapGroup(root, (n) => (n.key === key ? null : n));
}

const cloneNode = (n: EditNode): EditNode =>
  isGroup<EditGroup>(n)
    ? { key: newKey(), op: n.op, rules: n.rules.map(cloneNode) }
    : isFormula<EditFormula>(n)
      ? {
          ...n,
          key: newKey(),
          value: Array.isArray(n.value) ? [n.value[0], n.value[1]] : n.value,
        }
      : {
          ...n,
          key: newKey(),
          value: Array.isArray(n.value) ? ([...n.value] as RuleValue) : n.value,
        };

/** Insert a copy right after the node; no-op past the rule limit. */
export function duplicateNode(root: EditGroup, key: string): EditGroup {
  const hit = findNode(root, key);
  if (!hit || hit.node === root) return root;
  const size = isGroup<EditGroup>(hit.node) ? countRules(hit.node) : 1;
  if (countRules(root) + size > MAX_RULES) return root;
  const formulas = isGroup<EditGroup>(hit.node)
    ? countFormulas(hit.node)
    : isFormula(hit.node)
      ? 1
      : 0;
  if (formulas && countFormulas(root) + formulas > MAX_FORMULA_RULES) return root;
  const walk = (g: EditGroup): EditGroup => {
    const rules: EditNode[] = [];
    for (const c of g.rules) {
      rules.push(isGroup<EditGroup>(c) ? walk(c) : c);
      if (c.key === key) rules.push(cloneNode(c));
    }
    return { ...g, rules };
  };
  return walk(root);
}

export function addNode(root: EditGroup, groupKey: string, node: EditNode): EditGroup {
  if (
    isGroup(node)
      ? !canAddGroup(root, groupKey)
      : isFormula(node)
        ? !canAddFormula(root)
        : !canAddRule(root)
  )
    return root;
  const add = (g: EditGroup): EditGroup =>
    g.key === groupKey
      ? { ...g, rules: [...g.rules, node] }
      : { ...g, rules: g.rules.map((c) => (isGroup<EditGroup>(c) ? add(c) : c)) };
  return add(root);
}

// ------------------------------------------------------------ fields and values

export const fieldIndex = (fields: readonly FieldDef[]): Map<string, FieldDef> =>
  new Map(fields.map((f) => [f.id, f]));

/** Other available fields of the same dimension (valid `{field}` operands). */
export function sameDimension(fields: readonly FieldDef[], def: FieldDef): FieldDef[] {
  return fields.filter((f) => f.available && f.id !== def.id && f.dimension === def.dimension);
}

export const isNumeric = (type: FieldType): boolean =>
  type === 'number' || type === 'percent' || type === 'money' || type === 'int';

/** Ops the UI offers for a field: what the server lists, in the server's order. */
export const opsOf = (def: FieldDef): RuleOp[] => def.ops;

/** Whether the op takes a `{field, pct}` value. */
export const isPctOp = (op: RuleOp): boolean => op === 'abovePct' || op === 'belowPct';

/** Value kind an op needs, which picks the input widget. */
export type ValueKind = 'operand' | 'between' | 'list' | 'pct' | 'bool' | 'enum' | 'text' | 'date';

export function valueKind(def: FieldDef, op: RuleOp): ValueKind {
  if (op === 'between') return 'between';
  if (op === 'in') return 'list';
  if (isPctOp(op)) return 'pct';
  if (def.type === 'bool') return 'bool';
  if (def.type === 'enum') return 'enum';
  if (def.type === 'string') return 'text';
  if (def.type === 'date') return 'date';
  return 'operand';
}

/** Starting value of a rule after choosing `op` on `def` (`null` = still to fill in). */
export function defaultValue(def: FieldDef, op: RuleOp): RuleValue | null {
  const kind = valueKind(def, op);
  if (kind === 'bool') return true;
  if (kind === 'enum' && def.enumValues?.length) return def.enumValues[0]!;
  return null;
}

/** Keep the value across an op change when it still fits, else reset it. */
export function coerceOp(rule: EditRule, def: FieldDef, op: RuleOp): EditRule {
  const was = valueKind(def, rule.op);
  const next = valueKind(def, op);
  const keep =
    was === next &&
    (next === 'operand' ||
      next === 'bool' ||
      next === 'enum' ||
      next === 'text' ||
      next === 'date');
  if (keep && next === 'date' && typeof rule.value === 'number') {
    // The picked day stays, its edge follows the op.
    const day = dateToSeconds(secondsToDate(rule.value), dateEdge(op));
    return { ...rule, op, value: day ?? rule.value };
  }
  return { ...rule, op, value: keep ? rule.value : defaultValue(def, op) };
}

/** A rule for `def` with its first op and an empty value. */
export function newRule(def: FieldDef): EditRule {
  const op = def.ops.includes('>') ? '>' : (def.ops[0] ?? '=');
  return { key: newKey(), field: def.id, op, value: defaultValue(def, op) };
}

/**
 * Switch a rule to another field: keep the op and a numeric literal when the new
 * field supports them (a threshold typed for one numeric field is a good start for
 * another), else reset the value.
 */
export function coerceField(rule: EditRule, from: FieldDef | undefined, def: FieldDef): EditRule {
  const op = def.ops.includes(rule.op) ? rule.op : (def.ops[0] ?? '=');
  const keep =
    op === rule.op &&
    !!from &&
    isNumeric(from.type) &&
    isNumeric(def.type) &&
    from.type === def.type &&
    isFiniteNum(rule.value);
  return { ...rule, field: def.id, op, value: keep ? rule.value : defaultValue(def, op) };
}

/** First sensible field for the "add rule" button (RSI when present). */
export function defaultField(fields: readonly FieldDef[]): FieldDef | null {
  const ok = fields.filter((f) => f.available && f.ops.length > 0);
  return ok.find((f) => f.id === 'rsi14') ?? ok.find((f) => isNumeric(f.type)) ?? ok[0] ?? null;
}

// ------------------------------------------------------------ value text

const SUFFIX: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 };

/**
 * "10B" -> 1e10, "2.5m" -> 2_500_000, "$1,200" -> 1200, "-3" -> -3. `null` for
 * anything that is not a number. `shorthand` enables the K/M/B/T suffixes (money).
 */
export function parseNumberText(text: string, shorthand = false): number | null {
  const s = text.trim().replace(/^\$/, '').replace(/,/g, '').replace(/%$/, '').trim();
  if (!s) return null;
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*([kmbt])?$/i.exec(s);
  if (!m) return null;
  const mult = m[2] ? SUFFIX[m[2].toLowerCase()] : 1;
  if (m[2] && !shorthand) return null;
  const v = Number(m[1]) * (mult ?? 1);
  return Number.isFinite(v) ? v : null;
}

const trimZeros = (n: number, digits: number): string => String(Number(n.toFixed(digits)));

/** 1e10 -> "10B", 1.5e6 -> "1.5M", 950 -> "950". The inverse of `parseNumberText` for money. */
export function formatShort(v: number): string {
  const abs = Math.abs(v);
  for (const [s, mult] of [
    ['T', 1e12],
    ['B', 1e9],
    ['M', 1e6],
    ['K', 1e3],
  ] as const)
    if (abs >= mult) return `${trimZeros(v / mult, 2)}${s}`;
  return trimZeros(v, 4);
}

/** Display text of a numeric literal for a field type (editing and summaries). */
export function formatNumber(type: FieldType, v: number): string {
  if (type === 'money') return formatShort(v);
  return trimZeros(v, 6);
}

/** Which instant of a picked UTC day a date rule compares with. */
export type DateEdge = 'start' | 'end';

/** Last second of a UTC day (the `date` fields are unix seconds). */
const END_OF_DAY_S = 86_399;

/**
 * `YYYY-MM-DD` -> unix seconds, at the start (00:00:00) or the end (23:59:59) of that UTC day
 * (the same UTC days `secondsToDate` shows).
 */
export function dateToSeconds(day: string, edge: DateEdge = 'start'): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const ms = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(ms) ? ms / 1000 + (edge === 'end' ? END_OF_DAY_S : 0) : null;
}

/**
 * The edge of the picked day an op needs so the day itself is on the right side: `<=` and `>`
 * use its end (`<= Nov 10` includes Nov 10, `> Nov 10` excludes it), `<` and `>=` its start,
 * and `between` runs from the start of the first day to the end of the last (`side`).
 */
export function dateEdge(op: RuleOp, side: 'lo' | 'hi' = 'lo'): DateEdge {
  if (op === 'between') return side === 'hi' ? 'end' : 'start';
  return op === '<=' || op === '>' ? 'end' : 'start';
}

export function secondsToDate(sec: number): string {
  return new Date(sec * 1000).toISOString().slice(0, 10);
}

// ------------------------------------------------------------ validation

export type IssueCode =
  | 'unknown_field'
  | 'bad_op'
  | 'field_unavailable'
  | 'bad_value'
  | 'too_complex'
  | 'bad_formula'
  /** A rule still waiting for its value: left out of the scan, not an error. */
  | 'incomplete';

export interface RuleIssue {
  /** Server-style path, e.g. `rules[1].rules[0]`. */
  path: string;
  code: IssueCode;
  /** Draft key of the rule, when validating a draft. */
  key?: string;
  /** Character offset of a formula error (`path` then ends in `.formula`). */
  offset?: number;
}

const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isFieldRef = (v: unknown): v is { field: string } =>
  !!v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  typeof (v as { field?: unknown }).field === 'string';

function operandIssue(v: unknown, def: FieldDef, index: Map<string, FieldDef>): IssueCode | null {
  if (isFiniteNum(v)) return null;
  if (!isFieldRef(v)) return 'bad_value';
  const other = index.get(v.field);
  if (!other) return 'unknown_field';
  if (!other.available) return 'field_unavailable';
  return other.dimension === def.dimension && other.id !== def.id ? null : 'bad_value';
}

/** Why one rule is not sendable (`null` = fine). */
export function ruleIssue(
  rule: { field: string; op: RuleOp; value: RuleValue | null },
  index: Map<string, FieldDef>,
): IssueCode | null {
  const def = index.get(rule.field);
  if (!def) return 'unknown_field';
  if (!def.available) return 'field_unavailable';
  if (!def.ops.includes(rule.op)) return 'bad_op';
  if ((rule.op === 'crossesAbove' || rule.op === 'crossesBelow') && !def.crossable) return 'bad_op';
  if (isEmptyValue(rule.value)) return 'incomplete';
  const v = rule.value;
  switch (rule.op) {
    case 'between':
      return Array.isArray(v) &&
        v.length === 2 &&
        isFiniteNum(v[0]) &&
        isFiniteNum(v[1]) &&
        v[0] <= v[1]
        ? null
        : 'bad_value';
    case 'in': {
      if (!Array.isArray(v) || !v.every((x) => typeof x === 'string' && x !== ''))
        return 'bad_value';
      const allowed = def.enumValues;
      return allowed && (v as string[]).some((x) => !allowed.includes(x)) ? 'bad_value' : null;
    }
    case 'abovePct':
    case 'belowPct': {
      if (!isFieldRef(v) || !('pct' in v) || !isFiniteNum((v as { pct: unknown }).pct))
        return 'bad_value';
      return operandIssue({ field: v.field }, def, index);
    }
    default:
      break;
  }
  if (def.type === 'bool') return typeof v === 'boolean' && rule.op === '=' ? null : 'bad_value';
  if (def.type === 'enum' || def.type === 'string') {
    if (rule.op !== '=') return 'bad_op';
    if (typeof v !== 'string') return 'bad_value';
    return def.enumValues && !def.enumValues.includes(v) ? 'bad_value' : null;
  }
  return operandIssue(v, def, index);
}

/** Why a formula rule is not sendable (`null` = fine); formula errors carry their offset. */
export function formulaIssue(
  rule: { formula: string; op: string; value: unknown },
  fields: readonly FieldDef[] | Map<string, FieldDef>,
): { code: IssueCode; offset?: number } | null {
  if (rule.formula.trim() === '') return { code: 'incomplete' };
  const parsed = parseFormula(rule.formula, fields);
  if (!parsed.ok) return { code: parsed.error.code, offset: parsed.error.offset };
  if (!(FORMULA_OPS as readonly string[]).includes(rule.op)) return { code: 'bad_op' };
  const v = rule.value;
  if (v === null || v === undefined) return { code: 'incomplete' };
  if (rule.op === 'between')
    return Array.isArray(v) &&
      v.length === 2 &&
      isFiniteNum(v[0]) &&
      isFiniteNum(v[1]) &&
      v[0] <= v[1]
      ? null
      : { code: 'bad_value' };
  return isFiniteNum(v) ? null : { code: 'bad_value' };
}

/**
 * Every problem of a draft or contract tree: bad rules (blocking) and rules
 * still missing a value (`incomplete`, ignored by the scan), plus tree limits.
 */
export function validate(
  root: { op: 'and' | 'or'; rules: unknown[] },
  fields: readonly FieldDef[],
): RuleIssue[] {
  const index = fieldIndex(fields);
  const issues: RuleIssue[] = [];
  let formulas = 0;
  const walk = (g: { rules: unknown[] }, path: string, depth: number) => {
    (g.rules as (EditNode | Rule | FormulaRule | Group)[]).forEach((n, i) => {
      const p = path ? `${path}.rules[${i}]` : `rules[${i}]`;
      const key = (n as { key?: string }).key;
      if (isGroup<Group>(n)) {
        if (depth >= MAX_DEPTH)
          issues.push({ path: p, code: 'too_complex', ...(key ? { key } : {}) });
        else walk(n, p, depth + 1);
        return;
      }
      if (isFormula<EditFormula | FormulaRule>(n)) {
        formulas++;
        const hit = formulaIssue(n, index);
        if (hit)
          issues.push({
            path: hit.offset !== undefined ? `${p}.formula` : p,
            code: hit.code,
            ...(key ? { key } : {}),
            ...(hit.offset !== undefined ? { offset: hit.offset } : {}),
          });
        else if (formulas > MAX_FORMULA_RULES)
          issues.push({ path: p, code: 'too_complex', ...(key ? { key } : {}) });
        return;
      }
      const code = ruleIssue(n as { field: string; op: RuleOp; value: RuleValue | null }, index);
      if (code) issues.push({ path: p, code, ...(key ? { key } : {}) });
    });
  };
  walk(root, '', 1);
  if (
    countRules(root as { rules: unknown[] }) > MAX_RULES ||
    countGroups(root as { rules: unknown[] }) > MAX_GROUPS
  )
    issues.push({ path: '', code: 'too_complex' });
  return issues;
}

export interface BuiltRequest {
  /** The complete rules as a contract group (`null` = no filter). */
  filter: Group | null;
  issues: RuleIssue[];
  /** Some rule is wrong (not merely incomplete): do not scan. */
  blocking: boolean;
}

/** Draft -> `ScanRequest.filter` plus its issues. */
export function toRequest(draft: EditGroup, fields: readonly FieldDef[]): BuiltRequest {
  const issues = validate(draft, fields);
  return {
    filter: serializeGroup(draft),
    issues,
    blocking: issues.some((i) => i.code !== 'incomplete'),
  };
}

// ------------------------------------------------------------ summary

/** i18n label of a field id (`scr.f.<id>`), the id itself when the catalog lacks it. */
export function fieldLabel(id: string): string {
  const key = `scr.f.${id}`;
  return Object.hasOwn(en, key) ? translate(key as MessageKey) : id;
}

export interface SummaryLabels {
  field: (id: string) => string;
  op: (op: RuleOp) => string;
  /** "{a} is {pct}% above {b}" */
  pct: (op: 'abovePct' | 'belowPct', a: string, pct: string, b: string) => string;
  yes: string;
  no: string;
  and: string;
  or: string;
}

const OP_KEYS: Record<RuleOp, MessageKey> = {
  '>': 'scr.op.gt',
  '<': 'scr.op.lt',
  '>=': 'scr.op.gte',
  '<=': 'scr.op.lte',
  '=': 'scr.op.eq',
  between: 'scr.op.between',
  in: 'scr.op.in',
  crossesAbove: 'scr.op.crossesAbove',
  crossesBelow: 'scr.op.crossesBelow',
  abovePct: 'scr.op.abovePct',
  belowPct: 'scr.op.belowPct',
};

export const opLabel = (op: RuleOp): string => translate(OP_KEYS[op]);

export const DEFAULT_LABELS: SummaryLabels = {
  field: fieldLabel,
  op: opLabel,
  pct: (op, a, pct, b) =>
    translate(op === 'abovePct' ? 'scr.sum.abovePct' : 'scr.sum.belowPct', { a, pct, b }),
  yes: 'yes',
  no: 'no',
  and: 'AND',
  or: 'OR',
};

function valueText(
  def: FieldDef | undefined,
  rule: { op: RuleOp; value: RuleValue },
  labels: SummaryLabels,
): string {
  const type = def?.type ?? 'number';
  const lit = (n: number): string => {
    const s = formatNumber(type, n);
    return type === 'money' ? `$${s}` : type === 'percent' ? `${s}%` : s;
  };
  const v = rule.value;
  if (typeof v === 'boolean') return v ? labels.yes : labels.no;
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return lit(v);
  if (Array.isArray(v))
    return rule.op === 'between'
      ? `${lit(v[0] as number)} – ${lit(v[1] as number)}`
      : (v as string[]).join(', ');
  if ('pct' in v) return `${trimZeros(v.pct, 4)}% ${labels.field(v.field)}`;
  return labels.field(v.field);
}

/** "RSI(14) < 30 AND Mkt cap > $10B". Nested groups are parenthesized. */
export function summarize(
  group: Group | null,
  fields: readonly FieldDef[] = [],
  labels: SummaryLabels = DEFAULT_LABELS,
): string {
  if (!group) return '';
  const index = fieldIndex(fields);
  const formula = (r: FormulaRule): string => {
    const lit = (n: number): string => trimZeros(n, 6);
    const v = r.value;
    const value = Array.isArray(v) ? `${lit(v[0])} – ${lit(v[1])}` : lit(v);
    return `{${r.formula.trim()}} ${labels.op(r.op)} ${value}`;
  };
  const rule = (r: Rule): string => {
    const def = index.get(r.field);
    const head = labels.field(r.field);
    if (
      (r.op === 'abovePct' || r.op === 'belowPct') &&
      typeof r.value === 'object' &&
      !Array.isArray(r.value) &&
      'pct' in r.value
    )
      return labels.pct(r.op, head, trimZeros(r.value.pct, 4), labels.field(r.value.field));
    return `${head} ${labels.op(r.op)} ${valueText(def, r, labels)}`;
  };
  const walk = (g: Group, nested: boolean): string => {
    const parts = g.rules.map((n) =>
      isGroup<Group>(n) ? walk(n, true) : isFormula<FormulaRule>(n) ? formula(n) : rule(n),
    );
    const joined = parts.join(` ${g.op === 'and' ? labels.and : labels.or} `);
    return nested && parts.length > 1 ? `(${joined})` : joined;
  };
  return walk(group, false);
}
