import { describe, expect, it } from 'vitest';
import { BLOCKED_GLOBALS, BLOCKED_MEMBERS, lockdown } from './lockdown';

type Listener = (e: MessageEvent) => void;

/** Fresh fake scope classes per test: lockdown mutates their prototypes. */
function fakeScope() {
  /** Only `deliver` (the "browser") makes trusted events. */
  const trusted = new WeakSet<object>();
  class FakeEvent {
    constructor(readonly type: string) {}
    get isTrusted() {
      return trusted.has(this);
    }
  }
  const payload = new WeakMap<object, unknown>();
  class FakeMessageEvent extends FakeEvent {
    constructor(type: string, init: { data?: unknown } = {}) {
      super(type);
      payload.set(this, init.data);
    }
    get data() {
      return payload.get(this);
    }
  }
  class FakeAbortSignal {
    static timeout() {
      return new FakeAbortSignal();
    }
    static any() {
      return new FakeAbortSignal();
    }
  }
  class FakeBlob {
    text() {}
    arrayBuffer() {}
    bytes() {}
    stream() {}
    slice() {}
  }
  class FakeCrypto {
    get subtle() {
      return {};
    }
    getRandomValues() {}
  }
  const fakeError = function FakeError() {} as unknown as ErrorConstructor;

  /** Stand-in for WorkerGlobalScope.prototype: methods and getters live here. */
  class FakeWorkerGlobalScope {
    posted: [unknown, Transferable[]][] = [];
    listeners: { fn: Listener; capture: boolean }[] = [];
    Event = FakeEvent as unknown as new (type: string) => Event;
    MessageEvent = FakeMessageEvent as unknown as { prototype: MessageEvent };
    Error = fakeError;
    AbortSignal = FakeAbortSignal;
    Blob = FakeBlob;
    Crypto = FakeCrypto;
    crypto = new FakeCrypto();
    Atomics = { wait() {}, waitAsync() {} };
    addEventListener(_type: 'message', fn: Listener, capture = false) {
      this.listeners.push({ fn, capture });
    }
    /** At the target: capturing listeners first, each group in registration order. */
    dispatchEvent(e: FakeEvent) {
      const ordered = [
        ...this.listeners.filter((l) => l.capture),
        ...this.listeners.filter((l) => !l.capture),
      ];
      for (const l of ordered) l.fn(e as unknown as MessageEvent);
    }
    postMessage(message: unknown, options?: { transfer: Transferable[] }) {
      // Like WebIDL: the transfer list is read with the iteration protocol.
      const transfer = options ? Array.from(options.transfer as Iterable<Transferable>) : [];
      this.posted.push([message, transfer]);
    }
    fetch() {
      return 'fetched';
    }
    setTimeout() {
      return 1;
    }
    importScripts() {}
    get navigator() {
      return { userAgent: 'fake' };
    }
    get scheduler() {
      return { postTask() {} };
    }
  }
  /** Stand-in for DedicatedWorkerGlobalScope: interface objects are own properties. */
  class FakeDedicatedScope extends FakeWorkerGlobalScope {
    queueMicrotask() {}
  }
  const scope = new FakeDedicatedScope();
  for (const name of [
    'XMLHttpRequest',
    'WebSocket',
    'Worker',
    'WebAssembly',
    'indexedDB',
    'FileReader',
    'OffscreenCanvas',
  ]) {
    Object.defineProperty(scope, name, {
      value: function Blocked() {},
      writable: true,
      enumerable: false,
      configurable: true,
    });
  }
  /** A message from the main thread: a trusted event. */
  const deliver = (data: unknown) => {
    const e = new FakeMessageEvent('message', { data });
    trusted.add(e);
    scope.dispatchEvent(e);
  };
  return {
    scope,
    deliver,
    FakeMessageEvent,
    FakeBlob,
    FakeCrypto,
    FakeAbortSignal,
    dedicated: FakeDedicatedScope.prototype,
    base: FakeWorkerGlobalScope.prototype,
  };
}

const lookup = (scope: object, name: string) => (scope as Record<string, unknown>)[name];

