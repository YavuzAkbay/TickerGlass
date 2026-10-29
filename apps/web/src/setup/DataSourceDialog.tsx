import { Check, CircleAlert, Loader2, Wifi, WifiOff } from 'lucide-react';
import { useEffect, useState } from 'react';
import { errorMessage, isNotConfigured, requestJson } from '../api/client';
import {
  getProviders,
  refreshUsage,
  useUsage,
  type Capabilities,
  type ConfigField,
  type EffectiveLimits,
  type ProviderInfo,
  type ProvidersResponse,
  type Usage,
} from '../api/provider';
import { useNow } from '../sidebar/hooks';
import { formatResetTime } from '../topbar/BudgetStatus';
import { Modal } from '../ui/Modal';
import { markSetupDone } from './firstRun';
import {
  EnvSwitch,
  UseButton,
  lockedText,
  selectedByText,
  useChooseProvider,
} from './ProviderPicker';
import './setup.css';

export type TestResult =
  | { ok: true; symbol: string; price: number; latencyMs: number }
  | { ok: false; symbol: string; error: string; code?: 'not_configured' };

/**
 * First-run step (and "Data source…" later): which market data provider this
 * instance runs on, a connection test, and how to switch to another one.
 */
export default function DataSourceDialog({ onClose, arg }: { onClose: () => void; arg?: unknown }) {
  const firstRun = !!(arg as { firstRun?: unknown } | undefined)?.firstRun;
  const [info, setInfo] = useState<ProvidersResponse | null>(null);
  const usage = useUsage();
  const now = useNow(60_000);
  const [loadError, setLoadError] = useState<string | null>(null);
  // The test starts on open: the first thing to know is whether data arrives.
  const [test, setTest] = useState<TestResult | 'running'>('running');
  // The page reloads after a switch: the first-run step must not come back on the other side.
  const choose = useChooseProvider(info, markSetupDone);

  const testConnection = () =>
    requestJson<TestResult>('POST', '/providers/test').catch((e: unknown): TestResult => ({
      ok: false,
      symbol: '',
      error: errorMessage(e),
      ...(isNotConfigured(e) ? { code: 'not_configured' as const } : {}),
    }));
  const runTest = () => {
    setTest('running');
    void testConnection().then(setTest);
  };

  useEffect(() => {
    let alive = true;
    getProviders().then(
      (r) => alive && setInfo(r),
      (e: unknown) => alive && setLoadError(errorMessage(e)),
    );
    void testConnection().then((r) => alive && setTest(r));
    void refreshUsage(); // the budget bar shows the reading from now, not from a minute ago
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
            <ProviderCard
              key={p.id}
              p={p}
              active={info.active === p.id}
              setting={info.setting}
              selectedBy={info.active === p.id ? selectedByText(info) : undefined}
              onUse={info.switchable ? choose.use : undefined}
              busy={choose.busy}
              limits={info.effectiveLimits}
              usage={usage}
              now={now}
            />
          ))}
        </ul>
        {info && lockedText(info) ? <p className="ds-note">{lockedText(info)}</p> : null}
      </div>
    </Modal>
  );
}

export function TestStatus({ test }: { test: TestResult | 'running' }) {
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
  if (test.code === 'not_configured')
    return (
      <div className="ds-test fail" role="status">
        <CircleAlert size={16} /> Not configured: {test.error}
      </div>
    );
  return (
    <div className="ds-test fail" role="status">
      <CircleAlert size={16} /> No data{test.symbol ? ` for ${test.symbol}` : ''}: {test.error}
    </div>
  );
}

const MARKET_LABELS: Record<string, string> = {
  us: 'US stocks',
  intl: 'International stocks',
  fx: 'Forex',
  crypto: 'Crypto',
  index: 'Indices',
  futures: 'Futures',
};

/** What the provider offers, as chips: a feature it lacks reads "off". */
function capabilityChips(c: Capabilities): { label: string; on: boolean }[] {
  return [
    { label: 'Live stream', on: c.streaming },
    { label: 'Extended hours', on: c.extendedHistory },
    { label: 'Pre/post quotes', on: c.extendedQuotes },
    { label: 'Adjusted close', on: c.adjustedClose },
    { label: 'Search', on: c.search },
    { label: 'News', on: c.news },
    { label: 'Fundamentals', on: c.fundamentalsInfo },
    { label: 'Statements', on: c.fundamentalsStatements },
    {
      label: c.events.length ? `Events: ${c.events.join(', ')}` : 'Events',
      on: c.events.length > 0,
    },
  ];
}

export function CapabilityChips({ capabilities }: { capabilities: Capabilities }) {
  return (
    <ul className="ds-chips" aria-label="Capabilities">
      {capabilityChips(capabilities).map((c) => (
        <li
          key={c.label}
          className={`ds-chip ${c.on ? 'on' : 'off'}`}
          aria-label={`${c.label}: ${c.on ? 'available' : 'not available'}`}
        >
          {c.on ? <Check size={11} aria-hidden="true" /> : null}
          {c.label}
        </li>
      ))}
      {capabilities.markets.map((m) => (
        <li key={m} className="ds-chip market">
          {MARKET_LABELS[m] ?? m}
        </li>
      ))}
    </ul>
  );
}

