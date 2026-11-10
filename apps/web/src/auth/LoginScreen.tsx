import { useEffect, useRef, useState, type FormEvent } from 'react';
import { errorMessage } from '../api/client';
import { login } from '../api/auth';
import { useT } from '../i18n';
import './login.css';

/** Full-screen sign-in when the server has password auth and this browser has
 * no session. Success reloads so every layer (persistence, quotes, provider)
 * boots with the cookie in place. */
export function LoginScreen() {
  const t = useT();
  const inputRef = useRef<HTMLInputElement>(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (busy || !password) return;
    setBusy(true);
    setError(null);
    login(password)
      .then(() => location.reload())
      .catch((err) => {
        setBusy(false);
        setError(errorMessage(err));
      });
  };

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={submit}>
        <h1 className="login-title">TickerGlass</h1>
        <p className="login-note">{t('login.note')}</p>
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
      </form>
    </div>
  );
}
