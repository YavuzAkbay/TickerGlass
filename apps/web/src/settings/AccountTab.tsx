import { useEffect, useState, type FormEvent } from 'react';
import { errorMessage } from '../api/client';
import { changeMyPassword, fetchMe, renameMe, type Me } from '../api/users';
import { useAuthStore } from '../store/auth';
import { useT } from '../i18n';
import { toast } from '../ui/Toast';
import { Row, Section } from '../dialogs/controls';
import { changePasswordProblem } from './usersModel';

/** Settings → Account: the signed-in user's display name and (local accounts) password. */
export function AccountTab() {
  const t = useT();
  const authUser = useAuthStore((s) => s.info?.user ?? null);
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetchMe().then(
      (m) => alive && setMe(m),
      (err: unknown) => alive && setError(errorMessage(err)),
    );
    return () => {
      alive = false;
    };
  }, []);

  if (error)
    return (
      <Section title={t('settings.tab.account')}>
        <p className="dlg-note">{error}</p>
      </Section>
    );
  if (!me)
    return (
      <Section title={t('settings.tab.account')}>
        <p className="dlg-note">{authUser ? authUser.name : '…'}</p>
      </Section>
    );
  return (
    <>
      <ProfileSection me={me} onRenamed={setMe} />
      {me.localAccount ? <PasswordSection /> : null}
    </>
  );
}

function ProfileSection({ me, onRenamed }: { me: Me; onRenamed: (m: Me) => void }) {
  const t = useT();
  const [name, setName] = useState(me.name);
  const [busy, setBusy] = useState(false);
  const trimmed = name.trim();
  const dirty = trimmed !== me.name && trimmed.length > 0;

  const save = (e: FormEvent) => {
    e.preventDefault();
    if (!dirty || busy) return;
    setBusy(true);
    renameMe(trimmed)
      .then((m) => {
        const next = m ?? { ...me, name: trimmed };
        onRenamed(next);
        setName(next.name);
        const { info, setInfo } = useAuthStore.getState();
        if (info?.user) setInfo({ ...info, user: { ...info.user, name: next.name } });
        toast(t('acct.nameSaved'), 'success');
      })
      .catch((err) => toast(t('acct.nameFail', { error: errorMessage(err) }), 'error', 6000))
      .finally(() => setBusy(false));
  };

  return (
    <Section title={t('settings.tab.account')}>
      <form onSubmit={save}>
        <Row label={t('acct.name')} htmlFor="acct-name">
          <input
            id="acct-name"
            className="io-input"
            value={name}
            maxLength={120}
            autoComplete="name"
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
          />
        </Row>
        {me.email ? (
          <Row label={t('acct.email')}>
            <span className="usr-value">{me.email}</span>
          </Row>
        ) : null}
        <Row label={t('acct.role')}>
          <span className="usr-value">
            {t(me.role === 'admin' ? 'users.role.admin' : 'users.role.user')}
          </span>
        </Row>
        <div className="usr-actions">
          <button type="submit" className="io-btn" disabled={!dirty || busy}>
            {t('acct.saveName')}
          </button>
        </div>
      </form>
    </Section>
  );
}

function PasswordSection() {
  const t = useT();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const problem = changePasswordProblem(current, next, confirm);
    if (problem) {
      setError(t(problem));
      return;
    }
    setBusy(true);
    setError(null);
    changeMyPassword(current, next)
      .then(() => {
        setCurrent('');
        setNext('');
        setConfirm('');
        toast(t('acct.passwordChanged'), 'success');
      })
      .catch((err) => setError(errorMessage(err)))
      .finally(() => setBusy(false));
  };

  return (
    <Section title={t('acct.password')}>
      <form onSubmit={submit}>
        <Row label={t('acct.currentPassword')} htmlFor="acct-pw-cur">
          <input
            id="acct-pw-cur"
            type="password"
            className="io-input"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            disabled={busy}
          />
        </Row>
        <Row label={t('acct.newPassword')} htmlFor="acct-pw-new">
          <input
            id="acct-pw-new"
            type="password"
            className="io-input"
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            disabled={busy}
          />
        </Row>
        <Row label={t('acct.confirmPassword')} htmlFor="acct-pw-confirm">
          <input
            id="acct-pw-confirm"
            type="password"
            className="io-input"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            disabled={busy}
          />
        </Row>
        <p className="dlg-note">{t('acct.passwordHint')}</p>
        {error ? (
          <p className="usr-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="usr-actions">
          <button type="submit" className="io-btn" disabled={busy || !current || !next}>
            {t('acct.changePassword')}
          </button>
        </div>
      </form>
    </Section>
  );
}
