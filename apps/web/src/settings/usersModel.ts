/** Pure helpers of Settings → Users and Account (docs/design/multi-user.md). */

import type { UserRole } from '../api/auth';
import type { NewUser, UserRow } from '../api/users';
import type { MessageKey } from '../i18n';

/** The API rejects shorter passwords (design: min length 10). */
export const MIN_PASSWORD_LENGTH = 10;

/** Message key for why `password` is not acceptable, or null. */
export function passwordProblem(password: string): MessageKey | null {
  return password.length < MIN_PASSWORD_LENGTH ? 'acct.error.passwordShort' : null;
}

/** Message key for why the change-password form cannot be sent, or null. */
export function changePasswordProblem(
  current: string,
  next: string,
  confirm: string,
): MessageKey | null {
  if (!current) return 'acct.error.currentRequired';
  const short = passwordProblem(next);
  if (short) return short;
  if (next !== confirm) return 'acct.error.mismatch';
  return null;
}

/** Message key for why a new user cannot be created yet, or null. Trims names. */
export function newUserProblem(u: NewUser): MessageKey | null {
  if (!u.username.trim()) return 'users.error.usernameRequired';
  return passwordProblem(u.password);
}

/** The body for `POST /users`: trimmed, the display name defaulting to the username. */
export function newUserBody(u: NewUser): NewUser {
  const username = u.username.trim();
  return { username, name: u.name.trim() || username, password: u.password, role: u.role };
}

/** Admins first, then by name (case-insensitive). Does not mutate. */
export function sortUsers(users: readonly UserRow[]): UserRow[] {
  return [...users].sort(
    (a, b) =>
      Number(b.role === 'admin') - Number(a.role === 'admin') ||
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
  );
}

export interface RowGuards {
  self: boolean;
  /** The only enabled admin: it cannot be demoted, disabled or deleted. */
  lastAdmin: boolean;
  canDemote: boolean;
  canDisable: boolean;
  canDelete: boolean;
}

/**
 * Which row actions the UI offers. Mirrors the API rule (409 for the last enabled admin
 * or yourself); the API's answer stays authoritative and is shown when it disagrees.
 */
export function rowGuards(
  user: UserRow,
  users: readonly UserRow[],
  selfId: string | null,
): RowGuards {
  const self = user.id === selfId;
  const enabledAdmins = users.filter((u) => u.role === 'admin' && !u.disabled);
  const lastAdmin = user.role === 'admin' && !user.disabled && enabledAdmins.length <= 1;
  return {
    self,
    lastAdmin,
    canDemote: !self && !lastAdmin,
    canDisable: !self && !lastAdmin,
    canDelete: !self && !lastAdmin,
  };
}

/** Whether `role` differs from the row's (a no-op role change is not sent). */
export const roleChanged = (user: UserRow, role: UserRole): boolean => user.role !== role;

/** "username · email · password, oidc" — the identity line under a user's name. */
export function identityLine(user: UserRow): string {
  return [user.username, user.email, user.methods.join(', ')].filter(Boolean).join(' · ');
}

/** Replace the row with `next` (matched by id); the list is unchanged without a match. */
export function replaceUser(users: readonly UserRow[], next: UserRow): UserRow[] {
  return users.map((u) => (u.id === next.id ? next : u));
}