describe('sandbox lockdown', () => {
  it('makes every blocked global undefined on the scope and its prototypes', () => {
    const { scope, dedicated, base } = fakeScope();
    lockdown(scope, () => {});
    for (const name of BLOCKED_GLOBALS) expect(lookup(scope, name), name).toBeUndefined();
    expect(lookup(base, 'fetch')).toBeUndefined();
    expect(lookup(base, 'postMessage')).toBeUndefined();
    expect(lookup(dedicated, 'queueMicrotask')).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(base, 'navigator')).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(base, 'scheduler')).toBeUndefined();
  });

  it('removes the background-scheduling members of objects that stay', () => {
    const { scope, FakeAbortSignal, FakeBlob, FakeCrypto } = fakeScope();
    lockdown(scope, () => {});
    expect(lookup(FakeAbortSignal, 'timeout')).toBeUndefined();
    expect(typeof FakeAbortSignal.any).toBe('function');
    for (const m of ['text', 'arrayBuffer', 'bytes', 'stream'])
      expect(lookup(new FakeBlob(), m), m).toBeUndefined();
    expect(typeof new FakeBlob().slice).toBe('function');
    expect(lookup(scope.crypto, 'subtle')).toBeUndefined();
    expect(typeof new FakeCrypto().getRandomValues).toBe('function');
    expect(lookup(scope.Atomics, 'waitAsync')).toBeUndefined();
    expect(typeof scope.Atomics.wait).toBe('function');
    expect(BLOCKED_MEMBERS.length).toBeGreaterThan(0);
  });

  it('cannot be undone by user code', () => {
    const { scope } = fakeScope();
    lockdown(scope, () => {});
    const target = scope as unknown as Record<string, unknown>;
    expect(() => {
      target.fetch = () => 'again';
    }).toThrow(TypeError);
    expect(() => Object.defineProperty(scope, 'WebSocket', { value: function Again() {} })).toThrow(
      TypeError,
    );
    expect(() => delete target.XMLHttpRequest).toThrow(TypeError);
    expect(target.fetch).toBeUndefined();
    expect(target.WebSocket).toBeUndefined();
  });

  it('keeps a working post and message listener captured before lockdown', () => {
    const { scope, deliver } = fakeScope();
    const received: unknown[] = [];
    const post = lockdown(scope, (data) => received.push(data));
    const buf = new ArrayBuffer(8);
    post({ type: 'ack', seq: 1 }, [buf]);
    post({ type: 'ack', seq: 2 });
    expect(scope.posted).toEqual([
      [{ type: 'ack', seq: 1 }, [buf]],
      [{ type: 'ack', seq: 2 }, []],
    ]);
    expect(scope.listeners).toHaveLength(1);
    deliver({ seq: 3 });
    expect(received).toEqual([{ seq: 3 }]);
  });

  it('runs before a capture listener user code adds, which cannot rewrite the message', () => {
    const { scope, deliver } = fakeScope();
    const received: string[] = [];
    lockdown(scope, (data) => received.push(JSON.stringify(data)));
    // User code: rewrites every message into a probe before it is handled.
    scope.addEventListener(
      'message',
      (e) => {
        (e.data as { msg: unknown }).msg = { type: 'probe', code: '' };
      },
      true,
    );
    deliver({ seq: 1, msg: { type: 'ping' } });
    expect(received).toEqual(['{"seq":1,"msg":{"type":"ping"}}']);
    expect(scope.listeners[0]!.capture).toBe(true);
  });

  it('posts even when user code broke the array iteration protocol', () => {
    const { scope } = fakeScope();
    const post = lockdown(scope, () => {});
    const buf = new ArrayBuffer(8);
    const original = Array.prototype[Symbol.iterator];
    Array.prototype[Symbol.iterator] = () => {
      throw new Error('broken');
    };
    try {
      post({ type: 'ack', seq: 1 });
      post({ type: 'results' }, [buf]);
    } finally {
      Array.prototype[Symbol.iterator] = original;
    }
    expect(scope.posted).toEqual([
      [{ type: 'ack', seq: 1 }, []],
      [{ type: 'results' }, [buf]],
    ]);
  });

  it('ignores synthetic events: dispatchEvent cannot forge a message', () => {
    const { scope, deliver, FakeMessageEvent } = fakeScope();
    const received: unknown[] = [];
    lockdown(scope, (data) => received.push(data));
    // User code: a forged ping, and a redefined data getter.
    scope.dispatchEvent(
      new FakeMessageEvent('message', { data: { seq: 1e300, msg: { type: 'ping' } } }),
    );
    Object.defineProperty(FakeMessageEvent.prototype, 'data', { get: () => ({ seq: 666 }) });
    Object.defineProperty(FakeMessageEvent.prototype, 'isTrusted', { get: () => true });
    scope.dispatchEvent(new FakeMessageEvent('message', { data: { seq: 7 } }));
    expect(received).toEqual([]);
    expect(scope.posted).toEqual([]);
    // Real messages still arrive, read through the original getter.
    deliver({ seq: 1 });
    expect(received).toEqual([{ seq: 1 }]);
  });

  it('pins Error.prepareStackTrace to undefined', () => {
    const { scope } = fakeScope();
    lockdown(scope, () => {});
    const E = scope.Error as unknown as Record<string, unknown>;
    expect(E.prepareStackTrace).toBeUndefined();
    expect(() => {
      E.prepareStackTrace = () => 'leak';
    }).toThrow(TypeError);
    expect(() =>
      Object.defineProperty(scope.Error, 'prepareStackTrace', { value: () => 'leak' }),
    ).toThrow(TypeError);
    expect(E.prepareStackTrace).toBeUndefined();
  });

  it('leaves unrelated members alone', () => {
    const { scope } = fakeScope();
    lockdown(scope, () => {});
    expect(typeof scope.addEventListener).toBe('function');
    expect(scope.posted).toEqual([]);
  });

  it('fails closed when a blocked global cannot be removed', () => {
    const { scope } = fakeScope();
    Object.defineProperty(scope, 'EventSource', {
      value: function Stuck() {},
      writable: false,
      configurable: false,
    });
    expect(() => lockdown(scope, () => {})).toThrow(/EventSource still reachable/);
  });

  it('fails closed when a blocked member cannot be removed', () => {
    const { scope, FakeBlob } = fakeScope();
    Object.defineProperty(FakeBlob.prototype, 'text', {
      value: () => {},
      writable: false,
      configurable: false,
    });
    expect(() => lockdown(scope, () => {})).toThrow(/Blob\.prototype\.text still reachable/);
  });

  it('fails closed when Error.prepareStackTrace is already set for good', () => {
    const { scope } = fakeScope();
    Object.defineProperty(scope.Error, 'prepareStackTrace', {
      value: () => 'leak',
      writable: false,
      configurable: false,
    });
    expect(() => lockdown(scope, () => {})).toThrow(/prepareStackTrace/);
  });

  it('overwrites a non-configurable but writable global', () => {
    const { scope } = fakeScope();
    Object.defineProperty(scope, 'caches', { value: {}, writable: true, configurable: false });
    lockdown(scope, () => {});
    expect(lookup(scope, 'caches')).toBeUndefined();
  });
});
