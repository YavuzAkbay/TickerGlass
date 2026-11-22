import { describe, expect, it } from 'vitest';
import { parseAuthState } from '../api/auth';
import { isAdminInfo } from './access';

const info = (user: unknown) => parseAuthState({ enabled: true, authed: true, user });

describe('isAdminInfo', () => {
  it('admins see admin controls', () => {
    expect(isAdminInfo(info({ name: 'A', id: '1', role: 'admin' }))).toBe(true);
  });

  it('plain users do not', () => {
    expect(isAdminInfo(info({ name: 'U', id: '2', role: 'user' }))).toBe(false);
  });

  it('is permissive when the role is unknown (older API, open mode, offline): the API enforces', () => {
    expect(isAdminInfo(null)).toBe(true);
    expect(isAdminInfo(info(null))).toBe(true);
    expect(isAdminInfo(info({ name: 'Old' }))).toBe(true);
  });
});
