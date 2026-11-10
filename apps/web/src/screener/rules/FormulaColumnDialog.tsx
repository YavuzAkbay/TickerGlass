import { useState } from 'react';
import { useT } from '../../i18n';
import { Modal } from '../../ui/Modal';
import type { FieldDef } from '../server/types';
import { FormulaInput } from './FormulaInput';
import { parseFormula } from './formula';
import './rules.css';

interface Props {
  fields: readonly FieldDef[];
  /** Formulas already shown as columns (a duplicate is refused). */
  existing: readonly string[];
  onAdd: (formula: string, label: string) => void;
  onClose: () => void;
}

/** Name and formula of a new results-table column (`"=<formula>"` in the scan's `fields`). */
export function FormulaColumnDialog({ fields, existing, onAdd, onClose }: Props) {
  const t = useT();
  const [formula, setFormula] = useState('');
  const [label, setLabel] = useState('');
  const text = formula.trim();
  const valid = text !== '' && parseFormula(text, fields).ok;
  const duplicate = existing.includes(text);
  const ok = valid && !duplicate;
  const submit = () => {
    if (!ok) return;
    onAdd(text, label.trim());
    onClose();
  };
  return (
    <Modal
      title={t('scr.fx.colTitle')}
      onClose={onClose}
      width={460}
      className="io-prompt"
      footer={
        <>
          <div className="io-spacer" />
          <button type="button" className="io-btn" onClick={onClose}>
            {t('scr.fx.cancel')}
          </button>
          <button
            type="button"
            className="io-btn io-btn-primary"
            disabled={!ok}
            data-testid="fx-col-add"
            onClick={submit}
          >
            {t('scr.fx.colAdd')}
          </button>
        </>
      }
    >
      <div
        className="rb-fx-dialog"
        onKeyDown={(e) => {
          // Enter submits unless the suggestion list consumed it.
          if (e.key === 'Enter' && !e.defaultPrevented) {
            e.preventDefault();
            submit();
          }
        }}
      >
        <label className="rb-fx-field">
          <span>{t('scr.fx.colName')}</span>
          <input
            className="io-input"
            data-testid="fx-col-name"
            autoFocus
            maxLength={60}
            placeholder={t('scr.fx.colNameHint')}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </label>
        <div className="rb-fx-field">
          <span>{t('scr.fx.label')}</span>
          <FormulaInput value={formula} onChange={setFormula} fields={fields} />
        </div>
        {duplicate ? <div className="rb-issue">{t('scr.fx.colDuplicate')}</div> : null}
      </div>
    </Modal>
  );
}
