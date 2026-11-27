import { useState } from 'react';
import { errorMessage } from '../api/client';
import { transactionConflict, type Portfolio, type Transaction } from '../api/portfolio';
import { Modal } from '../ui/Modal';
import { confirmDialog } from '../ui/Prompt';
import { toast } from '../ui/Toast';
import { addTransaction, reloadTransactions, removeTransaction, saveTransaction } from './store';
import {
  KIND_LABEL,
  KIND_RULES,
  TX_KINDS,
  validateTxForm,
  withKind,
  type TxFormErrors,
  type TxFormField,
  type TxFormState,
} from './txForm';

interface Props {
  portfolio: Portfolio;
  /** Row being edited; null adds a new one. */
  editing: Transaction | null;
  initial: TxFormState;
  onClose: () => void;
}

export function TxFormDialog({ portfolio, editing, initial, onClose }: Props) {
  const [form, setForm] = useState(initial);
  const [errors, setErrors] = useState<TxFormErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const rules = KIND_RULES[form.kind];

  const set = (field: TxFormField, value: string) => {
    setForm((f) => ({ ...f, [field]: value }));
    setErrors((e) => (e[field] ? { ...e, [field]: undefined } : e));
  };

  const submit = async () => {
    if (busy) return;
    const res = validateTxForm(form, editing);
    if (!res.ok) {
      setErrors(res.errors);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (editing) await saveTransaction(editing, res.tx);
      else await addTransaction(portfolio.id, res.tx);
      onClose();
    } catch (e) {
      if (editing && transactionConflict(e)) {
        toast('This transaction was changed elsewhere; reloaded.', 'error');
        void reloadTransactions(portfolio.id);
        onClose();
        return;
      }
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!editing || busy) return;
    const ok = await confirmDialog({
      title: 'Delete transaction',
      message: 'Delete this transaction? Journal entries linked to it are kept, unlinked.',
      okLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await removeTransaction(editing.id);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  const input = (field: TxFormField, label: string, props: Record<string, unknown> = {}) => (
    <label className="pf-field">
      <span>{label}</span>
      <input
        className="io-input"
        value={form[field]}
        aria-invalid={!!errors[field]}
        onChange={(e) => set(field, e.target.value)}
        {...props}
      />
      {errors[field] ? <span className="pf-field-err">{errors[field]}</span> : null}
    </label>
  );

  return (
    <Modal
      title={editing ? 'Edit transaction' : 'Add transaction'}
      className="pf-dlg"
      onClose={onClose}
      width={460}
      footer={
        <>
          {editing ? (
            <button type="button" className="io-btn" disabled={busy} onClick={() => void remove()}>
              Delete
            </button>
          ) : null}
          <div className="io-spacer" />
          <button type="button" className="io-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="io-btn io-btn-primary"
            disabled={busy}
            onClick={() => void submit()}
          >
            {editing ? 'Save' : 'Add'}
          </button>
        </>
      }
    >
      <form
        className="pf-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className="pf-field">
          <span>Type</span>
          <select
            className="io-input"
            value={form.kind}
            onChange={(e) => setForm((f) => withKind(f, e.target.value as Transaction['kind']))}
          >
            {TX_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </label>
        {input('time', 'Date and time', { type: 'datetime-local' })}
        {rules.symbol !== 'none'
          ? input('symbol', rules.symbol === 'opt' ? 'Symbol (optional)' : 'Symbol', {
              autoFocus: !editing,
              autoCapitalize: 'characters',
            })
          : null}
        {input('currency', 'Currency', { maxLength: 3 })}
        {rules.quantity !== 'none'
          ? input('quantity', rules.quantityLabel, { inputMode: 'decimal' })
          : null}
        {rules.price !== 'none'
          ? input('price', 'Price per share', { inputMode: 'decimal' })
          : null}
        {rules.amount !== 'none'
          ? input('amount', rules.amountLabel, { inputMode: 'decimal' })
          : null}
        {rules.fee ? input('fee', `${rules.feeLabel} (optional)`, { inputMode: 'decimal' }) : null}
        <label className="pf-field wide">
          <span>Note (optional)</span>
          <textarea
            className="io-input"
            maxLength={2000}
            value={form.note}
            onChange={(e) => set('note', e.target.value)}
          />
        </label>
        {error ? (
          <p className="pf-dlg-err" role="alert">
            {error}
          </p>
        ) : null}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
