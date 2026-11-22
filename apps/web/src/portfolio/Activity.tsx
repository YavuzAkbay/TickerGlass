import { Plus, Upload } from 'lucide-react';
import { useMemo, useState } from 'react';
import { errorMessage } from '../api/client';
import type { Portfolio, Transaction } from '../api/portfolio';
import { confirmDialog } from '../ui/Prompt';
import { toast } from '../ui/Toast';
import { fmtDateTime, fmtMoney, fmtQty } from './fmt';
import { ImportDialog } from './ImportDialog';
import { tradePrefill } from './logTrade';
import { filterActivity, importBatches, newestFirst } from './model';
import { undoImportBatch, usePortfolio } from './store';
import { TxFormDialog } from './TxFormDialog';
import { emptyForm, formFromTransaction, KIND_LABEL, TX_KINDS, type TxFormState } from './txForm';

const PAGE = 200;

interface Composer {
  editing: Transaction | null;
  form: TxFormState;
}

/** One-line description of a row's economics. */
function describe(t: Transaction): string {
  switch (t.kind) {
    case 'buy':
    case 'sell':
      return `${fmtQty(t.quantity)} @ ${fmtMoney(t.price, t.currency)}`;
    case 'split':
      return `${fmtQty(t.quantity)}-for-1`;
    default:
      return fmtMoney(t.amount, t.currency);
  }
}

interface Props {
  portfolio: Portfolio;
  transactions: readonly Transaction[];
}

export function Activity({ portfolio, transactions }: Props) {
  const [local, setComposer] = useState<Composer | null>(null);
  const [importing, setImporting] = useState(false);
  const [symbol, setSymbol] = useState('');
  const [kind, setKind] = useState('');
  const [shown, setShown] = useState(PAGE);
  const pending = usePortfolio((s) => s.pendingTrade);

  // "Log trade for current symbol" opens the add form prefilled; it wins over a form already open.
  const fromPending = useMemo<Composer | null>(() => {
    if (!pending) return null;
    const p = tradePrefill(
      pending.symbol,
      pending.symbolCurrency,
      pending.last,
      portfolio.baseCurrency,
    );
    return {
      editing: null,
      form: emptyForm('buy', { currency: p.currency, symbol: p.symbol, price: p.price }),
    };
  }, [pending, portfolio.baseCurrency]);
  const composer = fromPending ?? local;
  const closeComposer = () => {
    setComposer(null);
    if (pending) usePortfolio.getState().set({ pendingTrade: null });
  };

  const rows = useMemo(
    () => filterActivity(newestFirst(transactions), { symbol, kind }),
    [transactions, symbol, kind],
  );
  const batches = useMemo(() => importBatches(transactions), [transactions]);

  const add = () => {
    setComposer({ editing: null, form: emptyForm('buy', { currency: portfolio.baseCurrency }) });
  };

  const undo = async (batch: string, count: number) => {
    const ok = await confirmDialog({
      title: 'Undo import',
      message: `Remove the ${count} transaction${count === 1 ? '' : 's'} added by this import?`,
      okLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    try {
      const n = await undoImportBatch(portfolio.id, batch);
      toast(`Removed ${n} transaction${n === 1 ? '' : 's'}`, 'success');
    } catch (e) {
      toast(`Undo failed: ${errorMessage(e)}`, 'error');
    }
  };

  return (
    <div>
      <div className="pf-toolbar">
        <button type="button" className="io-btn io-btn-primary pf-btn" onClick={add}>
          <Plus size={14} /> Add
        </button>
        <button type="button" className="io-btn pf-btn" onClick={() => setImporting(true)}>
          <Upload size={14} /> Import CSV
        </button>
      </div>
      <div className="pf-toolbar">
        <input
          className="io-input"
          aria-label="Filter by symbol"
          placeholder="Symbol"
          value={symbol}
          onChange={(e) => {
            setSymbol(e.target.value);
            setShown(PAGE);
          }}
        />
        <select
          className="io-input pf-sel"
          aria-label="Filter by type"
          value={kind}
          onChange={(e) => {
            setKind(e.target.value);
            setShown(PAGE);
          }}
        >
          <option value="">All types</option>
          {TX_KINDS.map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k]}
            </option>
          ))}
        </select>
      </div>

      {batches.length ? (
        <div className="pf-batches">
          <div className="pf-section" style={{ margin: '10px 0 2px' }}>
            Imports
          </div>
          {batches.slice(0, 5).map((b) => (
            <div key={b.batch} className="pf-batch">
              <span className="pf-muted">
                {b.source.replace('import:', '')} · {b.count} rows · {fmtDateTime(b.createdAt)}
              </span>
              <button
                type="button"
                className="io-btn pf-btn"
                onClick={() => void undo(b.batch, b.count)}
              >
                Undo
              </button>
            </div>
          ))}
        </div>
      ) : null}

      <div className="pf-section">Transactions ({rows.length})</div>
      {rows.length === 0 ? (
        <p className="pf-muted pf-pad">
          {transactions.length === 0
            ? 'Nothing here yet. Add a transaction or import a broker CSV.'
            : 'No transactions match the filter.'}
        </p>
      ) : (
        <ul className="pf-rows" aria-label="Transactions">
          {rows.slice(0, shown).map((t) => (
            <li key={t.id}>
              <button
                type="button"
                className="pf-row"
                title="Edit"
                onClick={() => setComposer({ editing: t, form: formFromTransaction(t) })}
              >
                <span className="pf-row-sym">
                  <span className={`pf-kind ${t.kind}`}>{KIND_LABEL[t.kind]}</span> {t.symbol ?? ''}
                </span>
                <span className="pf-row-r">{describe(t)}</span>
                <span className={`pf-row-sub${t.source === 'manual' ? ' pf-row-wide' : ''}`}>
                  {fmtDateTime(t.time)}
                  {t.fee > 0 ? ` · fee ${fmtMoney(t.fee, t.currency)}` : ''}
                </span>
                {t.source !== 'manual' ? (
                  <span className="pf-row-sub pf-row-r">{t.source.replace('import:', '')}</span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      )}
      {rows.length > shown ? (
        <div className="pf-pad">
          <button type="button" className="io-btn pf-btn" onClick={() => setShown(shown + PAGE)}>
            Show more ({rows.length - shown} left)
          </button>
        </div>
      ) : null}

      {composer ? (
        <TxFormDialog
          key={`${composer.editing?.id ?? 'new'}|${composer.form.symbol}|${composer.form.time}`}
          portfolio={portfolio}
          editing={composer.editing}
          initial={composer.form}
          onClose={closeComposer}
        />
      ) : null}
      {importing ? (
        <ImportDialog portfolio={portfolio} onClose={() => setImporting(false)} />
      ) : null}
    </div>
  );
}
