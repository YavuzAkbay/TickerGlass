import { Image, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { errorMessage } from '../api/client';
import type { Portfolio, Transaction } from '../api/portfolio';
import type { Ledger } from '@tickerglass/portfolio';
import { useChartView } from '../store/chartView';
import { toast } from '../ui/Toast';
import { fmtDate, fmtR, tone } from './fmt';
import { JournalEditor } from './JournalEditor';
import { entryR, filterEntries, filterOptions, lotsByOpenTx } from './journalDraft';
import { addJournalEntry, usePortfolio } from './store';

interface Props {
  portfolio: Portfolio;
  transactions: readonly Transaction[];
  ledger: Ledger;
}

export function JournalTab({ portfolio, transactions, ledger }: Props) {
  const journal = usePortfolio((s) => s.journal);
  const chartSymbol = useChartView((s) => s.symbol);
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);

  const options = useMemo(() => filterOptions(journal), [journal]);
  const shown = useMemo(() => filterEntries(journal, filter), [journal, filter]);
  const lots = useMemo(() => lotsByOpenTx(ledger.closedLots), [ledger.closedLots]);
  const entry = selected ? journal.find((j) => j.id === selected) : undefined;

  const create = async () => {
    setBusy(true);
    try {
      const e = await addJournalEntry(portfolio.id, {
        transactionId: null,
        symbol: chartSymbol || null,
        noteId: null,
        setup: null,
        tags: [],
        stop: null,
        rMultiple: null,
      });
      setSelected(e.id);
    } catch (err) {
      toast(`Could not add the entry: ${errorMessage(err)}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  if (entry)
    return (
      <JournalEditor
        key={entry.id}
        entry={entry}
        transactions={transactions}
        ledger={ledger}
        onBack={() => setSelected(null)}
      />
    );

  return (
    <div>
      <div className="pf-toolbar">
        <button
          type="button"
          className="io-btn io-btn-primary pf-btn"
          disabled={busy}
          onClick={() => void create()}
        >
          <Plus size={14} /> New entry
        </button>
        {options.tags.length || options.setups.length ? (
          <select
            className="io-input pf-sel"
            aria-label="Filter entries"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          >
            <option value="">All entries</option>
            {options.setups.length ? (
              <optgroup label="Setup">
                {options.setups.map((s) => (
                  <option key={s} value={`setup:${s}`}>
                    {s}
                  </option>
                ))}
              </optgroup>
            ) : null}
            {options.tags.length ? (
              <optgroup label="Tag">
                {options.tags.map((t) => (
                  <option key={t} value={`tag:${t}`}>
                    {t}
                  </option>
                ))}
              </optgroup>
            ) : null}
          </select>
        ) : null}
      </div>
      {journal.length === 0 ? (
        <p className="pf-muted pf-pad">
          Keep a trade journal: link an entry to a buy, note why you took it, set a stop to see the
          result in R, and attach a chart screenshot.
        </p>
      ) : shown.length === 0 ? (
        <p className="pf-muted pf-pad">No entries match the filter.</p>
      ) : (
        <ul className="pf-rows" aria-label="Journal entries" style={{ marginTop: 8 }}>
          {shown.map((e) => {
            const r = entryR(e.stop, e.rMultiple, e.transactionId, lots);
            return (
              <li key={e.id}>
                <button type="button" className="pf-entry" onClick={() => setSelected(e.id)}>
                  <span className="pf-entry-head">
                    <b>{e.symbol ?? 'No symbol'}</b>
                    <span className={`pf-r ${tone(r)}`}>{fmtR(r)}</span>
                  </span>
                  <span className="pf-muted">
                    {[e.setup, fmtDate(e.createdAt)].filter(Boolean).join(' · ')}
                    {e.hasScreenshot ? ' · ' : ''}
                    {e.hasScreenshot ? <Image size={11} aria-label="Has screenshot" /> : null}
                  </span>
                  {e.tags.length ? (
                    <span className="pf-chips">
                      {e.tags.map((t) => (
                        <span key={t} className="pf-chip">
                          {t}
                        </span>
                      ))}
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
