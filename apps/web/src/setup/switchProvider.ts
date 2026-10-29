/**
 * Switch the data provider from the app: confirm, `POST /providers/active`, flush what is
 * unsaved, reload the page. The API clears its cached market data, so the page starts clean.
 */
import { clearJsonCache, errorMessage } from '../api/client';
import {
  getProviders,
  setActiveProvider,
  type ProviderInfo,
  type ProvidersResponse,
} from '../api/provider';
import { getPersistence } from '../persist/bootstrap';
import { confirmDialog } from '../ui/Prompt';
import { toast } from '../ui/Toast';

/**
 * This tab is switching the provider itself: the API's `provider.changed` notice (sent to
 * every tab) must not offer it a "Reload" it is about to do anyway.
 */
let switchingHere = false;

export const isSwitchingHere = (): boolean => switchingHere;

export interface SwitchDeps {
  /** Default: `location.reload()`. */
  reload?: () => void;
  /** Default: the confirm dialog. */
  confirm?: (opts: { title: string; message: string; okLabel: string }) => Promise<boolean>;
  /**
   * Runs after the confirmation and before the request: drop what must not be saved by the
   * flush that follows (e.g. a dialog's uncommitted previews). A throw cancels the switch.
   */
  beforeSwitch?: () => void | Promise<void>;
}

/** What the confirmation says: the cache goes, and a metered plan pays for the refill. */
export function switchMessage(target: ProviderInfo): string {
  let msg = `Cached market data will be cleared and reloaded from ${target.name}. The page will reload.`;
  if (target.budget.daily !== null)
    msg += ` Reloading charts and quotes uses credits of your ${target.plan ?? target.name} plan.`;
  return msg;
}

/**
 * After a failed request: did the API switch anyway (the response was lost, or it timed out
 * after committing)? Asks the API afresh, past the `/providers` cache.
 */
async function switchedAnyway(target: ProviderInfo): Promise<boolean> {
  try {
    clearJsonCache();
    return (await getProviders()).active === target.id;
  } catch {
    return false;
  }
}

/** Save what is unsaved, then reload (the unload handlers send what is left). */
export async function flushAndReload(reload: () => void = () => location.reload()): Promise<void> {
  try {
    await getPersistence()?.flushAll();
  } catch (err) {
    console.warn('provider switch: saving before the reload failed', err);
  }
  reload();
}

/**
 * Ask, switch to `target`, reload. Resolves true once the switch happened (the reload is then
 * under way), false when cancelled or refused (a toast carries the server's reason).
 */
export async function chooseProvider(
  target: ProviderInfo,
  info: Pick<ProvidersResponse, 'active'>,
  deps: SwitchDeps = {},
): Promise<boolean> {
  if (switchingHere || info.active === target.id) return false;
  const confirm = deps.confirm ?? confirmDialog;
  const ok = await confirm({
    title: `Switch to ${target.name}?`,
    message: switchMessage(target),
    okLabel: 'Switch',
  });
  if (!ok) return false;
  switchingHere = true;
  try {
    await deps.beforeSwitch?.();
  } catch (err) {
    switchingHere = false;
    toast(errorMessage(err), 'error', 6000);
    return false;
  }
  try {
    await setActiveProvider(target.id);
  } catch (err) {
    if (!(await switchedAnyway(target))) {
      switchingHere = false;
      toast(errorMessage(err), 'error', 6000);
      return false;
    }
  }
  // The flag stays set: the reload ends this page's life.
  await flushAndReload(deps.reload);
  return true;
}

/** Test hook: forget that this tab was switching. */
export function resetSwitchingHere(): void {
  switchingHere = false;
}
