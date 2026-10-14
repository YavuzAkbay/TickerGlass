import { ApiError, isRetryable } from '../api/client';

/**
 * The API could not be reached or failed transiently (network/proxy error,
 * 5xx, 408, 429): keep the change locally and retry. Other errors are permanent.
 */
export const isTransient = isRetryable;

export const isNotFound = (err: unknown): boolean => err instanceof ApiError && err.status === 404;

/** Storage that never throws (quota, disabled storage, node tests). */
export interface SafeStorage {
  get: (key: string) => string | null;
  set: (key: string, value: string) => boolean;
  remove: (key: string) => void;
}

export function safeStorage(
  storage:
    Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | undefined = globalThis.localStorage,
): SafeStorage {
  return {
    get: (key) => {
      try {
        return storage?.getItem(key) ?? null;
      } catch {
        return null;
      }
    },
    set: (key, value) => {
      try {
        storage?.setItem(key, value);
        return !!storage;
      } catch {
        return false;
      }
    },
    remove: (key) => {
      try {
        storage?.removeItem(key);
      } catch {
        // Nothing to clean up.
      }
    },
  };
}

/** JSON.parse that returns null for missing or unreadable data. */
export function readJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
