import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- React.lazy's own constraint
type AnyComponent = ComponentType<any>;

export interface RetryableLazy<T extends AnyComponent> {
  /** The current lazy component. */
  get: () => LazyExoticComponent<T>;
  /** After a failed load: the next `get` starts a fresh import (React.lazy caches a rejection forever). */
  reset: () => void;
  /** The import, shared while it is in flight or succeeded; a failure is not cached. */
  load: () => Promise<{ default: T }>;
}

/** React.lazy that can retry a failed chunk import (offline, or a redeploy removed the chunk). */
export function retryableLazy<T extends AnyComponent>(
  importer: () => Promise<{ default: T }>,
): RetryableLazy<T> {
  let pending: Promise<{ default: T }> | null = null;
  const load = () =>
    (pending ??= importer().catch((err: unknown) => {
      pending = null;
      throw err;
    }));
  let current = lazy(load);
  return {
    get: () => current,
    reset: () => {
      current = lazy(load);
    },
    load,
  };
}
