import { Copy, Plus, Sigma, Trash2 } from 'lucide-react';
import { useT, type MessageKey } from '../../i18n';
import type { FieldDef, RuleOp } from '../server/types';
import { FieldPicker } from './FieldPicker';
import { FormulaInput } from './FormulaInput';
import { FORMULA_OPS, MAX_FORMULA_RULES, type FormulaOp } from './formula';
import { ValueInput } from './ValueInput';
import {
  addNode,
  canAddFormula,
  canAddGroup,
  canAddRule,
  coerceFormulaOp,
  countFormulas,
  coerceField,
  coerceOp,
  defaultField,
  duplicateNode,
  emptyGroup,
  fieldIndex,
  isFormula,
  isGroup,
  MAX_RULES,
  newFormula,
  newRule,
  opLabel,
  removeNode,
  setGroupOp,
  updateFormula,
  updateRule,
  countRules,
  type EditFormula,
  type EditGroup,
  type EditRule,
  type RuleIssue,
} from './rules';
import './rules.css';

interface Props {
  draft: EditGroup;
  onChange: (next: EditGroup) => void;
  fields: readonly FieldDef[];
  issues: readonly RuleIssue[];
}

/** The value widget of a formula rule is a plain number (or range) box. */
const FORMULA_DEF: FieldDef = {
  id: '=formula',
  category: 'technical',
  type: 'number',
  unit: null,
  dimension: '=formula',
  ops: [...FORMULA_OPS],
  crossable: false,
  available: true,
  enumValues: null,
};

/**
 * Editor of the screen's filter: AND/OR groups (one nested level), rules of
 * field / operator / value and formula rules (expression / operator / value). Pure view
 * of `draft`; every edit hands the next draft up.
 */
export function RuleBuilder({ draft, onChange, fields, issues }: Props) {
  const t = useT();
  const index = fieldIndex(fields);
  const hidden = fields.filter((f) => !f.available);
  const total = countRules(draft);
  const add = (groupKey: string) => {
    const def = defaultField(fields);
    if (def) onChange(addNode(draft, groupKey, newRule(def)));
  };
  return (
    <section className="rb" aria-label={t('scr.rb.title')} data-testid="scr-rb">
      <GroupView
        group={draft}
        root={draft}
        top
        index={index}
        fields={fields}
        issues={issues}
        onChange={onChange}
        onAdd={add}
      />
      <div className="rb-foot">
        <span className="rb-count rs-num" data-testid="rb-count">
          {t('scr.rb.count').replace('{n}', String(total)).replace('{max}', String(MAX_RULES))}
        </span>
        {hidden.length ? (
          <span
            className="rb-hidden"
            title={`${t('scr.rb.unavailableFields')}: ${hidden.map((f) => f.id).join(', ')}`}
            data-testid="rb-hidden"
          >
            {t('scr.rb.hiddenN').replace('{n}', String(hidden.length))}
          </span>
        ) : null}
      </div>
    </section>
  );
}

