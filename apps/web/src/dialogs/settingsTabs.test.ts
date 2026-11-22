import { describe, expect, it } from 'vitest';
import { parseAuthState } from '../api/auth';
import { visibleTabs } from './SettingsDialog';

const ids = (raw: unknown) => visibleTabs(parseAuthState(raw)).map((t) => t.id);

describe('visibleTabs', () => {
  it('older API or open mode without a user: neither Account nor Users', () => {
    expect(ids({ enabled: false })).not.toContain('account');
    expect(ids({ enabled: false })).not.toContain('users');
    expect(visibleTabs(null).map((t) => t.id)).not.toContain('users');
  });

  it('a signed-in user gets Account; only admins who can manage users get Users', () => {
    const user = { id: 'u', name: 'U', role: 'user' };
    expect(ids({ enabled: true, authed: true, user })).toContain('account');
    expect(ids({ enabled: true, authed: true, user })).not.toContain('users');
    expect(
      ids({
        enabled: true,
        authed: true,
        user: { ...user, role: 'admin' },
        canManageUsers: true,
      }),
    ).toContain('users');
  });
});
