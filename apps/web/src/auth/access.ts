import type { AuthState } from '../api/auth';
import { useAuthStore } from '../store/auth';

/**
 * Whether admin-only controls (cache clear, backup, provider switch and test, manual
 * screener runs, shared list edits) are shown. Permissive when the role is unknown
 * (older API, open mode without a user, server unreachable): the API enforces regardless.
 */
export function isAdminInfo(info: Pick<AuthState, 'user'> | null | undefined): boolean {
  const role = info?.user?.role;
  return role === undefined || role === null || role === 'admin';
}

/** `isAdminInfo` of the current auth state; re-renders when it changes. */
export function useIsAdmin(): boolean {
  return useAuthStore((s) => isAdminInfo(s.info));
}
