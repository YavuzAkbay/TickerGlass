import { useEffect, useRef, useState, type FormEvent } from 'react';
import { errorMessage } from '../api/client';
import { login, type AuthMethod } from '../api/auth';
import { useAuthStore } from '../store/auth';
import { useT } from '../i18n';
import {
  authErrorKey,
  markAutoRedirect,
  oidcLoginUrl,
  planLogin,
  readAuthError,
  readAutoRedirectAt,
  stripAuthError,
} from './loginPlan';
import './login.css';

interface LoginViewProps {
  methods: readonly AuthMethod[];
  oidcName: string | null;
  /** Local accounts exist: offer the optional Username field (empty signs in as the admin). */
  localAccounts?: boolean;
  /** `auth_error` code the OIDC round trip came back with, if any. */
  authError: string | null;
  /** Start the OIDC flow (full-page navigation). */
  onOidc: () => void;
  /** Loop guard input: when this tab last auto-redirected (null = never). */
  lastAutoRedirectAt?: number | null;
  /** The "now" the loop guard is judged at; fixed per mount so the view cannot flip. */
  now?: number;
}

/** The sign-in card for the methods the server offers. */
export function LoginView({
  methods,
  oidcName,
  localAccounts = false,
  authError,
  onOidc,
  lastAutoRedirectAt = null,
  now: nowProp,
}: LoginViewProps) {
  const t = useT();
  const [mountNow] = useState(() => Date.now());
  const now = nowProp ?? mountNow;
  const inputRef = useRef<HTMLInputElement>(null);
  const userRef = useRef<HTMLInputElement>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const plan = planLogin(methods, authError, lastAutoRedirectAt, now, localAccounts);
  const providerName = oidcName ?? t('login.oidcDefaultName');

  useEffect(() => {
    if (plan.password) (plan.username ? userRef : inputRef).current?.focus();
  }, [plan.password, plan.username]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (busy || !password) return;
    setBusy(true);
    setError(null);
    login(password, plan.username ? username : undefined)
      .then(() => location.reload())
      .catch((err) => {
        setBusy(false);
        setError(errorMessage(err));
      });
  };

  const header = (
    <>
      <span className="tb-brand-mark login-mark" aria-hidden="true" />
      <h1 className="login-title">TickerGlass</h1>
    </>
  );
  const banner =
    authError !== null ? (
      <p className="login-error login-banner" role="alert">
        {t(authErrorKey(authError))}
      </p>
    ) : null;

  if (plan.proxyOnly)
    return (
      <div className="login-screen">
        <div className="login-card">
          {header}
          {banner}
          <p className="login-note">{t('login.proxyOnly')}</p>
        </div>
      </div>
    );

  if (plan.autoRedirect)
    return (
      <div className="login-screen">
        <div className="login-card" aria-busy="true">
          {header}
          <p className="login-note">{t('login.redirecting', { name: providerName })}</p>
        </div>
      </div>
    );

  const oidcButton = plan.oidc ? (
    <button
      type="button"
      className={`io-btn ${plan.password ? '' : 'io-btn-primary'}`.trim()}
      onClick={onOidc}
    >
      {t('login.oidc', { name: providerName })}
    </button>
  ) : null;

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={submit}>
        {header}
        <p className="login-note">{t('login.note')}</p>
        {banner}
        {plan.password ? (
          <>
            {plan.username ? (
              <input
                ref={userRef}
                type="text"
                className="io-input login-input"
                value={username}
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                placeholder={t('login.usernamePlaceholder')}
                aria-label={t('login.usernamePlaceholder')}
                onChange={(e) => setUsername(e.target.value)}
                disabled={busy}
              />
            ) : null}
            <input
              ref={inputRef}
              type="password"
              className="io-input login-input"
              value={password}
              autoComplete="current-password"
              placeholder={t('login.placeholder')}
              aria-label={t('login.placeholder')}
              aria-invalid={error !== null}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
            />
            {error ? (
              <p className="login-error" role="alert">
                {error}
              </p>
            ) : null}
            <button type="submit" className="io-btn io-btn-primary" disabled={busy || !password}>
              {busy ? t('login.signingIn') : t('login.signIn')}
            </button>
          </>
        ) : null}
        {plan.password && plan.oidc ? (
          <div className="login-divider" role="separator">
            <span>{t('login.or')}</span>
          </div>
        ) : null}
        {oidcButton}
      </form>
    </div>
  );
}

/** Full-screen sign-in when the server requires credentials this browser does
 * not have: password form, SSO button, or a note to use the auth proxy. Password
 * success reloads so every layer (persistence, quotes, provider) boots with the
 * cookie in place. */
export function LoginScreen() {
  const info = useAuthStore((s) => s.info);
  // Read once: the param is stripped from the URL right after the first paint.
  const [authError] = useState(() => readAuthError(location.search));
  // Until `/auth/state` answers (or when it never does) assume the classic password form.
  const methods = info?.methods ?? ['password'];
  const oidcName = info?.oidcName ?? null;
  const localAccounts = info?.localAccounts ?? false;

  const startOidc = () => location.assign(oidcLoginUrl(location.pathname, location.search));

  useEffect(() => {
    if (authError === null) return;
    const search = stripAuthError(location.search);
    history.replaceState(history.state, '', `${location.pathname}${search}${location.hash}`);
  }, [authError]);

  // Read once: a loop (IdP sends us straight back, still signed out) must show the button.
  const [lastAutoRedirectAt] = useState(readAutoRedirectAt);
  const [now] = useState(() => Date.now());
  const autoRedirect = planLogin(
    methods,
    authError,
    lastAutoRedirectAt,
    now,
    localAccounts,
  ).autoRedirect;
  useEffect(() => {
    if (!autoRedirect) return;
    markAutoRedirect();
    startOidc();
    // startOidc reads the live location; only the decision matters.
  }, [autoRedirect]);

  return (
    <LoginView
      methods={methods}
      oidcName={oidcName}
      localAccounts={localAccounts}
      authError={authError}
      onOidc={startOidc}
      lastAutoRedirectAt={lastAutoRedirectAt}
      now={now}
    />
  );
}
