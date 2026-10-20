// JS lockdown for the user-script sandbox worker (docs/plans/user-scripts.md §2).
// Second line of defence: the worker's response CSP is the real network
// boundary; this removes the capabilities user code has no business with, so a
// missing header (custom proxy, dev server) still leaves fetch & co. unreachable.

/** Globals made unreachable before user code runs. */
export const BLOCKED_GLOBALS = [
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'WebSocketStream',
  'WebTransport',
  'EventSource',
  'importScripts',
  'indexedDB',
  'caches',
  'Worker',
  'SharedWorker',
  'BroadcastChannel',
  'MessageChannel',
  'postMessage',
  'Notification',
  'WebAssembly',
  'setTimeout',
  'setInterval',
  'queueMicrotask',
  'requestAnimationFrame',
  'navigator',
] as const;

/** The parts of a worker global scope lockdown uses (a fake one in tests). */
export interface LockdownScope {
  postMessage(message: unknown, options: { transfer: Transferable[] }): void;
  addEventListener(type: 'message', fn: (e: MessageEvent) => void): void;
}

export type SandboxPost = (message: unknown, transfer?: Transferable[]) => void;

/**
 * Captures `postMessage`, registers `onMessage` as the message listener, then
 * removes every name in BLOCKED_GLOBALS from `scope` and its prototype chain
 * (DedicatedWorkerGlobalScope.prototype, WorkerGlobalScope.prototype, ...).
 * Throws if any name is still reachable afterwards: the worker must not run
 * user code then (fails closed).
 */
export function lockdown(scope: LockdownScope, onMessage: (data: unknown) => void): SandboxPost {
  const send = scope.postMessage.bind(scope);
  const post: SandboxPost = (message, transfer = []) => send(message, { transfer });
  scope.addEventListener('message', (e) => onMessage(e.data));

  const target = scope as unknown as Record<string, unknown>;
  for (let proto = Object.getPrototypeOf(scope) as object | null; proto;) {
    if (proto === Object.prototype) break;
    for (const name of BLOCKED_GLOBALS) {
      const desc = Object.getOwnPropertyDescriptor(proto, name);
      if (desc?.configurable) delete (proto as Record<string, unknown>)[name];
    }
    proto = Object.getPrototypeOf(proto) as object | null;
  }
  for (const name of BLOCKED_GLOBALS) {
    const own = Object.getOwnPropertyDescriptor(scope, name);
    if (!own || own.configurable) {
      Object.defineProperty(scope, name, {
        value: undefined,
        writable: false,
        enumerable: false,
        configurable: false,
      });
    } else if ('value' in own && own.writable) {
      target[name] = undefined;
    }
  }
  const left = BLOCKED_GLOBALS.filter((name) => target[name] !== undefined);
  if (left.length > 0)
    throw new Error(`Sandbox lockdown failed: ${left.join(', ')} still reachable`);
  return post;
}
