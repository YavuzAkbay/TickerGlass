import { create } from 'zustand';
import { onUnauthorized } from '../api/client';
import { fetchAuthState, type AuthState } from '../api/auth';
import { clearAutoRedirect } from '../auth/loginPlan';

/** The auth gate: 'checking' until `/auth/state` answered, 'login' while the
 * server requires credentials this browser does not have, 'ready' once the app
 * may run (authed, or auth disabled, or the server unreachable). */
export type AuthStatus = 'checking' | 'login' | 'ready';

interface AuthStore {
  status: AuthStatus;
  /** Last `/auth/state` answer; null until it arrived (or when the server was unreachable). */
  info: AuthState | null;
  set: (status: AuthStatus) => void;
  setInfo: (info: AuthState | null) => void;
}

export const useAuthStore = create<AuthStore>((set) => ({
  status: 'checking',
  info: null,
  set: (status) => set({ status }),
  setInfo: (info) => set({ info }),
}));

/** Gate decision for a `/auth/state` answer. */
export function statusFor(s: AuthState): AuthStatus {
  return s.enabled && !s.authed ? 'login' : 'ready';
}

let started = false;
let unsubscribe: (() => void) | null = null;

/** Fetch the auth state once and subscribe to 401s. Idempotent. */
export function initAuth(): void {
  if (started) return;
  started = true;
  unsubscribe = onUnauthorized(() => {
    const { status, info, set, setInfo } = useAuthStore.getState();
    if (status === 'login') return;
    set('login');
    // Auth got enabled after boot: learn which sign-in methods to offer.
    if (!info)
      void fetchAuthState()
        .then(setInfo)
        .catch(() => undefined);
  });
  void fetchAuthState()
    .then((s) => {
      const { setInfo, set } = useAuthStore.getState();
      setInfo(s);
      set(statusFor(s));
      if (s.authed) clearAutoRedirect(); // signed in: a later sign-out may redirect again
    })
    .catch(() => {
      // Server unreachable: show the app; its offline states explain. If a 401
      // arrives later (auth got enabled), onUnauthorized flips to the login screen.
      useAuthStore.getState().set('ready');
    });
}

/** Test hook: forget the one-time init. */
export function resetAuthForTest(): void {
  started = false;
  unsubscribe?.();
  unsubscribe = null;
  useAuthStore.setState({ status: 'checking', info: null });
}
