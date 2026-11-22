import type { BrokerId } from '@tickerglass/portfolio';
import { useEffect, useMemo, useRef, useState } from 'react';
import { errorMessage } from '../api/client';
import {
  importErrors,
  importTransactions,
  type ImportResult,
  type ImportRowError,
} from '../api/portfolio';
import type { Portfolio } from '../api/portfolio';
import { Modal } from '../ui/Modal';
import { fmtPrice } from '../sidebar/format';
import { fmtDateTime, fmtQty } from './fmt';
import {
  BROKER_LABEL,
  countKinds,
  DEFAULT_OVERRIDES,
  detect,
  MAX_IMPORT_BYTES,
  MAX_IMPORT_ROWS,
  parseImport,
  type DateOrder,
  type DecimalSep,
  type ParseOverrides,
} from './importParse';
import { importRows } from './store';
import { KIND_LABEL } from './txForm';

const PREVIEW_ROWS = 30;
const BROKERS = Object.keys(BROKER_LABEL) as BrokerId[];

type Check =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'ok'; created: number; skipped: number }
  | { state: 'error'; message: string; rows: ImportRowError[] };

export function ImportDialog({
  portfolio,
  onClose,
}: {
  portfolio: Portfolio;
  onClose: () => void;
}) {
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [over, setOver] = useState<ParseOverrides>(DEFAULT_OVERRIDES);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<ImportResult | null>(null);
  const [failure, setFailure] = useState<{ message: string; rows: ImportRowError[] } | null>(null);
  const picker = useRef<HTMLInputElement>(null);

  const detected = useMemo(() => (file ? detect(file.text) : null), [file]);
  const preview = useMemo(() => (file ? parseImport(file.text, over) : null), [file, over]);
  const rows = preview?.transactions ?? [];
  const tooMany = rows.length > MAX_IMPORT_ROWS;
  const source = preview ? `import:${preview.broker}` : '';

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    setReadError(null);
    setDone(null);
    setFailure(null);
    setOver(DEFAULT_OVERRIDES);
    if (f.size > MAX_IMPORT_BYTES) {
      setFile(null);
      setReadError('That file is larger than 20 MB.');
      return;
    }
    try {
      setFile({ name: f.name, text: await f.text() });
    } catch (e) {
      setFile(null);
      setReadError(`Could not read the file: ${errorMessage(e)}`);
    }
  };

  // Dry run whenever the parsed rows change: shows what would be created or skipped, and any
  // row the server rejects, before anything is written. The outcome is tagged with the preview it
  // answers; any other preview means "still checking".
  const runnable = !!preview && rows.length > 0 && !tooMany;
  const [outcome, setOutcome] = useState<{ preview: unknown; check: Check } | null>(null);
  const check: Check = !runnable
    ? { state: 'idle' }
    : outcome?.preview === preview
      ? outcome.check
      : { state: 'checking' };
  useEffect(() => {
    if (!preview || !runnable) return;
    const ac = new AbortController();
    importTransactions(
      portfolio.id,
      { transactions: preview.transactions, dryRun: true, source: `import:${preview.broker}` },
      { signal: ac.signal },
    )
      .then((r) =>
        setOutcome({ preview, check: { state: 'ok', created: r.created, skipped: r.skipped } }),
      )
      .catch((e: unknown) => {
        if (ac.signal.aborted) return;
        setOutcome({
          preview,
          check: { state: 'error', message: errorMessage(e), rows: importErrors(e) ?? [] },
        });
      });
    return () => ac.abort();
  }, [preview, runnable, portfolio.id]);

  const run = async () => {
    if (!preview || busy || check.state !== 'ok') return;
    setBusy(true);
    setFailure(null);
    try {
      setDone(await importRows(portfolio.id, rows, source));
    } catch (e) {
      setFailure({ message: errorMessage(e), rows: importErrors(e) ?? [] });
    } finally {
      setBusy(false);
    }
  };

  const kinds = countKinds(rows);
  const setBroker = (v: string) =>
    setOver((o) => ({ ...o, broker: v as ParseOverrides['broker'] }));
  const errorList = (list: ImportRowError[]) =>
    list.length ? (
      <ul className="pf-muted">
        {list.slice(0, 20).map((e) => (
          <li key={e.index}>
            Row {e.index + 1}: {e.message}
          </li>
        ))}
        {list.length > 20 ? <li>and {list.length - 20} more</li> : null}
      </ul>
    ) : null;

  return (
    <Modal
      title="Import broker CSV"
      className="pf-dlg"
      onClose={onClose}
      width={680}
      footer={
        done ? (
          <>
            <div className="io-spacer" />
            <button type="button" className="io-btn io-btn-primary" onClick={onClose}>
              Done
            </button>
          </>
        ) : (
          <>
            <div className="io-spacer" />
            <button type="button" className="io-btn" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="io-btn io-btn-primary"
              disabled={busy || check.state !== 'ok' || check.created === 0}
              onClick={() => void run()}
            >
              {check.state === 'ok' ? `Import ${check.created}` : 'Import'}
            </button>
          </>
        )
      }
    >
      <div className="pf-import-steps">
        <div className="pf-import-row">
          <input
            ref={picker}
            type="file"
            accept=".csv,.txt,text/csv,text/plain"
            aria-label="Broker CSV file"
            onChange={(e) => {
              void onFile(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
        </div>
        {readError ? <p className="pf-dlg-err">{readError}</p> : null}

        {file && preview ? (
          <>
            <div className="pf-import-row">
              <label className="pf-field">
                <span>
                  Broker{' '}
                  {over.broker === 'auto'
                    ? detected
                      ? `(detected: ${BROKER_LABEL[detected]})`
                      : '(not recognised)'
                    : ''}
                </span>
                <select
                  className="io-input"
                  value={over.broker}
                  onChange={(e) => setBroker(e.target.value)}
                >
                  <option value="auto">Auto-detect</option>
                  {BROKERS.map((b) => (
                    <option key={b} value={b}>
                      {BROKER_LABEL[b]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="pf-field">
                <span>
                  Dates
                  {over.dateOrder === 'auto' && preview.assumptions?.dateOrder
                    ? ` (read as ${preview.assumptions.dateOrder === 'mdy' ? 'month first' : 'day first'})`
                    : ''}
                </span>
                <select
                  className="io-input"
                  value={over.dateOrder}
                  onChange={(e) =>
                    setOver((o) => ({ ...o, dateOrder: e.target.value as DateOrder | 'auto' }))
                  }
                >
                  <option value="auto">Auto</option>
                  <option value="mdy">Month first (12/31/2025)</option>
                  <option value="dmy">Day first (31/12/2025)</option>
                </select>
              </label>
              <label className="pf-field">
                <span>
                  Decimals
                  {over.decimal === 'auto' && preview.assumptions?.decimal
                    ? ` (read as "${preview.assumptions.decimal}")`
                    : ''}
                </span>
                <select
                  className="io-input"
                  value={over.decimal}
                  onChange={(e) =>
                    setOver((o) => ({ ...o, decimal: e.target.value as DecimalSep | 'auto' }))
                  }
                >
                  <option value="auto">Auto</option>
                  <option value=".">Dot (1,234.50)</option>
                  <option value=",">Comma (1.234,50)</option>
                </select>
              </label>
            </div>

            {preview.warnings.length ? (
              <div className="pf-warn" role="status">
                Warnings:
                <ul>
                  {preview.warnings.slice(0, 8).map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                  {preview.warnings.length > 8 ? (
                    <li>and {preview.warnings.length - 8} more</li>
                  ) : null}
                </ul>
              </div>
            ) : null}

            {rows.length === 0 ? (
              <p className="pf-muted">No transactions found in {file.name}.</p>
            ) : (
              <>
                <p className="pf-muted">
                  {rows.length} row{rows.length === 1 ? '' : 's'} from {file.name}:{' '}
                  {Object.entries(kinds)
                    .map(
                      ([k, n]) =>
                        `${n} ${KIND_LABEL[k as keyof typeof KIND_LABEL]?.toLowerCase() ?? k}`,
                    )
                    .join(', ')}
                </p>
                {tooMany ? (
                  <p className="pf-dlg-err">
                    At most {MAX_IMPORT_ROWS.toLocaleString()} rows per import; split the file.
                  </p>
                ) : null}
                <div className="pf-import-scroll">
                  <table className="pf-import-table">
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th>Type</th>
                        <th>Symbol</th>
                        <th className="num">Qty</th>
                        <th className="num">Price</th>
                        <th className="num">Amount</th>
                        <th className="num">Fee</th>
                        <th>Ccy</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.slice(0, PREVIEW_ROWS).map((r, i) => (
                        <tr key={i}>
                          <td>{fmtDateTime(r.time)}</td>
                          <td>{KIND_LABEL[r.kind]}</td>
                          <td>{r.symbol ?? ''}</td>
                          <td className="num">{r.quantity === null ? '' : fmtQty(r.quantity)}</td>
                          <td className="num">{r.price === null ? '' : fmtPrice(r.price, 2)}</td>
                          <td className="num">{r.amount === null ? '' : fmtPrice(r.amount, 2)}</td>
                          <td className="num">{r.fee ? fmtPrice(r.fee, 2) : ''}</td>
                          <td>{r.currency}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {rows.length > PREVIEW_ROWS ? (
                  <p className="pf-muted">Showing the first {PREVIEW_ROWS} rows.</p>
                ) : null}
              </>
            )}

            {check.state === 'checking' ? (
              <p className="pf-muted">Checking with the server…</p>
            ) : null}
            {check.state === 'ok' ? (
              <p className="pf-muted">
                Dry run: {check.created} would be added, {check.skipped} skipped as already
                imported.
              </p>
            ) : null}
            {check.state === 'error' ? (
              <div className="pf-dlg-err" role="alert">
                {check.message}
                {errorList(check.rows)}
              </div>
            ) : null}
          </>
        ) : (
          <p className="pf-muted">
            Choose a CSV exported from your broker (Interactive Brokers, Charles Schwab, DEGIRO,
            Trading 212, or a generic file with date, type, symbol, quantity and price columns).
            Rows already imported are skipped.
          </p>
        )}

        {done ? (
          <p role="status">
            Imported {done.created} transaction{done.created === 1 ? '' : 's'}
            {done.skipped ? `, skipped ${done.skipped} already present` : ''}. You can undo this
            import from the Activity tab.
          </p>
        ) : null}
        {failure ? (
          <div className="pf-dlg-err" role="alert">
            Import failed: {failure.message}
            {errorList(failure.rows)}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
