import { create } from 'zustand';
import { onUnauthorized } from '../api/client';
import { fetchAuthState } from '../api/auth';

/** The auth gate: 'checking' until `/auth/state` answered, 'login' while the
 * server requires credentials this browser does not have, 'ready' once the app
 * may run (authed, or auth disabled, or the server unreachable). */
export type AuthStatus = 'checking' | 'login' | 'ready';

interface AuthStore {
  status: AuthStatus;
  set: (status: AuthStatus) => void;
}

export const useAuthStore = create<AuthStore>((set) => ({
  status: 'checking',
  set: (status) => set({ status }),
}));

let started = false;

/** Fetch the auth state once and subscribe to 401s. Idempotent. */
export function initAuth(): void {
  if (started) return;
  started = true;
  onUnauthorized(() => {
    const { status, set } = useAuthStore.getState();
    if (status !== 'login') set('login');
  });
  void fetchAuthState()
    .then((s) => {
      useAuthStore.getState().set(s.enabled && !s.authed ? 'login' : 'ready');
    })
    .catch(() => {
      // Server unreachable: show the app; its offline states explain. If a 401
      // arrives later (auth got enabled), onUnauthorized flips to the login screen.
      useAuthStore.getState().set('ready');
    });
}
