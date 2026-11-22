import { describe, expect, it } from 'vitest';
import { en } from '../i18n/en';
import { authErrorKey, oidcLoginUrl, planLogin, readAuthError, stripAuthError } from './loginPlan';

describe('planLogin', () => {
  it('password only: form, no redirect', () => {
    expect(planLogin(['password'], null)).toEqual({
      password: true,
      username: false,
      oidc: false,
      proxyOnly: false,
      autoRedirect: false,
    });
  });

  it('username field only with the password form and local accounts', () => {
    const now = 1_000;
    expect(planLogin(['password'], null, null, now, true).username).toBe(true);
    expect(planLogin(['password', 'oidc'], null, null, now, true).username).toBe(true);
    expect(planLogin(['password'], null, null, now, false).username).toBe(false);
    expect(planLogin(['oidc'], null, null, now, true).username).toBe(false);
    expect(planLogin(['header'], null, null, now, true).username).toBe(false);
  });

  it('oidc only: redirects automatically unless an error was just shown', () => {
    expect(planLogin(['oidc'], null).autoRedirect).toBe(true);
    expect(planLogin(['oidc'], 'oidc_denied').autoRedirect).toBe(false);
    expect(planLogin(['oidc'], 'oidc_denied').oidc).toBe(true);
  });

  it('loop guard: no auto-redirect within a minute of the last one', () => {
    const now = 1_000_000;
    expect(planLogin(['oidc'], null, null, now).autoRedirect).toBe(true);
    expect(planLogin(['oidc'], null, now - 1_000, now).autoRedirect).toBe(false);
    expect(planLogin(['oidc'], null, now - 59_999, now).autoRedirect).toBe(false);
    expect(planLogin(['oidc'], null, now - 60_000, now).autoRedirect).toBe(true);
    // The button stays available while the redirect is held back.
    expect(planLogin(['oidc'], null, now - 1_000, now).oidc).toBe(true);
  });

  it('both: form and button, never auto-redirects', () => {
    const p = planLogin(['password', 'oidc'], null);
    expect(p).toMatchObject({ password: true, oidc: true, autoRedirect: false });
  });

  it('header only: tells the user to use the proxy', () => {
    expect(planLogin(['header'], null)).toMatchObject({
      password: false,
      oidc: false,
      proxyOnly: true,
      autoRedirect: false,
    });
  });

  it('header plus password still shows the form', () => {
    expect(planLogin(['header', 'password'], null)).toMatchObject({
      password: true,
      proxyOnly: false,
    });
  });

  it('falls back to the password form when no method is recognized', () => {
    expect(planLogin([], null)).toMatchObject({ password: true, proxyOnly: false });
  });
});

describe('auth_error handling', () => {
  it('reads and strips the param', () => {
    expect(readAuthError('?auth_error=oidc_state')).toBe('oidc_state');
    expect(readAuthError('?a=1')).toBeNull();
    expect(readAuthError('')).toBeNull();
    expect(stripAuthError('?auth_error=oidc_state')).toBe('');
    expect(stripAuthError('?a=1&auth_error=x&b=2')).toBe('?a=1&b=2');
    expect(stripAuthError('')).toBe('');
  });

  it('maps known codes to their message and unknown codes to the generic one', () => {
    for (const code of [
      'oidc_state',
      'oidc_exchange',
      'oidc_token',
      'oidc_denied',
      'oidc_unavailable',
    ])
      expect(authErrorKey(code)).toBe(`login.error.${code}`);
    expect(authErrorKey('whatever')).toBe('login.error.generic');
    expect(authErrorKey('__proto__')).toBe('login.error.generic');
    expect(en[authErrorKey('whatever')]).toMatch(/failed/);
  });
});

describe('oidcLoginUrl', () => {
  it('returns to the current path and query', () => {
    expect(oidcLoginUrl('/', '')).toBe('/api/auth/oidc/login?next=%2F');
    expect(oidcLoginUrl('/chart', '?s=AAPL&i=1D')).toBe(
      `/api/auth/oidc/login?next=${encodeURIComponent('/chart?s=AAPL&i=1D')}`,
    );
  });

  it('drops auth_error from next', () => {
    expect(oidcLoginUrl('/', '?auth_error=oidc_state')).toBe('/api/auth/oidc/login?next=%2F');
    expect(oidcLoginUrl('/x', '?a=1&auth_error=oidc_state')).toBe(
      `/api/auth/oidc/login?next=${encodeURIComponent('/x?a=1')}`,
    );
  });
});
