// JS lockdown for the user-script sandbox worker (docs/indicators.md §5a).
// Second line of defence: the worker's response CSP is the real network
// boundary; this removes the capabilities user code has no business with, so a
// missing header (custom proxy, dev server) still leaves fetch & co. unreachable.
// It also removes the ways to schedule work in the background that JS can
// remove (timers, async I/O callbacks). That does not stop a script from
// pinning a core: a rejected `import()` and some events cannot be removed, so
// background work can continue between watchdog pings (docs/LIMITATIONS.md).

/** Globals made unreachable before user code runs. */
export const BLOCKED_GLOBALS = [
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'WebSocketStream',
  'WebTransport',
  'EventSource',
  'Request',
  'Response',
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
  'scheduler',
  'Scheduler',
  'FileReader',
  'FileReaderSync',
  'createImageBitmap',
  'OffscreenCanvas',
  'fonts',
  'FontFace',
  'PerformanceObserver',
  'FinalizationRegistry',
  'onunhandledrejection',
  'onrejectionhandled',
  'ReportingObserver',
  'VideoDecoder',
  'VideoEncoder',
  'AudioDecoder',
  'AudioEncoder',
  'ImageDecoder',
  'navigator',
] as const;

/**
 * Members of objects that stay reachable, removed too: `[owner, member]`,
 * `owner` a dotted path from the scope. All of them schedule a callback or
 * settle a promise from a task (background work between watchdog pings).
 */
export const BLOCKED_MEMBERS = [
  ['AbortSignal', 'timeout'],
  ['Atomics', 'waitAsync'],
  ['Blob.prototype', 'text'],
  ['Blob.prototype', 'arrayBuffer'],
  ['Blob.prototype', 'bytes'],
  ['Blob.prototype', 'stream'],
  ['Crypto.prototype', 'subtle'],
] as const;

/** The parts of a worker global scope lockdown uses (a fake one in tests). */
export interface LockdownScope {
  postMessage(message: unknown, options?: { transfer: Transferable[] }): void;
  addEventListener(type: 'message', fn: (e: MessageEvent) => void, capture: boolean): void;
  Event: new (type: string) => Event;
  MessageEvent: { prototype: MessageEvent };
  Error: ErrorConstructor;
}

export type SandboxPost = (message: unknown, transfer?: Transferable[]) => void;

/**
 * Captures `postMessage` and the `isTrusted` / `MessageEvent#data` getters,
 * registers `onMessage` as the first capturing message listener (it runs
 * before any listener user code adds, which could otherwise rewrite
 * `e.data`; trusted events only: a script's `dispatchEvent` cannot forge one), pins `Error.prepareStackTrace`
 * to undefined, then removes every name in BLOCKED_GLOBALS from `scope` and
 * its prototype chain (DedicatedWorkerGlobalScope.prototype,
 * WorkerGlobalScope.prototype, ...) and every BLOCKED_MEMBERS entry. Throws if
 * any is still reachable afterwards: the worker must not run user code then
 * (fails closed).
 */
