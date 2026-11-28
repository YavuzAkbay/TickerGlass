/**
 * Wrap an async action so calls made while one is still running are ignored
 * (key repeat, double Enter). Resolves to `undefined` for an ignored call.
 */
export function singleFlight<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>,
): (...args: A) => Promise<R | undefined> {
  let busy = false;
  return async (...args) => {
    if (busy) return undefined;
    busy = true;
    try {
      return await fn(...args);
    } finally {
      busy = false;
    }
  };
}
