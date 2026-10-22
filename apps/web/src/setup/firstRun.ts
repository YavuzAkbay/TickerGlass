import { useUiStore } from '../store/ui';

/** Set once the first-run data source step was seen (this browser). */
export const SETUP_KEY = 'tickerglass-setup';

export function setupDone(): boolean {
  // Browser automation (e2e, screenshots) skips onboarding unless the URL asks for it.
  if (
    typeof navigator !== 'undefined' &&
    navigator.webdriver &&
    !new URLSearchParams(location.search).has('firstRun')
  )
    return true;
  try {
    return localStorage.getItem(SETUP_KEY) !== null;
  } catch {
    // Storage blocked: never nag on every load.
    return true;
  }
}

export function markSetupDone(): void {
  try {
    localStorage.setItem(SETUP_KEY, '1');
  } catch {
    // Storage blocked: nothing to remember.
  }
}

/** Show the data source step on the first visit. */
export function startFirstRun(): void {
  if (!setupDone()) useUiStore.getState().openDialog('dataSource', { firstRun: true });
}
