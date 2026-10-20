/**
 * User-script sandbox worker (docs/indicators.md §5a): response CSP +
 * JS lockdown. Probes run real code in the worker via the dev hook
 * `window.sandboxProbe(code)` (apps/web/src/chart/ChartView.tsx).
 */
import type { Page, Worker } from '@playwright/test';
import { expect, test } from './fixtures';

interface ProbeResult {
  ok: boolean;
  value?: string;
  error?: string;
  line?: number;
  col?: number;
  terminated?: boolean;
}

declare global {
  interface Window {
    sandboxProbe(code: string, timeoutMs?: number): Promise<ProbeResult>;
  }
}

/**
 * Expected worker CSP per server (apps/web/vite.config.ts, docker/nginx.conf). Built
 * assets get no 'self' (the worker is one self-contained file); `vite dev` serves the
 * worker as separate same-origin modules and needs it.
 */
const CSP = {
  dev: "default-src 'none'; script-src 'self' 'unsafe-eval'; connect-src 'none'; worker-src 'none'",
  build: "default-src 'none'; script-src 'unsafe-eval'; connect-src 'none'; worker-src 'none'",
};
type Mode = keyof typeof CSP;

/** Same-origin URL the probes try to reach; any hit means the sandbox leaked. */
const LEAK = '/sandbox-leak';

async function ready(page: Page) {
  await page.goto('/');
  await page.waitForFunction(() => typeof window.sandboxProbe === 'function');
}

const probe = (page: Page, code: string, timeoutMs?: number) =>
  page.evaluate(([c, t]) => window.sandboxProbe(c, t), [code, timeoutMs] as const);

/** Runs a trivial probe; returns which server served the worker and its CSP header. */
async function workerResponse(page: Page): Promise<{ mode: Mode; csp: string | undefined }> {
  const response = page.waitForResponse((r) => r.url().includes('sandbox-worker'));
  expect(await probe(page, 'return 6 * 7;')).toEqual({ ok: true, value: '42' });
  const r = await response;
  const mode: Mode = new URL(r.url()).pathname.startsWith('/assets/') ? 'build' : 'dev';
  return { mode, csp: r.headers()['content-security-policy'] };
}

