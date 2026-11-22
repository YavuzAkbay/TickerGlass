import { Briefcase, Plus, Settings2, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { errorMessage } from '../api/client';
import { useT } from '../i18n';
import { IconButton } from '../ui/IconButton';
import { confirmDialog } from '../ui/Prompt';
import { toast } from '../ui/Toast';
import { Activity } from './Activity';
import { Holdings } from './Holdings';
import { JournalTab } from './JournalTab';
import { PerformanceTab } from './PerformanceTab';
import { PortfolioDialog } from './PortfolioDialog';
import {
  activePortfolio,
  loadData,
  loadPortfolios,
  PORTFOLIO_TABS,
  removePortfolio,
  selectPortfolio,
  usePortfolio,
  type PortfolioTab,
} from './store';
import { useLedger, useValuation } from './useValuation';
import '../backtest/backtest.css';
import './portfolio.css';

const TAB_KEY = {
  holdings: 'portfolio.tab.holdings',
  activity: 'portfolio.tab.activity',
  performance: 'portfolio.tab.performance',
  journal: 'portfolio.tab.journal',
} as const satisfies Record<PortfolioTab, string>;

/** Navigator section: portfolio picker and the Holdings / Activity / Performance / Journal tabs. */
export function PortfolioPanel() {
  const t = useT();
  const portfolios = usePortfolio((s) => s.portfolios);
  const listStatus = usePortfolio((s) => s.listStatus);
  const listError = usePortfolio((s) => s.listError);
  const dataStatus = usePortfolio((s) => s.dataStatus);
  const dataError = usePortfolio((s) => s.dataError);
  const tab = usePortfolio((s) => s.tab);
  const transactions = usePortfolio((s) => s.transactions);
  const pendingTrade = usePortfolio((s) => s.pendingTrade);
  const portfolio = usePortfolio(activePortfolio);
  const [dialog, setDialog] = useState<'new' | 'edit' | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    void loadPortfolios(ac.signal);
    return () => ac.abort();
  }, []);

  // "Log trade for current symbol" lands on the Activity tab.
  useEffect(() => {
    if (pendingTrade && tab !== 'activity') usePortfolio.getState().set({ tab: 'activity' });
  }, [pendingTrade, tab]);

  const ledger = useLedger(portfolio, transactions);
  const valuation = useValuation(portfolio, ledger);

  const remove = async () => {
    if (!portfolio) return;
    const ok = await confirmDialog({
      title: 'Delete portfolio',
      message: `Delete "${portfolio.name}" with all its transactions and journal entries? This cannot be undone.`,
      okLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await removePortfolio(portfolio.id);
    } catch (e) {
      toast(`Delete failed: ${errorMessage(e)}`, 'error');
    }
  };

  if (listStatus === 'error' && portfolios.length === 0)
    return (
      <div className="rs-error pf-err" role="alert">
        <span>Could not load portfolios: {listError}</span>
        <button type="button" className="io-btn rs-error-btn" onClick={() => void loadPortfolios()}>
          {t('nav.retry')}
        </button>
      </div>
    );

  if (!portfolio)
    return (
      <>
        <div className="rs-empty">
          <Briefcase size={28} strokeWidth={1.4} />
          <p className="rs-empty-title">{t('portfolio.empty.title')}</p>
          <p className="rs-empty-text">{t('portfolio.empty.text')}</p>
          {listStatus === 'loading' || listStatus === 'idle' ? (
            <p className="pf-muted">{t('nav.loading')}</p>
          ) : (
            <button
              type="button"
              className="io-btn io-btn-primary rs-empty-btn"
              onClick={() => setDialog('new')}
            >
              <Plus size={14} /> {t('portfolio.create')}
            </button>
          )}
        </div>
        {dialog ? <PortfolioDialog portfolio={null} onClose={() => setDialog(null)} /> : null}
      </>
    );

  return (
    <div className="pf-panel">
      <div className="pf-bar">
        <select
          className="io-input pf-pick"
          aria-label={t('portfolio.picker')}
          value={portfolio.id}
          onChange={(e) => void selectPortfolio(e.target.value)}
        >
          {portfolios.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <IconButton icon={Plus} label={t('portfolio.new')} onClick={() => setDialog('new')} />
        <IconButton
          icon={Settings2}
          label={t('portfolio.settings')}
          onClick={() => setDialog('edit')}
        />
        <IconButton icon={Trash2} label={t('portfolio.delete')} onClick={() => void remove()} />
      </div>
      <div className="pf-bar">
        <div className="wl-seg" role="tablist" aria-label={t('portfolio.view')}>
          {PORTFOLIO_TABS.map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              aria-pressed={tab === id}
              onClick={() => usePortfolio.getState().set({ tab: id })}
            >
              {t(TAB_KEY[id])}
            </button>
          ))}
        </div>
      </div>
      {dataStatus === 'error' ? (
        <div className="rs-error pf-err" role="alert">
          <span>Could not load this portfolio: {dataError}</span>
          <button
            type="button"
            className="io-btn rs-error-btn"
            onClick={() => void loadData(portfolio.id)}
          >
            {t('nav.retry')}
          </button>
        </div>
      ) : null}
      <div className="pf-body">
        {dataStatus === 'loading' && transactions.length === 0 ? (
          <p className="pf-muted pf-pad">{t('nav.loading')}</p>
        ) : tab === 'holdings' ? (
          <Holdings
            portfolio={portfolio}
            transactions={transactions}
            ledger={ledger}
            valuation={valuation}
          />
        ) : tab === 'activity' ? (
          <Activity portfolio={portfolio} transactions={transactions} />
        ) : tab === 'performance' ? (
          <PerformanceTab portfolio={portfolio} transactions={transactions} />
        ) : (
          <JournalTab portfolio={portfolio} transactions={transactions} ledger={ledger} />
        )}
      </div>
      {dialog ? (
        <PortfolioDialog
          portfolio={dialog === 'edit' ? portfolio : null}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </div>
  );
}
