import type { AuthMethod } from '../api/auth';
import type { MessageKey as MsgKey } from '../i18n';

/** Error codes the API puts in `/?auth_error=` after a failed OIDC round trip. */
const ERROR_KEYS: Record<string, MsgKey> = {
  oidc_state: 'login.error.oidc_state',
  oidc_exchange: 'login.error.oidc_exchange',
  oidc_token: 'login.error.oidc_token',
  oidc_denied: 'login.error.oidc_denied',
  oidc_unavailable: 'login.error.oidc_unavailable',
};

/** The `auth_error` code in a query string, or null. */
export function readAuthError(search: string): string | null {
  return new URLSearchParams(search).get('auth_error') || null;
}

/** Message key for an `auth_error` code; unknown codes get the generic message. */
export function authErrorKey(code: string): MsgKey {
  return Object.hasOwn(ERROR_KEYS, code) ? ERROR_KEYS[code]! : 'login.error.generic';
}

/** `search` without `auth_error` ('' or '?a=b'), so a retry does not carry it. */
export function stripAuthError(search: string): string {
  const params = new URLSearchParams(search);
  params.delete('auth_error');
  const rest = params.toString();
  return rest ? `?${rest}` : '';
}

/** Full-page navigation target that starts the OIDC flow and returns to this page. */
export function oidcLoginUrl(pathname: string, search: string): string {
  const next = `${pathname}${stripAuthError(search)}`;
  return `/api/auth/oidc/login?next=${encodeURIComponent(next)}`;
}

/** `sessionStorage` key: when this tab last auto-redirected to the identity provider. */
export const AUTO_REDIRECT_KEY = 'tg.oidcAutoRedirectAt';
/** Within this window of the last auto-redirect the sign-in button is shown instead. */
export const AUTO_REDIRECT_WINDOW_MS = 60_000;

/** Time of this tab's last auto-redirect, or null. Storage that cannot be read counts as
 * "just now": without a loop guard it is safer to show the button than to redirect. */
export function readAutoRedirectAt(): number | null {
  try {
    const raw = sessionStorage.getItem(AUTO_REDIRECT_KEY);
    const at = raw === null ? NaN : Number(raw);
    return Number.isFinite(at) ? at : null;
  } catch {
    return Date.now();
  }
}

export function markAutoRedirect(now = Date.now()): void {
  try {
    sessionStorage.setItem(AUTO_REDIRECT_KEY, String(now));
  } catch {
    // Unwritable storage: nothing to remember; the redirect still happens once per load.
  }
}

/** Forget the attempt (the user is signed in, so a later sign-out may redirect again). */
export function clearAutoRedirect(): void {
  try {
    sessionStorage.removeItem(AUTO_REDIRECT_KEY);
  } catch {
    // Nothing stored, nothing to clear.
  }
}

export interface LoginPlan {
  password: boolean;
  /** Show the optional Username field: local accounts exist next to the bootstrap password. */
  username: boolean;
  oidc: boolean;
  /** Header-only server and the proxy did not authenticate this request: nothing to fill in. */
  proxyOnly: boolean;
  /** OIDC is the only way in, no error was just shown and we did not already redirect in the
   * last minute (loop guard): go straight to the IdP. */
  autoRedirect: boolean;
}

export function planLogin(
  methods: readonly AuthMethod[],
  authError: string | null,
  lastAutoRedirectAt: number | null = null,
  now: number = Date.now(),
  localAccounts = false,
): LoginPlan {
  const oidc = methods.includes('oidc');
  const header = methods.includes('header');
  // No recognized method at all (odd payload): the password form is the safe default.
  const password = methods.includes('password') || (!oidc && !header);
  return {
    password,
    username: password && localAccounts,
    oidc,
    proxyOnly: header && !password && !oidc,
    autoRedirect:
      oidc &&
      !password &&
      authError === null &&
      (lastAutoRedirectAt === null || now - lastAutoRedirectAt >= AUTO_REDIRECT_WINDOW_MS),
  };
}
