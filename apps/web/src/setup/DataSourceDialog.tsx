import { Check, CircleAlert, Copy, Loader2, Wifi, WifiOff } from 'lucide-react';
import { useEffect, useState } from 'react';
import { errorMessage, getJson, requestJson } from '../api/client';
import { Modal } from '../ui/Modal';
import { toast } from '../ui/Toast';
import { markSetupDone } from './firstRun';
import './setup.css';

interface ProviderInfo {
  id: string;
  name: string;
  description: string;
  network: boolean;
  terms: string | null;
}

interface ProvidersResponse {
  active: string | null;
  setting: string;
  providers: ProviderInfo[];
}

type TestResult =
  | { ok: true; symbol: string; price: number; latencyMs: number }
  | { ok: false; symbol: string; error: string };

/**
 * First-run step (and "Data source…" later): which market data provider this
 * instance runs on, a connection test, and how to switch to another one.
 */
export default function DataSourceDialog({ onClose, arg }: { onClose: () => void; arg?: unknown }) {
  const firstRun = !!(arg as { firstRun?: unknown } | undefined)?.firstRun;
  const [info, setInfo] = useState<ProvidersResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // The test starts on open: the first thing to know is whether data arrives.
  const [test, setTest] = useState<TestResult | 'running'>('running');

  const testConnection = () =>
    requestJson<TestResult>('POST', '/providers/test').catch((e: unknown): TestResult => ({
      ok: false,
      symbol: '',
      error: errorMessage(e),
    }));
  const runTest = () => {
    setTest('running');
    void testConnection().then(setTest);
  };

  useEffect(() => {
    let alive = true;
    getJson<ProvidersResponse>('/providers').then(
      (r) => alive && setInfo(r),
      (e: unknown) => alive && setLoadError(errorMessage(e)),
    );
    void testConnection().then((r) => alive && setTest(r));
    return () => {
      alive = false;
    };
  }, []);

  const close = () => {
    markSetupDone();
    onClose();
  };

  return (
    <Modal
      title={firstRun ? 'Welcome to TickerGlass' : 'Data source'}
      onClose={close}
      width={560}
      className="ds-dialog"
      footer={
        <>
          <button type="button" className="io-btn" onClick={runTest} disabled={test === 'running'}>
            Test connection
          </button>
          <div className="dlg-footer-spacer" />
          <button type="button" className="io-btn io-btn-primary" onClick={close}>
            {firstRun ? 'Start charting' : 'Done'}
          </button>
        </>
      }
    >
      <div className="ds-body">
        <p className="ds-lead">
          {firstRun
            ? 'Your instance fetches market data from the source below. You can run it on any provider TickerGlass supports.'
            : 'The market data provider this instance runs on.'}
        </p>
        <TestStatus test={test} />
        {loadError ? (
          <div className="rs-error" role="alert">
            Provider list unavailable: {loadError}
          </div>
        ) : null}
        <ul className="ds-list" aria-label="Data providers">
          {info?.providers.map((p) => (
            <ProviderCard key={p.id} p={p} active={info.active === p.id} setting={info.setting} />
          ))}
        </ul>
        {info && info.active === null ? (
          <p className="ds-note">This API runs on a custom provider.</p>
        ) : null}
      </div>
    </Modal>
  );
}

function TestStatus({ test }: { test: TestResult | 'running' }) {
  if (test === 'running')
    return (
      <div className="ds-test" role="status">
        <Loader2 size={16} className="ds-spin" /> Testing the connection…
      </div>
    );
  if (test.ok)
    return (
      <div className="ds-test ok" role="status">
        <Check size={16} /> Connected: {test.symbol} at {test.price.toFixed(2)} ({test.latencyMs}{' '}
        ms)
      </div>
    );
  return (
    <div className="ds-test fail" role="status">
      <CircleAlert size={16} /> No data{test.symbol ? ` for ${test.symbol}` : ''}: {test.error}
    </div>
  );
}

function ProviderCard({
  p,
  active,
  setting,
}: {
  p: ProviderInfo;
  active: boolean;
  setting: string;
}) {
  const line = `${setting}=${p.id}`;
  const Net = p.network ? Wifi : WifiOff;
  return (
    <li className={`ds-card${active ? ' active' : ''}`} aria-current={active || undefined}>
      <div className="ds-card-head">
        <span className="ds-name">{p.name}</span>
        <span className="ds-tag" title={p.network ? 'Needs internet' : 'Works offline'}>
          <Net size={12} /> {p.network ? 'Online' : 'Offline'}
        </span>
        {active ? <span className="ds-tag ds-in-use">In use</span> : null}
      </div>
      <p className="ds-desc">{p.description}</p>
      {p.terms ? <p className="ds-terms">{p.terms}</p> : null}
      {active ? null : (
        <div className="ds-switch">
          <span>To use it, set</span>
          <code>{line}</code>
          <button
            type="button"
            className="io-icon-btn ds-copy"
            aria-label={`Copy ${line}`}
            title="Copy"
            onClick={() => {
              void navigator.clipboard?.writeText(line).then(
                () => toast('Copied', 'success'),
                () => toast(line),
              );
            }}
          >
            <Copy size={14} />
          </button>
          <span>in .env and restart the API.</span>
        </div>
      )}
    </li>
  );
}
