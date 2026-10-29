import { Copy } from 'lucide-react';
import { useEffect, useState } from 'react';
import { errorMessage } from '../api/client';
import { getProviders, type ProviderInfo, type ProvidersResponse } from '../api/provider';
import { toast } from '../ui/Toast';
import { chooseProvider } from './switchProvider';
import './setup.css';

/** Required settings of `p` that are not set yet (their env names). */
export const missingEnv = (p: ProviderInfo): string[] =>
  p.config.filter((f) => f.required && !f.set).map((f) => f.env);

/** How the provider in use was chosen, as a short note. */
export function selectedByText(info: Pick<ProvidersResponse, 'selectedBy' | 'setting'>): string {
  if (info.selectedBy === 'ui') return 'selected in app';
  if (info.selectedBy === 'env') return `from ${info.setting}`;
  return 'default';
}

/** Why the picker cannot switch (null when it can). */
export function lockedText(info: Pick<ProvidersResponse, 'switchable' | 'active'>): string | null {
  if (info.switchable) return null;
  return info.active === null
    ? 'This API runs on a custom provider; it cannot be switched here.'
    : 'Switching is disabled (PROVIDER_SWITCHING=false).';
}

/** "To use it, set MARKET_PROVIDER=id in .env and restart the API." with a copy button. */
export function EnvSwitch({ p, setting }: { p: ProviderInfo; setting: string }) {
  const line = `${setting}=${p.id}`;
  return (
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
  );
}

/** Switch to `p` from the app. Disabled while another switch is under way. */
export function UseButton({
  p,
  onUse,
  busy,
}: {
  p: ProviderInfo;
  onUse: (p: ProviderInfo) => void;
  busy?: boolean | undefined;
}) {
  return (
    <div className="ds-switch">
      <button
        type="button"
        className="io-btn"
        aria-label={`Use ${p.name}`}
        disabled={busy}
        onClick={() => onUse(p)}
      >
        Use
      </button>
    </div>
  );
}

/** Ask, switch and reload for the picker and the dialog; `busy` while that is under way. */
export function useChooseProvider(
  info: ProvidersResponse | null,
  beforeSwitch?: () => void | Promise<void>,
): {
  busy: boolean;
  use: (p: ProviderInfo) => void;
} {
  const [busy, setBusy] = useState(false);
  const use = (p: ProviderInfo) => {
    if (!info || busy) return;
    setBusy(true);
    void chooseProvider(p, info, beforeSwitch ? { beforeSwitch } : {}).finally(() =>
      setBusy(false),
    );
  };
  return { busy, use };
}

function Action({
  p,
  info,
  locked,
  onUse,
  busy,
}: {
  p: ProviderInfo;
  info: ProvidersResponse;
  locked: boolean;
  onUse: (p: ProviderInfo) => void;
  busy?: boolean | undefined;
}) {
  if (!p.configured)
    return (
      <div className="ds-switch">
        {locked ? null : (
          <button type="button" className="io-btn" disabled aria-label={`Use ${p.name}`}>
            Use
          </button>
        )}
        <span className="ds-hint">
          Set {missingEnv(p).join(', ') || 'its required settings'} in .env and restart the API.
        </span>
      </div>
    );
  return locked ? (
    <EnvSwitch p={p} setting={info.setting} />
  ) : (
    <UseButton p={p} onUse={onUse} busy={busy} />
  );
}

/**
 * Every provider with what can be done about it: use a configured one, read what an
 * unconfigured one needs, or (switching off) the env setting that picks the provider.
 */
export function ProviderPicker({
  info,
  onUse,
  busy,
}: {
  info: ProvidersResponse;
  onUse: (p: ProviderInfo) => void;
  busy?: boolean | undefined;
}) {
  const locked = lockedText(info);
  return (
    <div className="ds-picker">
      {locked ? <p className="ds-note">{locked}</p> : null}
      <ul className="ds-list" aria-label="Data providers">
        {info.providers.map((p) => {
          const active = info.active === p.id;
          return (
            <li key={p.id} className={`ds-card${active ? ' active' : ''}`}>
              <div className="ds-card-head">
                <span className="ds-name">{p.name}</span>
                {active ? <span className="ds-selected">({selectedByText(info)})</span> : null}
                {active ? <span className="ds-tag ds-in-use">In use</span> : null}
              </div>
              <p className="ds-desc">{p.description}</p>
              {active ? null : (
                <Action p={p} info={info} locked={locked !== null} onUse={onUse} busy={busy} />
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Settings "Data source" tab: the picker, loaded on open. Applies at once, not with Ok. */
export function DataSourcePicker({
  beforeSwitch,
}: {
  /** See `SwitchDeps.beforeSwitch`. */
  beforeSwitch?: () => void | Promise<void>;
}) {
  const [info, setInfo] = useState<ProvidersResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { busy, use } = useChooseProvider(info, beforeSwitch);

  useEffect(() => {
    let alive = true;
    getProviders().then(
      (r) => alive && setInfo(r),
      (e: unknown) => alive && setError(errorMessage(e)),
    );
    return () => {
      alive = false;
    };
  }, []);

  return (
    <>
      {error ? (
        <div className="rs-error" role="alert">
          Provider list unavailable: {error}
        </div>
      ) : null}
      {info ? <ProviderPicker info={info} onUse={use} busy={busy} /> : null}
    </>
  );
}
