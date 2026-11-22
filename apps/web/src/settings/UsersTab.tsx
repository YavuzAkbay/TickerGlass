import { KeyRound, Trash2, UserPlus } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { errorMessage } from '../api/client';
import type { UserRole } from '../api/auth';
import {
  createUser,
  deleteUser,
  listUsers,
  setUserPassword,
  updateUser,
  type UserRow,
} from '../api/users';
import { useAuthStore } from '../store/auth';
import { useT } from '../i18n';
import { confirmDialog, promptName } from '../ui/Prompt';
import { toast } from '../ui/Toast';
import { Row, Section } from '../dialogs/controls';
import {
  identityLine,
  newUserBody,
  newUserProblem,
  passwordProblem,
  roleChanged,
  rowGuards,
  sortUsers,
} from './usersModel';

/** Settings → Users (admins): list, create local users, rename, role, disable, reset password, delete. */
export function UsersTab() {
  const t = useT();
  const selfId = useAuthStore((s) => s.info?.user?.id ?? null);
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Row with an action under way (its buttons are disabled). */
  const [busyId, setBusyId] = useState<string | null>(null);
  /** Row whose password reset form is open. */
  const [resetId, setResetId] = useState<string | null>(null);

  const reload = () =>
    listUsers().then(
      (rows) => {
        setUsers(rows);
        setError(null);
      },
      (err: unknown) => setError(errorMessage(err)),
    );

  useEffect(() => {
    void reload();
  }, []);

  /** Run a row action; any failure (a 409 explains itself in `detail`) is shown, then the list refreshes. */
  const act = async (id: string, run: () => Promise<unknown>) => {
    setBusyId(id);
    try {
      await run();
    } catch (err) {
      toast(t('users.fail', { error: errorMessage(err) }), 'error', 6000);
    } finally {
      setBusyId(null);
      await reload();
    }
  };

  if (error && !users)
    return (
      <Section title={t('settings.tab.users')}>
        <p className="dlg-note">{error}</p>
      </Section>
    );
  if (!users)
    return (
      <Section title={t('settings.tab.users')}>
        <p className="dlg-note">…</p>
      </Section>
    );

  const rename = async (u: UserRow) => {
    const name = await promptName({
      title: t('users.renameTitle'),
      label: t('acct.name'),
      initial: u.name,
    });
    if (!name || name === u.name) return;
    await act(u.id, () => updateUser(u.id, { name }));
  };

  const remove = async (u: UserRow) => {
    const yes = await confirmDialog({
      title: t('users.deleteTitle'),
      message: t('users.deleteText', { name: u.name }),
      okLabel: t('users.delete'),
      danger: true,
    });
    if (yes) await act(u.id, () => deleteUser(u.id));
  };

  return (
    <>
      <Section title={t('settings.tab.users')}>
        <ul className="usr-list" aria-label={t('settings.tab.users')}>
          {sortUsers(users).map((u) => {
            const g = rowGuards(u, users, selfId);
            const busy = busyId === u.id;
            return (
              <li key={u.id} className={`usr-row${u.disabled ? ' disabled' : ''}`}>
                <div className="usr-main">
                  <span className="usr-name">
                    {u.name}
                    {g.self ? <span className="usr-tag">{t('users.you')}</span> : null}
                    {u.disabled ? (
                      <span className="usr-tag usr-tag-off">{t('users.disabled')}</span>
                    ) : null}
                  </span>
                  <span className="usr-sub">{identityLine(u)}</span>
                  <span className="usr-sub">
                    {u.lastSeenAt
                      ? t('users.lastSeen', { when: new Date(u.lastSeenAt).toLocaleString() })
                      : t('users.neverSeen')}
                  </span>
                </div>
                <select
                  className="io-input dlg-select usr-role"
                  aria-label={t('users.roleOf', { name: u.name })}
                  value={u.role}
                  disabled={busy || (u.role === 'admin' && !g.canDemote)}
                  title={
                    g.lastAdmin
                      ? t('users.lastAdminHint')
                      : g.self
                        ? t('users.selfHint')
                        : undefined
                  }
                  onChange={(e) => {
                    const role = e.target.value as UserRole;
                    if (roleChanged(u, role)) void act(u.id, () => updateUser(u.id, { role }));
                  }}
                >
                  <option value="user">{t('users.role.user')}</option>
                  <option value="admin">{t('users.role.admin')}</option>
                </select>
                <div className="usr-buttons">
                  <button
                    type="button"
                    className="io-btn"
                    disabled={busy}
                    onClick={() => void rename(u)}
                  >
                    {t('users.rename')}
                  </button>
                  <button
                    type="button"
                    className="io-btn"
                    disabled={busy}
                    aria-label={t('users.resetPasswordOf', { name: u.name })}
                    title={t('users.resetPassword')}
                    onClick={() => setResetId(resetId === u.id ? null : u.id)}
                  >
                    <KeyRound size={14} />
                  </button>
                  <button
                    type="button"
                    className="io-btn"
                    disabled={busy || (!u.disabled && !g.canDisable)}
                    title={!u.disabled && g.lastAdmin ? t('users.lastAdminHint') : undefined}
                    onClick={() =>
                      void act(u.id, () => updateUser(u.id, { disabled: !u.disabled }))
                    }
                  >
                    {u.disabled ? t('users.enable') : t('users.disable')}
                  </button>
                  <button
                    type="button"
                    className="io-btn"
                    disabled={busy || !g.canDelete}
                    aria-label={t('users.deleteOf', { name: u.name })}
                    title={
                      g.lastAdmin
                        ? t('users.lastAdminHint')
                        : g.self
                          ? t('users.selfHint')
                          : t('users.delete')
                    }
                    onClick={() => void remove(u)}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
                {resetId === u.id ? (
                  <ResetPassword
                    user={u}
                    onDone={() => setResetId(null)}
                    onCancel={() => setResetId(null)}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
        {error ? (
          <p className="usr-error" role="alert">
            {error}
          </p>
        ) : null}
      </Section>
      <CreateUser onCreated={() => void reload()} />
    </>
  );
}

function ResetPassword({
  user,
  onDone,
  onCancel,
}: {
  user: UserRow;
  onDone: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const problem = passwordProblem(password);
    if (problem) {
      setError(t(problem));
      return;
    }
    setBusy(true);
    setError(null);
    setUserPassword(user.id, password)
      .then(() => {
        toast(t('users.passwordReset', { name: user.name }), 'success');
        onDone();
      })
      .catch((err) => {
        setBusy(false);
        setError(errorMessage(err));
      });
  };

  return (
    <form className="usr-inline" onSubmit={submit}>
      <input
        type="password"
        className="io-input"
        autoComplete="new-password"
        autoFocus
        aria-label={t('users.newPasswordOf', { name: user.name })}
        placeholder={t('acct.newPassword')}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        disabled={busy}
      />
      <button type="submit" className="io-btn io-btn-primary" disabled={busy || !password}>
        {t('users.resetPassword')}
      </button>
      <button type="button" className="io-btn" onClick={onCancel} disabled={busy}>
        {t('users.cancel')}
      </button>
      {error ? (
        <p className="usr-error" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}

function CreateUser({ onCreated }: { onCreated: () => void }) {
  const t = useT();
  const [username, setUsername] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<UserRole>('user');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const draft = { username, name, password, role };
    const problem = newUserProblem(draft);
    if (problem) {
      setError(t(problem));
      return;
    }
    setBusy(true);
    setError(null);
    createUser(newUserBody(draft))
      .then((row) => {
        toast(t('users.created', { name: row?.name ?? username.trim() }), 'success');
        setUsername('');
        setName('');
        setPassword('');
        setRole('user');
        onCreated();
      })
      .catch((err) => setError(errorMessage(err))) // 409: username taken
      .finally(() => setBusy(false));
  };

  return (
    <Section title={t('users.add')}>
      <form onSubmit={submit}>
        <Row label={t('users.username')} htmlFor="usr-new-username">
          <input
            id="usr-new-username"
            className="io-input"
            value={username}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            onChange={(e) => setUsername(e.target.value)}
            disabled={busy}
          />
        </Row>
        <Row label={t('acct.name')} htmlFor="usr-new-name">
          <input
            id="usr-new-name"
            className="io-input"
            value={name}
            placeholder={t('users.namePlaceholder')}
            autoComplete="off"
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
          />
        </Row>
        <Row label={t('acct.password')} htmlFor="usr-new-password">
          <input
            id="usr-new-password"
            type="password"
            className="io-input"
            value={password}
            autoComplete="new-password"
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
          />
        </Row>
        <Row label={t('acct.role')} htmlFor="usr-new-role">
          <select
            id="usr-new-role"
            className="io-input dlg-select"
            value={role}
            onChange={(e) => setRole(e.target.value as UserRole)}
            disabled={busy}
          >
            <option value="user">{t('users.role.user')}</option>
            <option value="admin">{t('users.role.admin')}</option>
          </select>
        </Row>
        <p className="dlg-note">{t('acct.passwordHint')}</p>
        {error ? (
          <p className="usr-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="usr-actions">
          <button
            type="submit"
            className="io-btn io-btn-primary"
            disabled={busy || !username.trim() || !password}
          >
            <UserPlus size={14} /> {t('users.create')}
          </button>
        </div>
      </form>
    </Section>
  );
}
