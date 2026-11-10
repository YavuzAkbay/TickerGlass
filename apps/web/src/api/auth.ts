/** Optional password auth (docs/self-hosting.md): the app shows a login screen
 * when the server has AUTH_PASSWORD set and this browser has no session. */

import { getJson, requestJson } from './client';

export interface AuthState {
  enabled: boolean;
  authed: boolean;
}

export function fetchAuthState(): Promise<AuthState> {
  return getJson<AuthState>('/auth/state');
}

/** 204 sets the session cookie; 401 wrong password; 429 locked out. */
export function login(password: string): Promise<void> {
  return requestJson('POST', '/auth/login', { password });
}

export function logout(): Promise<void> {
  return requestJson('POST', '/auth/logout');
}