test.describe('user-script sandbox', () => {
  /** Requests that reached the network layer for the leak targets. */
  let leaks: string[];

  test.beforeEach(async ({ page, context }) => {
    leaks = [];
    const record = async (route: import('@playwright/test').Route) => {
      leaks.push(route.request().url());
      // Answer with a valid module: a load would succeed if the request were allowed.
      await route.fulfill({ contentType: 'text/javascript', body: 'export default 1;' });
    };
    await context.route(`**${LEAK}*`, record);
    await context.route('https://example.com/**', record);
    await context.routeWebSocket(`**${LEAK}*`, (ws) => {
      leaks.push(ws.url());
      ws.close();
    });
    await ready(page);
  });

  test.afterEach(() => {
    expect(leaks, 'requests from the sandbox').toEqual([]);
  });

  test('worker script is served with the sandbox CSP', async ({ page }) => {
    const { mode, csp } = await workerResponse(page);
    expect(csp).toBe(CSP[mode]);
  });

  test('same-origin import() is blocked in builds (dev-only exposure)', async ({ page }) => {
    const { mode } = await workerResponse(page);
    const hits: string[] = [];
    // Registered after the fixture's /api mock, so it wins for this URL.
    await page.route(
      (url) => url.pathname === '/api/layouts' && url.searchParams.get('x') === '1',
      async (route) => {
        hits.push(route.request().url());
        await route.fulfill({ contentType: 'text/javascript', body: 'export default 1;' });
      },
    );
    const r = await probe(
      page,
      "return import('/api/layouts?x=1').then(() => 'loaded', () => 'rejected');",
    );
    if (mode === 'build') {
      expect(r).toEqual({ ok: true, value: 'rejected' });
      expect(hits).toEqual([]);
    } else {
      // Documented limitation: `vite dev` needs script-src 'self', so a same-origin GET
      // goes through (response unreadable as data, nothing leaves the origin).
      test
        .info()
        .annotations.push({ type: 'dev-only exposure', description: 'same-origin import()' });
      expect(r).toEqual({ ok: true, value: 'loaded' });
      expect(hits).toHaveLength(1);
    }
  });

  test('network and capability globals are gone', async ({ page }) => {
    const names = [
      'fetch',
      'XMLHttpRequest',
      'WebSocket',
      'EventSource',
      'importScripts',
      'indexedDB',
      'caches',
      'Worker',
      'SharedWorker',
      'BroadcastChannel',
      'MessageChannel',
      'postMessage',
      'WebAssembly',
      'setTimeout',
      'setInterval',
      'queueMicrotask',
      'navigator',
    ];
    const code = `return JSON.stringify(${JSON.stringify(names)}.filter((n) => self[n] !== undefined
      || Object.getPrototypeOf(self)[n] !== undefined
      || Object.getPrototypeOf(Object.getPrototypeOf(self))[n] !== undefined));`;
    expect(await probe(page, code)).toEqual({ ok: true, value: '[]' });
  });

  test('fetch, XHR and WebSocket fail', async ({ page }) => {
    // Each probe settles on the request's outcome, so it only passes if the request
    // fails (lockdown: TypeError up front; CSP alone: error event / rejection).
    for (const code of [
      `return fetch('${LEAK}');`,
      `return self.fetch.call(self, '${LEAK}');`,
      `return new Promise((resolve, reject) => {
        const x = new XMLHttpRequest();
        x.onload = () => resolve('loaded');
        x.onerror = () => reject(new Error('xhr failed'));
        x.open('GET', '${LEAK}');
        x.send();
      });`,
      `return new Promise((resolve, reject) => {
        const s = new WebSocket('ws://' + location.host + '${LEAK}');
        s.onopen = () => resolve('opened');
        s.onerror = () => reject(new Error('ws failed'));
      });`,
    ]) {
      expect((await probe(page, code)).ok, code).toBe(false);
    }
  });

  test('import() of remote and data: modules is blocked by the CSP', async ({ page }) => {
    for (const url of ['https://example.com/x.js', 'data:text/javascript,export default 1']) {
      // Waits for the CSP violation event: proves the header, not the lockdown, blocked it
      // (import() cannot be removed in JS). Times out (ok: false) if no violation fires.
      const code = `
        const violation = new Promise((resolve) =>
          addEventListener('securitypolicyviolation', (e) => resolve(e.effectiveDirective)));
        return import(${JSON.stringify(url)})
          .then(() => 'loaded', () => 'rejected')
          .then((loaded) => violation.then((directive) => loaded + ' ' + directive));`;
      expect(await probe(page, code), url).toEqual({ ok: true, value: 'rejected script-src-elem' });
    }
  });

  test('new Function works (unsafe-eval)', async ({ page }) => {
    expect(await probe(page, `return new Function('a', 'return a * 2')(21);`)).toEqual({
      ok: true,
      value: '42',
    });
    expect(await probe(page, 'return eval("1 + 1");')).toEqual({ ok: true, value: '2' });
  });

  test('user code runs in strict mode', async ({ page }) => {
    expect(await probe(page, 'return (function () { return this; })() === undefined;')).toEqual({
      ok: true,
      value: 'true',
    });
  });

  test('error positions are user-source lines', async ({ page }) => {
    const r = await probe(page, 'const a = 1;\n\n  null.x;\nreturn a;');
    expect(r).toMatchObject({ ok: false, line: 3, col: 8 });
    expect(r.error).toMatch(/^TypeError: /);
    expect(await probe(page, "throw new Error('first line');")).toMatchObject({
      ok: false,
      error: 'Error: first line',
      line: 1,
      col: 7,
    });
  });

  test('terminate stops an endless loop', async ({ page }) => {
    const spawned = page.waitForEvent('worker', (w) => w.url().includes('sandbox-worker'));
    const result = probe(page, 'while (true) {}', 1000);
    const worker: Worker = await spawned;
    const closed = new Promise<void>((resolve) => worker.once('close', () => resolve()));
    expect(await result).toMatchObject({ ok: false, terminated: true });
    await closed; // the worker target is gone, not just ignored
    // The page stays responsive and a fresh sandbox still works.
    expect(await probe(page, 'return 1;')).toEqual({ ok: true, value: '1' });
  });
});