function GroupView({
  group,
  root,
  top,
  index,
  fields,
  issues,
  onChange,
  onAdd,
}: {
  group: EditGroup;
  root: EditGroup;
  top?: boolean;
  index: Map<string, FieldDef>;
  fields: readonly FieldDef[];
  issues: readonly RuleIssue[];
  onChange: (next: EditGroup) => void;
  onAdd: (groupKey: string) => void;
}) {
  const t = useT();
  return (
    <div
      className={`rb-group${top ? ' top' : ''}`}
      role="group"
      aria-label={t('scr.rb.group')}
      data-testid={top ? 'rb-root' : 'rb-nested'}
    >
      <div className="rb-group-head">
        <div className="rb-seg" role="radiogroup" aria-label={t('scr.rb.combine')}>
          {(['and', 'or'] as const).map((op) => (
            <button
              key={op}
              type="button"
              role="radio"
              aria-checked={group.op === op}
              className={`rb-seg-btn${group.op === op ? ' on' : ''}`}
              data-testid={`rb-op-${op}`}
              onClick={() => onChange(setGroupOp(root, group.key, op))}
            >
              {op === 'and' ? t('scr.rb.matchAll') : t('scr.rb.matchAny')}
            </button>
          ))}
        </div>
        <span className="rb-spacer" />
        <button
          type="button"
          className="rb-add"
          data-testid="rb-add-rule"
          disabled={!canAddRule(root) || !defaultField(fields)}
          onClick={() => onAdd(group.key)}
        >
          <Plus size={12} aria-hidden="true" />
          {t('scr.rb.addRule')}
        </button>
        <button
          type="button"
          className="rb-add"
          data-testid="rb-add-formula"
          title={
            canAddFormula(root)
              ? t('scr.rb.addFormulaTitle')
              : t('scr.rb.formulaLimit', { n: MAX_FORMULA_RULES })
          }
          disabled={!canAddFormula(root)}
          onClick={() => onChange(addNode(root, group.key, newFormula()))}
        >
          <Sigma size={12} aria-hidden="true" />
          {t('scr.rb.addFormula')}
        </button>
        {canAddGroup(root, group.key) ? (
          <button
            type="button"
            className="rb-add"
            data-testid="rb-add-group"
            onClick={() =>
              onChange(addNode(root, group.key, emptyGroup(group.op === 'and' ? 'or' : 'and')))
            }
          >
            <Plus size={12} aria-hidden="true" />
            {t('scr.rb.addGroup')}
          </button>
        ) : null}
        {!top ? (
          <button
            type="button"
            className="rb-icon-btn"
            aria-label={t('scr.rb.removeGroup')}
            title={t('scr.rb.removeGroup')}
            onClick={() => onChange(removeNode(root, group.key))}
          >
            <Trash2 size={13} aria-hidden="true" />
          </button>
        ) : null}
      </div>
      {group.rules.length === 0 ? <div className="rb-empty">{t('scr.rb.empty')}</div> : null}
      <ul className="rb-list">
        {group.rules.map((n) => (
          <li key={n.key}>
            {isGroup<EditGroup>(n) ? (
              <GroupView
                group={n}
                root={root}
                index={index}
                fields={fields}
                issues={issues}
                onChange={onChange}
                onAdd={onAdd}
              />
            ) : isFormula<EditFormula>(n) ? (
              <FormulaRow
                rule={n}
                root={root}
                fields={fields}
                issue={issues.find((i) => i.key === n.key)}
                onChange={onChange}
              />
            ) : (
              <RuleRow
                rule={n}
                root={root}
                index={index}
                fields={fields}
                issue={issues.find((i) => i.key === n.key)}
                onChange={onChange}
              />
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

const ISSUE_KEYS: Record<RuleIssue['code'], MessageKey> = {
  unknown_field: 'scr.err.unknown_field',
  bad_op: 'scr.err.bad_op',
  field_unavailable: 'scr.err.field_unavailable',
  bad_value: 'scr.err.bad_value',
  too_complex: 'scr.err.too_complex',
  bad_formula: 'scr.err.bad_formula',
  incomplete: 'scr.err.incomplete',
};

/** A formula rule: expression, comparison, number or range. */
function FormulaRow({
  rule,
  root,
  fields,
  issue,
  onChange,
}: {
  rule: EditFormula;
  root: EditGroup;
  fields: readonly FieldDef[];
  issue: RuleIssue | undefined;
  onChange: (next: EditGroup) => void;
}) {
  const t = useT();
  const hard = !!issue && issue.code !== 'incomplete';
  // Parse errors are explained (with a caret) by the formula box itself.
  const inFormula = issue?.offset !== undefined;
  const dupBlocked = countRules(root) >= MAX_RULES || countFormulas(root) >= MAX_FORMULA_RULES;
  return (
    <div className={`rb-rule rb-formula${hard ? ' bad' : ''}`} data-testid="rb-rule">
      <FormulaInput
        value={rule.formula}
        fields={fields}
        onChange={(formula) => onChange(updateFormula(root, rule.key, { formula }))}
      />
      <select
        className={`io-input rb-select rb-opsel${hard && issue?.code === 'bad_op' ? ' invalid' : ''}`}
        aria-label={t('scr.rb.operator')}
        data-testid="rb-op"
        value={rule.op}
        onChange={(e) =>
          onChange(
            updateFormula(root, rule.key, coerceFormulaOp(rule, e.target.value as FormulaOp)),
          )
        }
      >
        {FORMULA_OPS.map((op) => (
          <option key={op} value={op}>
            {opLabel(op)}
          </option>
        ))}
      </select>
      <ValueInput
        key={rule.op === 'between' ? 'range' : 'number'}
        def={FORMULA_DEF}
        op={rule.op}
        value={rule.value}
        fields={[]}
        invalid={hard && issue?.code === 'bad_value'}
        onChange={(value) =>
          onChange(
            updateFormula(root, rule.key, {
              value: value as EditFormula['value'],
            }),
          )
        }
      />
      <span className="rb-spacer" />
      <button
        type="button"
        className="rb-icon-btn"
        aria-label={t('scr.rb.duplicate')}
        title={t('scr.rb.duplicate')}
        data-testid="rb-dup"
        disabled={dupBlocked}
        onClick={() => onChange(duplicateNode(root, rule.key))}
      >
        <Copy size={13} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="rb-icon-btn"
        aria-label={t('scr.rb.remove')}
        title={t('scr.rb.remove')}
        data-testid="rb-remove"
        onClick={() => onChange(removeNode(root, rule.key))}
      >
        <Trash2 size={13} aria-hidden="true" />
      </button>
      {issue && !inFormula ? (
        <div className={`rb-issue${hard ? '' : ' soft'}`} role={hard ? 'alert' : undefined}>
          {t(
            issue.code === 'incomplete' && rule.formula.trim() === ''
              ? 'scr.fx.e.empty'
              : ISSUE_KEYS[issue.code],
          )}
        </div>
      ) : null}
    </div>
  );
}

function RuleRow({
  rule,
  root,
  index,
  fields,
  issue,
  onChange,
}: {
  rule: EditRule;
  root: EditGroup;
  index: Map<string, FieldDef>;
  fields: readonly FieldDef[];
  issue: RuleIssue | undefined;
  onChange: (next: EditGroup) => void;
}) {
  const t = useT();
  const def = index.get(rule.field);
  const hard = !!issue && issue.code !== 'incomplete';
  const ops: RuleOp[] = def ? def.ops : [rule.op];
  return (
    <div className={`rb-rule${hard ? ' bad' : ''}`} data-testid="rb-rule">
      <FieldPicker
        fields={fields}
        value={rule.field}
        invalid={hard && (issue?.code === 'unknown_field' || issue?.code === 'field_unavailable')}
        onChange={(id) => {
          const next = index.get(id);
          if (next) onChange(updateRule(root, rule.key, coerceField(rule, def, next)));
        }}
      />
      <select
        className={`io-input rb-select rb-opsel${hard && issue?.code === 'bad_op' ? ' invalid' : ''}`}
        aria-label={t('scr.rb.operator')}
        data-testid="rb-op"
        value={rule.op}
        disabled={!def}
        onChange={(e) => {
          if (def)
            onChange(updateRule(root, rule.key, coerceOp(rule, def, e.target.value as RuleOp)));
        }}
      >
        {ops.map((op) => (
          <option key={op} value={op}>
            {opLabel(op)}
          </option>
        ))}
      </select>
      {def ? (
        <ValueInput
          key={`${rule.field}|${rule.op}`}
          def={def}
          op={rule.op}
          value={rule.value}
          fields={fields}
          invalid={hard && issue?.code === 'bad_value'}
          onChange={(value) => onChange(updateRule(root, rule.key, { value }))}
        />
      ) : (
        <span className="rb-unknown">{rule.field}</span>
      )}
      <span className="rb-spacer" />
      <button
        type="button"
        className="rb-icon-btn"
        aria-label={t('scr.rb.duplicate')}
        title={t('scr.rb.duplicate')}
        data-testid="rb-dup"
        disabled={countRules(root) >= MAX_RULES}
        onClick={() => onChange(duplicateNode(root, rule.key))}
      >
        <Copy size={13} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="rb-icon-btn"
        aria-label={t('scr.rb.remove')}
        title={t('scr.rb.remove')}
        data-testid="rb-remove"
        onClick={() => onChange(removeNode(root, rule.key))}
      >
        <Trash2 size={13} aria-hidden="true" />
      </button>
      {issue ? (
        <div className={`rb-issue${hard ? '' : ' soft'}`} role={hard ? 'alert' : undefined}>
          {t(ISSUE_KEYS[issue.code])}
        </div>
      ) : null}
    </div>
  );
}
