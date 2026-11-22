import { afterEach, describe, expect, it, vi } from 'vitest';
import { leaveAfterLogout, loginBody, logout, parseAuthState } from '../api/auth';
import { initAuth, resetAuthForTest, statusFor, useAuthStore } from './auth';

afterEach(() => {
  vi.unstubAllGlobals();
  resetAuthForTest();
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('parseAuthState', () => {
  it('reads an older payload: password-only when enabled', () => {
    expect(parseAuthState({ enabled: true, authed: false })).toEqual({
      enabled: true,
      authed: false,
      methods: ['password'],
      oidcName: null,
      user: null,
      logoutAvailable: true,
      canManageUsers: false,
      localAccounts: false,
    });
    expect(parseAuthState({ enabled: false, authed: false }).methods).toEqual([]);
  });

  it('reads the current payload', () => {
    const s = parseAuthState({
      enabled: true,
      authed: true,
      methods: ['password', 'oidc', 'bogus'],
      oidcName: 'Authentik',
      user: {
        id: 'u1',
        role: 'admin',
        name: 'Ada',
        email: 'ada@example.com',
        method: 'oidc',
        isOwner: true,
      },
      logoutAvailable: false,
      canManageUsers: true,
      localAccounts: true,
    });
    expect(s.methods).toEqual(['password', 'oidc']);
    expect(s.oidcName).toBe('Authentik');
    expect(s.user).toEqual({
      id: 'u1',
      role: 'admin',
      name: 'Ada',
      email: 'ada@example.com',
      method: 'oidc',
      isOwner: true,
    });
    expect(s.logoutAvailable).toBe(false);
    expect(s.canManageUsers).toBe(true);
    expect(s.localAccounts).toBe(true);
  });

  it('an older user (no id or role) parses with nulls; an unknown role is dropped', () => {
    expect(parseAuthState({ user: { name: 'Ada' } }).user).toMatchObject({ id: null, role: null });
    expect(parseAuthState({ user: { name: 'A', id: 'x', role: 'root' } }).user).toMatchObject({
      id: 'x',
      role: null,
    });
  });

  it('survives garbage', () => {
    expect(parseAuthState(null).enabled).toBe(false);
    expect(parseAuthState({ enabled: true, user: { name: 3 } }).user).toBeNull();
    expect(parseAuthState({ user: { name: 'x', method: 'zzz' } }).user?.method).toBe('password');
  });
});

describe('loginBody', () => {
  it('sends the username only when one was typed (empty = bootstrap admin)', () => {
    expect(loginBody('pw')).toEqual({ password: 'pw' });
    expect(loginBody('pw', '')).toEqual({ password: 'pw' });
    expect(loginBody('pw', '  ')).toEqual({ password: 'pw' });
    expect(loginBody('pw', ' ada ')).toEqual({ username: 'ada', password: 'pw' });
  });
});

describe('statusFor', () => {
  it('gates only when enabled and not authed', () => {
    const base = parseAuthState({});
    expect(statusFor({ ...base, enabled: true, authed: false })).toBe('login');
    expect(statusFor({ ...base, enabled: true, authed: true })).toBe('ready');
    expect(statusFor({ ...base, enabled: false })).toBe('ready');
  });
});

describe('initAuth', () => {
  it('stores the parsed state and opens the login gate', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ enabled: true, authed: false, methods: ['oidc'], oidcName: 'Kc' })),
    );
    initAuth();
    await vi.waitFor(() => expect(useAuthStore.getState().status).toBe('login'));
    expect(useAuthStore.getState().info?.methods).toEqual(['oidc']);
  });

  it('lets the app run when the server is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('down');
      }),
    );
    initAuth();
    await vi.waitFor(() => expect(useAuthStore.getState().status).toBe('ready'));
    expect(useAuthStore.getState().info).toBeNull();
  });
});

describe('sign out', () => {
  it('logout resolves to the redirect, or null', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ redirect: 'https://idp.example/logout' })),
    );
    await expect(logout()).resolves.toBe('https://idp.example/logout');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ redirect: null })),
    );
    await expect(logout()).resolves.toBeNull();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 204 })),
    );
    await expect(logout()).resolves.toBeNull();
  });

  it('leaveAfterLogout follows the redirect, else reloads', () => {
    const nav = { assign: vi.fn(), reload: vi.fn() };
    leaveAfterLogout('https://idp.example/logout', nav);
    expect(nav.assign).toHaveBeenCalledWith('https://idp.example/logout');
    expect(nav.reload).not.toHaveBeenCalled();
    leaveAfterLogout(null, nav);
    expect(nav.reload).toHaveBeenCalledTimes(1);
  });
});
