import { useState } from 'react';
import { ApiError, errorMessage } from '../api/client';
import { portfolioConflict, type Portfolio } from '../api/portfolio';
import { Modal } from '../ui/Modal';
import { toast } from '../ui/Toast';
import { createPortfolio, loadPortfolios, savePortfolio } from './store';

interface Props {
  /** The portfolio to edit; null creates a new one. */
  portfolio: Portfolio | null;
  onClose: () => void;
}

/** Create a portfolio, or edit its name, base currency, benchmark and cost method. */
export function PortfolioDialog({ portfolio, onClose }: Props) {
  const [name, setName] = useState(portfolio?.name ?? '');
  const [base, setBase] = useState(portfolio?.baseCurrency ?? 'USD');
  const [benchmark, setBenchmark] = useState(portfolio ? (portfolio.benchmark ?? '') : 'SPY');
  const [method, setMethod] = useState<Portfolio['costMethod']>(portfolio?.costMethod ?? 'fifo');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const baseCode = base.trim().toUpperCase();
  const nameOk = name.trim().length > 0 && name.trim().length <= 80;
  const baseOk = /^[A-Z]{3}$/.test(baseCode);
  const valid = nameOk && baseOk && benchmark.trim().length <= 32;

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    const input = {
      name: name.trim(),
      baseCurrency: baseCode,
      benchmark: benchmark.trim().toUpperCase() || null,
      costMethod: method,
    };
    try {
      if (portfolio) await savePortfolio(portfolio.id, input);
      else await createPortfolio(input);
      onClose();
    } catch (e) {
      if (portfolio && portfolioConflict(e)) {
        toast('This portfolio was changed elsewhere; reloaded.', 'error');
        void loadPortfolios();
        onClose();
        return;
      }
      setError(e instanceof ApiError ? e.message : errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={portfolio ? 'Portfolio settings' : 'New portfolio'}
      className="pf-dlg"
      onClose={onClose}
      width={420}
      footer={
        <>
          <div className="io-spacer" />
          <button type="button" className="io-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="io-btn io-btn-primary"
            disabled={!valid || busy}
            onClick={() => void submit()}
          >
            {portfolio ? 'Save' : 'Create'}
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
        <label className="pf-field wide">
          <span>Name</span>
          <input
            className="io-input"
            autoFocus
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="pf-field">
          <span>Base currency</span>
          <input
            className="io-input"
            maxLength={3}
            value={base}
            aria-invalid={!baseOk}
            onChange={(e) => setBase(e.target.value)}
          />
        </label>
        <label className="pf-field">
          <span>Benchmark symbol</span>
          <input
            className="io-input"
            maxLength={32}
            placeholder="None"
            value={benchmark}
            onChange={(e) => setBenchmark(e.target.value)}
          />
        </label>
        <label className="pf-field wide">
          <span>Cost method</span>
          <select
            className="io-input"
            value={method}
            onChange={(e) => setMethod(e.target.value as Portfolio['costMethod'])}
          >
            <option value="fifo">FIFO (per lot)</option>
            <option value="average">Average cost</option>
          </select>
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