export function lockdown(scope: LockdownScope, onMessage: (data: unknown) => void): SandboxPost {
  const apply = Reflect.apply;
  const defineProperty = Object.defineProperty;
  const send = scope.postMessage.bind(scope);
  const post: SandboxPost = (message, transfer = []) => {
    // No transfer list: nothing to convert, so nothing user code replaced is called.
    if (transfer.length === 0) {
      send(message);
      return;
    }
    // The list is read with the iteration protocol: give it its own iterator,
    // so a replaced Array.prototype[Symbol.iterator] is never consulted.
    const n = transfer.length;
    let i = 0;
    const iterator = {
      next: () =>
        i < n ? { value: transfer[i++], done: false } : { value: undefined, done: true },
    };
    defineProperty(transfer, Symbol.iterator, { value: () => iterator });
    send(message, { transfer });
  };
  const isTrusted = getterOf(new scope.Event('lockdown'), 'isTrusted');
  const dataOf = getterOf(scope.MessageEvent.prototype, 'data');
  if (!isTrusted || !dataOf) throw new Error('Sandbox lockdown failed: event getters not found');
  scope.addEventListener(
    'message',
    (e) => {
      // Only the browser's own events (the main thread's postMessage) are messages.
      if (apply(isTrusted, e, []) !== true) return;
      onMessage(apply(dataOf, e, []));
    },
    true,
  );
  pinPrepareStackTrace(scope.Error);

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
  for (const [path, member] of BLOCKED_MEMBERS) removeMember(ownerOf(scope, path), member);

  const left: string[] = BLOCKED_GLOBALS.filter((name) => target[name] !== undefined);
  for (const [path, member] of BLOCKED_MEMBERS)
    if (reachable(ownerOf(scope, path), member)) left.push(`${path}.${member}`);
  if (left.length > 0)
    throw new Error(`Sandbox lockdown failed: ${left.join(', ')} still reachable`);
  return post;
}

/** The getter of `name` on `obj` or its prototype chain. */
function getterOf(obj: object, name: string): ((this: unknown) => unknown) | undefined {
  for (let o: object | null = obj; o; o = Object.getPrototypeOf(o) as object | null) {
    const desc = Object.getOwnPropertyDescriptor(o, name);
    if (desc) return desc.get;
  }
  return undefined;
}

/**
 * V8 calls `Error.prepareStackTrace(err, callSites)` when a stack is read; a
 * call site's `getFunction()` hands out sloppy-mode functions of the stack.
 * Pinned to undefined (the default format, which `annotateError` parses) so
 * user code cannot install one.
 */
function pinPrepareStackTrace(error: ErrorConstructor): void {
  const desc = Object.getOwnPropertyDescriptor(error, 'prepareStackTrace');
  if (!desc || desc.configurable) {
    Object.defineProperty(error, 'prepareStackTrace', {
      value: undefined,
      writable: false,
      enumerable: false,
      configurable: false,
    });
  }
  const pinned = Object.getOwnPropertyDescriptor(error, 'prepareStackTrace');
  if (
    !pinned ||
    !('value' in pinned) ||
    pinned.value !== undefined ||
    pinned.writable ||
    pinned.configurable
  )
    throw new Error('Sandbox lockdown failed: Error.prepareStackTrace is not pinned');
}

/** The object at dotted `path` from `scope`, or undefined if this engine has none. */
function ownerOf(scope: LockdownScope, path: string): object | undefined {
  let o: unknown = scope;
  for (const key of path.split('.')) {
    if ((typeof o !== 'object' && typeof o !== 'function') || o === null) return undefined;
    o = (o as Record<string, unknown>)[key];
  }
  return (typeof o === 'object' || typeof o === 'function') && o !== null ? o : undefined;
}

const isRoot = (o: object) => o === Object.prototype || o === Function.prototype;

/** Delete `member` from `owner` and its prototype chain (overwrite it if only writable). */
function removeMember(owner: object | undefined, member: string): void {
  for (let o = owner ?? null; o && !isRoot(o); o = Object.getPrototypeOf(o) as object | null) {
    const desc = Object.getOwnPropertyDescriptor(o, member);
    if (!desc) continue;
    if (desc.configurable) delete (o as Record<string, unknown>)[member];
    else if ('value' in desc && desc.writable) (o as Record<string, unknown>)[member] = undefined;
  }
}

/**
 * `member` still resolves to something on `owner` (by descriptor: reading a
 * getter on a prototype would throw "Illegal invocation").
 */
function reachable(owner: object | undefined, member: string): boolean {
  for (let o = owner ?? null; o; o = Object.getPrototypeOf(o) as object | null) {
    const desc = Object.getOwnPropertyDescriptor(o, member);
    if (desc) return desc.get !== undefined || desc.value !== undefined;
  }
  return false;
}