/** One environment setting: its name, the value (never a secret's) and whether it is set. */
export function ConfigLine({ f }: { f: ConfigField }) {
  const state = f.set ? 'set' : f.required ? 'missing' : 'default';
  // A secret is only ever reported as set or missing: its value is not shown even if sent.
  const value = !f.secret && f.value !== null && f.value !== undefined ? String(f.value) : null;
  return (
    <li className="ds-config-line">
      <code>{value === null ? f.env : `${f.env}=${value}`}</code>
      <span className="ds-config-label">{f.label}</span>
      <span className={`ds-badge ${state}`}>{state}</span>
    </li>
  );
}

const LIMIT_SOURCES: Record<EffectiveLimits['source'], string> = {
  plan: 'from your plan',
  env: 'from environment settings',
  calibrated: 'as reported by the provider',
};

export function LimitsSummary({ limits }: { limits: EffectiveLimits }) {
  const daily = limits.dailyCredits ? `${limits.dailyCredits} per day` : 'no daily cap';
  return (
    <p className="ds-limits">
      Budget: {Math.round(limits.creditsPerMin)} credits per minute, {daily} (
      {LIMIT_SOURCES[limits.source]}). Quotes refresh every {limits.quoteTtlS} s, live prices poll
      every {limits.pollIntervalS} s.
    </p>
  );
}

function Meter({
  label,
  value,
  max,
  detail,
}: {
  label: string;
  value: number;
  max: number;
  detail: string;
}) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div className="ds-meter">
      <div className="ds-meter-head">
        <span>{label}</span>
        <span className="ds-meter-detail">{detail}</span>
      </div>
      <div
        className="ds-meter-track"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={Math.min(value, max)}
      >
        <div className={`ds-meter-fill${pct >= 90 ? ' high' : ''}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/** Credits used today and left this minute (only for a metered provider). */
export function UsageBar({ usage, now }: { usage: Usage; now: number }) {
  const { daily, minute } = usage;
  return (
    <div className="ds-usage">
      {daily ? (
        <Meter
          label="Credits today"
          value={daily.used}
          max={daily.limit}
          detail={`${daily.used} of ${daily.limit} used, resets ${formatResetTime(new Date(daily.resetAt), new Date(now))}`}
        />
      ) : null}
      <Meter
        label="Credits this minute"
        value={minute.limit - minute.left}
        max={minute.limit}
        detail={`${minute.left} of ${minute.limit} left`}
      />
    </div>
  );
}

export function ProviderCard({
  p,
  active,
  setting,
  selectedBy,
  onUse,
  busy,
  limits,
  usage,
  now,
}: {
  p: ProviderInfo;
  active: boolean;
  setting: string;
  /** How the provider in use was chosen (shown on its card only). */
  selectedBy?: string | undefined;
  /** Switch to this provider from the app; absent: show how to set it in .env. */
  onUse?: ((p: ProviderInfo) => void) | undefined;
  busy?: boolean | undefined;
  /** Effective limits of the provider in use (shown on its card only). */
  limits?: EffectiveLimits;
  usage?: Usage | null;
  now: number;
}) {
  const Net = p.network ? Wifi : WifiOff;
  const missing = p.config.filter((f) => f.required && !f.set);
  return (
    <li className={`ds-card${active ? ' active' : ''}`} aria-current={active || undefined}>
      <div className="ds-card-head">
        <span className="ds-name">{p.name}</span>
        {selectedBy ? <span className="ds-selected">({selectedBy})</span> : null}
        <span className="ds-tag" title={p.network ? 'Needs internet' : 'Works offline'}>
          <Net size={12} /> {p.network ? 'Online' : 'Offline'}
        </span>
        {p.plan ? <span className="ds-tag">Plan: {p.plan}</span> : null}
        {active ? <span className="ds-tag ds-in-use">In use</span> : null}
      </div>
      <p className="ds-desc">{p.description}</p>
      {p.terms ? <p className="ds-terms">{p.terms}</p> : null}
      {p.configured ? null : (
        <div className="ds-warn" role="alert">
          <CircleAlert size={14} aria-hidden="true" /> Not configured: set{' '}
          {missing.map((f) => f.env).join(', ') || 'its required settings'} in .env
          {' and restart the API.'}
        </div>
      )}
      <CapabilityChips capabilities={p.capabilities} />
      {p.config.length ? (
        <ul className="ds-config" aria-label={`${p.name} settings`}>
          {p.config.map((f) => (
            <ConfigLine key={f.name} f={f} />
          ))}
        </ul>
      ) : null}
      {active && limits ? <LimitsSummary limits={limits} /> : null}
      {active && usage?.metered ? <UsageBar usage={usage} now={now} /> : null}
      {active ? null : onUse ? (
        p.configured ? (
          <UseButton p={p} onUse={onUse} busy={busy} />
        ) : null
      ) : (
        <EnvSwitch p={p} setting={setting} />
      )}
    </li>
  );
}
