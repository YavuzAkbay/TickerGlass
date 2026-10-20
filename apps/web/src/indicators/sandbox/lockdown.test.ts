import { describe, expect, it } from 'vitest';
import { BLOCKED_GLOBALS, lockdown } from './lockdown';

type Listener = (e: MessageEvent) => void;

/** Fresh fake scope classes per test: lockdown mutates their prototypes. */
function fakeScope() {
  /** Stand-in for WorkerGlobalScope.prototype: methods and getters live here. */
  class FakeWorkerGlobalScope {
    posted: [unknown, Transferable[]][] = [];
    listeners: Listener[] = [];
    addEventListener(_type: 'message', fn: Listener) {
      this.listeners.push(fn);
    }
    postMessage(message: unknown, options: { transfer: Transferable[] }) {
      this.posted.push([message, options.transfer]);
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
  }
  /** Stand-in for DedicatedWorkerGlobalScope: interface objects are own properties. */
  class FakeDedicatedScope extends FakeWorkerGlobalScope {
    queueMicrotask() {}
  }
  const scope = new FakeDedicatedScope();
  for (const name of ['XMLHttpRequest', 'WebSocket', 'Worker', 'WebAssembly', 'indexedDB']) {
    Object.defineProperty(scope, name, {
      value: function Blocked() {},
      writable: true,
      enumerable: false,
      configurable: true,
    });
  }
  return { scope, dedicated: FakeDedicatedScope.prototype, base: FakeWorkerGlobalScope.prototype };
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
    const { scope } = fakeScope();
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
    scope.listeners[0]!({ data: { seq: 3 } } as MessageEvent);
    expect(received).toEqual([{ seq: 3 }]);
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

  it('overwrites a non-configurable but writable global', () => {
    const { scope } = fakeScope();
    Object.defineProperty(scope, 'caches', { value: {}, writable: true, configurable: false });
    lockdown(scope, () => {});
    expect(lookup(scope, 'caches')).toBeUndefined();
  });
});
