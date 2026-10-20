import { useStore, type StoreApi, type UseBoundStore } from 'zustand';
import { useChartStore } from '../store/chart';
import type { ChartSession } from './session';

/**
 * A store with the API of one session store that always delegates to the
 * active chart's instance. UI call sites (dialogs, commands, the toolbar) use
 * these; per-chart code (attach*, controllers, chart/) must use explicit
 * session stores (enforced by ESLint no-restricted-imports).
 *
 * `detached` makes the store used while no chart exists (before mount, unit
 * tests); it is created on first use.
 *
 * `subscribe` follows the active chart: when the resolved store changes it
 * moves the listener over and notifies it once with the new state.
 */
export function createActiveFacade<T>(
  pick: (s: ChartSession) => StoreApi<T>,
  detached: () => StoreApi<T>,
): UseBoundStore<StoreApi<T>> {
  let fallback: StoreApi<T> | null = null;
  const resolve = (): StoreApi<T> => {
    const { sessions, activeId } = useChartStore.getState();
    const session = activeId === null ? undefined : sessions.get(activeId);
    return session ? pick(session) : (fallback ??= detached());
  };
  const api: StoreApi<T> = {
    getState: () => resolve().getState(),
    getInitialState: () => resolve().getInitialState(),
    setState: ((partial: never, replace?: never) =>
      resolve().setState(partial, replace)) as StoreApi<T>['setState'],
    subscribe: (listener) => {
      let cur = resolve();
      let off = cur.subscribe(listener);
      const offActive = useChartStore.subscribe(() => {
        const next = resolve();
        if (next === cur) return;
        const prev = cur.getState();
        off();
        cur = next;
        off = cur.subscribe(listener);
        listener(cur.getState(), prev);
      });
      return () => {
        off();
        offActive();
      };
    },
  };
  const hook = (<U>(selector?: (s: T) => U) =>
    useStore(api, selector as (s: T) => U)) as UseBoundStore<StoreApi<T>>;
  return Object.assign(hook, api);
}
