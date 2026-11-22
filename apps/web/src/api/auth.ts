/** Server-side auth (docs/self-hosting.md): the app shows a login screen when
 * the server requires credentials this browser does not have (password, OIDC
 * single sign-on, or a trusted proxy header). */

import { getJson, requestJson } from './client';

export type AuthMethod = 'password' | 'oidc' | 'header';

export type UserRole = 'admin' | 'user';

export interface AuthUser {
  /** Stable user id; null on APIs that predate multi-user. */
  id: string | null;
  /** Null on APIs that predate multi-user (everyone counts as admin there). */
  role: UserRole | null;
  name: string;
  email: string | null;
  method: AuthMethod;
  /** The migrated Owner account (may claim a pre-multi-user browser cache). False on older APIs. */
  isOwner: boolean;
}

export interface AuthState {
  enabled: boolean;
  authed: boolean;
  /** How this server lets people in; `['password']` for older APIs that omit it. */
  methods: AuthMethod[];
  /** Display name of the OIDC provider, when the server configured one. */
  oidcName: string | null;
  user: AuthUser | null;
  /** Whether Sign out does anything (false for proxy-header sessions without a logout URL). */
  logoutAvailable: boolean;
  /** The signed-in user administers users (Settings → Users). False on older APIs. */
  canManageUsers: boolean;
  /** The password method is on: local accounts exist (username + password sign-in). */
  localAccounts: boolean;
}

const METHODS: readonly AuthMethod[] = ['password', 'oidc', 'header'];

export function isAuthMethod(v: unknown): v is AuthMethod {
  return typeof v === 'string' && (METHODS as readonly string[]).includes(v);
}

export function isUserRole(v: unknown): v is UserRole {
  return v === 'admin' || v === 'user';
}

function parseUser(raw: unknown): AuthUser | null {
  if (!raw || typeof raw !== 'object') return null;
  const u = raw as Record<string, unknown>;
  if (typeof u.name !== 'string' || !u.name) return null;
  return {
    id: typeof u.id === 'string' && u.id ? u.id : null,
    role: isUserRole(u.role) ? u.role : null,
    name: u.name,
    email: typeof u.email === 'string' && u.email ? u.email : null,
    method: isAuthMethod(u.method) ? u.method : 'password',
    isOwner: u.isOwner === true,
  };
}

/** Methods from a payload: unknown entries are dropped; an older API that omits
 * them is password-only when auth is on. */
export function parseMethods(raw: unknown, enabled: boolean): AuthMethod[] {
  if (Array.isArray(raw)) return raw.filter(isAuthMethod);
  return enabled ? ['password'] : [];
}

/** May this sign-in claim a legacy (ownerless) browser cache? Only the Owner account, or
 * anyone when auth is off (single user); older APIs without `isOwner` fail closed. */
export function canClaimLegacyCache(s: AuthState): boolean {
  return !s.enabled || s.user?.isOwner === true;
}

/** Tolerate both the old `{enabled, authed}` and the current `/auth/state` shape. */
export function parseAuthState(raw: unknown): AuthState {
  const s = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const enabled = s.enabled === true;
  return {
    enabled,
    authed: s.authed === true,
    methods: parseMethods(s.methods, enabled),
    oidcName: typeof s.oidcName === 'string' && s.oidcName ? s.oidcName : null,
    user: parseUser(s.user),
    logoutAvailable: typeof s.logoutAvailable === 'boolean' ? s.logoutAvailable : true,
    canManageUsers: s.canManageUsers === true,
    localAccounts: s.localAccounts === true,
  };
}

export function fetchAuthState(): Promise<AuthState> {
  return getJson<unknown>('/auth/state').then(parseAuthState);
}

/** Body of `POST /auth/login`: the username only when one was typed (empty = bootstrap admin). */
export function loginBody(
  password: string,
  username?: string,
): { password: string; username?: string } {
  const name = username?.trim();
  return name ? { username: name, password } : { password };
}

/** 204 sets the session cookie; 401 wrong credentials; 429 locked out. */
export function login(password: string, username?: string): Promise<void> {
  return requestJson('POST', '/auth/login', loginBody(password, username));
}

/** Ends the session. Resolves to the URL to leave for (an identity provider's or
 * proxy's logout page), or null to just reload. */
export function logout(): Promise<string | null> {
  return requestJson<unknown>('POST', '/auth/logout').then((body) => {
    const redirect = (body as { redirect?: unknown } | null | undefined)?.redirect;
    return typeof redirect === 'string' && redirect ? redirect : null;
  });
}

/** Where the browser goes after a sign-out: the server's `redirect`, else a reload. */
export function leaveAfterLogout(
  redirect: string | null,
  nav: { assign: (url: string) => void; reload: () => void } = location,
): void {
  if (redirect) nav.assign(redirect);
  else nav.reload();
}
