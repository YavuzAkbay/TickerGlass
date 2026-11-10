/* TickerGlass service worker: makes the app installable and gives the shell an
   offline fallback (docs/self-hosting.md). Deliberately minimal: navigations are
   network-first (a reload always picks up a new build) with the cached shell as
   the offline answer; hashed build assets are cache-first; /api and /ws are
   never touched — market data and user data stay strictly live. */

const CACHE = 'tickerglass-shell-v1';
const SHELL = '/';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.add(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name !== CACHE) await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const path = url.pathname;
  // The API, the live socket and the sandboxed user-script worker (its CSP is the
  // security boundary) go straight to the network, untouched.
  if (
    path.startsWith('/api') ||
    path === '/ws' ||
    /^\/assets\/sandbox-worker-[^/]+\.js$/.test(path)
  ) {
    return;
  }

  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req);
          const cache = await caches.open(CACHE);
          cache.put(SHELL, fresh.clone());
          return fresh;
        } catch {
          const cache = await caches.open(CACHE);
          return (await cache.match(SHELL)) ?? Response.error();
        }
      })(),
    );
    return;
  }

  if (path.startsWith('/assets/')) {
    // Content-hashed filenames: immutable, cache-first.
    event.respondWith(
      (async () => {
        const cached = await caches.match(req);
        if (cached) return cached;
        const fresh = await fetch(req);
        if (fresh.ok) (await caches.open(CACHE)).put(req, fresh.clone());
        return fresh;
      })(),
    );
  }
});
