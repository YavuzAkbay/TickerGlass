import { describe, expect, it } from 'vitest';
import { parseUserRow, type UserRow } from '../api/users';
import {
  changePasswordProblem,
  identityLine,
  newUserBody,
  newUserProblem,
  passwordProblem,
  replaceUser,
  roleChanged,
  rowGuards,
  sortUsers,
} from './usersModel';
import { en } from '../i18n/en';

const row = (over: Partial<UserRow> = {}): UserRow => ({
  id: 'u',
  name: 'User',
  email: null,
  role: 'user',
  disabled: false,
  createdAt: null,
  lastSeenAt: null,
  methods: ['password'],
  username: 'user',
  ...over,
});

describe('password rules', () => {
  it('needs 10 characters', () => {
    expect(passwordProblem('123456789')).toBe('acct.error.passwordShort');
    expect(passwordProblem('1234567890')).toBeNull();
  });

  it('change form: current, length, match, in that order', () => {
    expect(changePasswordProblem('', 'x', 'x')).toBe('acct.error.currentRequired');
    expect(changePasswordProblem('old', 'short', 'short')).toBe('acct.error.passwordShort');
    expect(changePasswordProblem('old', 'long-enough-1', 'long-enough-2')).toBe(
      'acct.error.mismatch',
    );
    expect(changePasswordProblem('old', 'long-enough-1', 'long-enough-1')).toBeNull();
  });

  it('every message key exists', () => {
    for (const k of [
      'acct.error.passwordShort',
      'acct.error.currentRequired',
      'acct.error.mismatch',
    ])
      expect(en).toHaveProperty(k);
  });
});

describe('new user', () => {
  it('needs a username and a long enough password', () => {
    const base = { username: ' ', name: '', password: 'x'.repeat(10), role: 'user' as const };
    expect(newUserProblem(base)).toBe('users.error.usernameRequired');
    expect(newUserProblem({ ...base, username: 'ada', password: 'short' })).toBe(
      'acct.error.passwordShort',
    );
    expect(newUserProblem({ ...base, username: 'ada' })).toBeNull();
  });

  it('body trims and defaults the name to the username', () => {
    expect(
      newUserBody({ username: ' ada ', name: ' ', password: 'x'.repeat(10), role: 'admin' }),
    ).toEqual({ username: 'ada', name: 'ada', password: 'x'.repeat(10), role: 'admin' });
    expect(
      newUserBody({ username: 'ada', name: ' Ada L ', password: 'p', role: 'user' }).name,
    ).toBe('Ada L');
  });
});

describe('list helpers', () => {
  it('sorts admins first, then by name; does not mutate', () => {
    const list = [
      row({ id: '1', name: 'zed' }),
      row({ id: '2', name: 'Bob', role: 'admin' }),
      row({ id: '3', name: 'amy' }),
    ];
    expect(sortUsers(list).map((u) => u.id)).toEqual(['2', '3', '1']);
    expect(list[0]!.id).toBe('1');
  });

  it('replaces by id', () => {
    const list = [row({ id: '1' }), row({ id: '2' })];
    expect(replaceUser(list, row({ id: '2', name: 'New' }))[1]!.name).toBe('New');
    expect(replaceUser(list, row({ id: '9' }))).toEqual(list);
  });

  it('role changes and identity line', () => {
    expect(roleChanged(row(), 'user')).toBe(false);
    expect(roleChanged(row(), 'admin')).toBe(true);
    expect(identityLine(row({ email: 'a@b.c', methods: ['password', 'oidc'] }))).toBe(
      'user · a@b.c · password, oidc',
    );
    expect(identityLine(row({ username: null, methods: [] }))).toBe('');
  });
});

describe('rowGuards', () => {
  const admin = row({ id: 'a', role: 'admin' });
  const other = row({ id: 'b' });

  it('the only enabled admin cannot be demoted, disabled or deleted', () => {
    const g = rowGuards(admin, [admin, other], 'x');
    expect(g).toMatchObject({
      lastAdmin: true,
      canDemote: false,
      canDisable: false,
      canDelete: false,
    });
  });

  it('a second admin frees the first', () => {
    const second = row({ id: 'c', role: 'admin' });
    expect(rowGuards(admin, [admin, second], 'x')).toMatchObject({
      lastAdmin: false,
      canDemote: true,
      canDelete: true,
    });
    // A disabled admin does not count as a spare.
    expect(rowGuards(admin, [admin, { ...second, disabled: true }], 'x').lastAdmin).toBe(true);
  });

  it('you cannot change yourself', () => {
    const second = row({ id: 'c', role: 'admin' });
    expect(rowGuards(admin, [admin, second], 'a')).toMatchObject({
      self: true,
      canDemote: false,
      canDisable: false,
      canDelete: false,
    });
  });

  it('plain users are unrestricted', () => {
    expect(rowGuards(other, [admin, other], 'a')).toMatchObject({
      canDemote: true,
      canDisable: true,
      canDelete: true,
    });
  });
});

describe('parseUserRow', () => {
  it('reads the API shape and tolerates gaps', () => {
    expect(
      parseUserRow({
        id: 'u1',
        name: 'Ada',
        email: 'a@b.c',
        role: 'admin',
        disabled: true,
        createdAt: '2026-01-01T00:00:00Z',
        lastSeenAt: null,
        methods: ['password', 3],
        username: 'ada',
      }),
    ).toEqual({
      id: 'u1',
      name: 'Ada',
      email: 'a@b.c',
      role: 'admin',
      disabled: true,
      createdAt: '2026-01-01T00:00:00Z',
      lastSeenAt: null,
      methods: ['password'],
      username: 'ada',
    });
    expect(parseUserRow({ id: 'u2', role: 'root' })).toMatchObject({ role: 'user', name: 'u2' });
    expect(parseUserRow({ name: 'no id' })).toBeNull();
    expect(parseUserRow(null)).toBeNull();
  });
});
