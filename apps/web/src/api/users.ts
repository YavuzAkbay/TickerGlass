/** Accounts (docs/design/multi-user.md, API surface): the signed-in user and admin user management. */

import { requestJson } from './client';
import { isUserRole, type UserRole } from './auth';

/** `GET /api/me`. */
export interface Me {
  id: string;
  name: string;
  email: string | null;
  role: UserRole;
  method: string;
  /** A local account with a password of its own (the password can be changed here). */
  localAccount: boolean;
}

/** One row of `GET /api/users` (never carries a password hash). */
export interface UserRow {
  id: string;
  name: string;
  email: string | null;
  role: UserRole;
  disabled: boolean;
  createdAt: string | null;
  lastSeenAt: string | null;
  /** Identity methods linked to the account (`password`, `oidc`, `header`). */
  methods: string[];
  /** Local sign-in name, when the account has one. */
  username: string | null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

export function parseMe(raw: unknown): Me | null {
  const m = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const id = str(m.id);
  if (!id) return null;
  return {
    id,
    name: str(m.name) ?? '',
    email: str(m.email),
    role: isUserRole(m.role) ? m.role : 'user',
    method: str(m.method) ?? 'password',
    localAccount: m.localAccount === true,
  };
}

export function parseUserRow(raw: unknown): UserRow | null {
  const u = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const id = str(u.id);
  if (!id) return null;
  return {
    id,
    name: str(u.name) ?? str(u.username) ?? id,
    email: str(u.email),
    role: isUserRole(u.role) ? u.role : 'user',
    disabled: u.disabled === true,
    createdAt: str(u.createdAt),
    lastSeenAt: str(u.lastSeenAt),
    methods: Array.isArray(u.methods)
      ? u.methods.filter((x): x is string => typeof x === 'string')
      : [],
    username: str(u.username),
  };
}

export const fetchMe = (): Promise<Me | null> => requestJson<unknown>('GET', '/me').then(parseMe);

export const renameMe = (name: string): Promise<Me | null> =>
  requestJson<unknown>('PATCH', '/me', { name }).then(parseMe);

/** 400 wrong current password or too short; 403 not a local account. */
export const changeMyPassword = (current: string, next: string): Promise<void> =>
  requestJson('PUT', '/me/password', { current, new: next });

export const listUsers = (): Promise<UserRow[]> =>
  requestJson<unknown>('GET', '/users').then((raw) =>
    (Array.isArray(raw) ? raw : []).flatMap((r) => parseUserRow(r) ?? []),
  );

export interface NewUser {
  username: string;
  name: string;
  password: string;
  role: UserRole;
}

/** 409 when the username is taken. */
export const createUser = (u: NewUser): Promise<UserRow | null> =>
  requestJson<unknown>('POST', '/users', u).then(parseUserRow);

/** 409 (with a `detail`) when it would remove the last admin or lock yourself out. */
export const updateUser = (
  id: string,
  patch: { name?: string; role?: UserRole; disabled?: boolean },
): Promise<UserRow | null> =>
  requestJson<unknown>('PATCH', `/users/${encodeURIComponent(id)}`, patch).then(parseUserRow);

export const setUserPassword = (id: string, next: string): Promise<void> =>
  requestJson('PUT', `/users/${encodeURIComponent(id)}/password`, { new: next });

export const deleteUser = (id: string): Promise<void> =>
  requestJson('DELETE', `/users/${encodeURIComponent(id)}`);
