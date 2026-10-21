import { defineConfig, type Connect, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const apiTarget = process.env.API_URL ?? 'http://localhost:8000';

/**
 * Response CSP of the user-script sandbox worker (docs/indicators.md §5a):
 * the real network boundary for user code. The built worker is one self-contained
 * file (sandboxWorkerSelfContained), so production allows no script loads at all,
 * not even same-origin `import()`. Keep in sync with docker/nginx.conf.
 */
const SANDBOX_CSP =
  "default-src 'none'; script-src 'unsafe-eval'; connect-src 'none'; worker-src 'none'";
/** Dev: Vite serves the worker as separate same-origin modules, so it needs 'self'. */
const SANDBOX_CSP_DEV =
  "default-src 'none'; script-src 'self' 'unsafe-eval'; connect-src 'none'; worker-src 'none'";
/** Dev module (served with a `?worker_file&type=module` query). */
const SANDBOX_WORKER_DEV_PATH = /^\/src\/indicators\/sandbox\/sandbox-worker\.ts$/;
/** Built asset; same pattern as the nginx location. */
const SANDBOX_WORKER_ASSET_PATH = /^\/assets\/sandbox-worker-[^/]+\.js$/;
const SANDBOX_WORKER_ENTRY = /[\\/]indicators[\\/]sandbox[\\/]sandbox-worker\.ts$/;

function cspMiddleware(path: RegExp, csp: string): Connect.NextHandleFunction {
  return (req, res, next) => {
    if (path.test((req.url ?? '').split('?')[0] ?? '')) {
      res.setHeader('Content-Security-Policy', csp);
    }
    next();
  };
}

/** Adds the sandbox CSP to the sandbox worker script in `vite dev` and `vite preview`. */
function sandboxCsp(): Plugin {
  return {
    name: 'tickerglass:sandbox-csp',
    // Registered before Vite's own middlewares, which send the response.
    configureServer: (server) =>
      void server.middlewares.use(cspMiddleware(SANDBOX_WORKER_DEV_PATH, SANDBOX_CSP_DEV)),
    configurePreviewServer: (server) =>
      void server.middlewares.use(cspMiddleware(SANDBOX_WORKER_ASSET_PATH, SANDBOX_CSP)),
  };
}

/** Directive the built sandbox worker starts with (its code must be strict on its own). */
const USE_STRICT = '"use strict";';

/**
 * Worker-build guard: the sandbox worker bundle must be exactly one chunk with no
 * static or dynamic imports, since its production CSP blocks every script load.
 * It also gets a `"use strict"` prologue: the IIFE output is a classic script,
 * strict today only because the worker is spawned with `type: 'module'`
 * (sloppy mode would let a stack trace hand user code the captured postMessage).
 * Fails the build otherwise.
 */
function sandboxWorkerSelfContained(): Plugin {
  const isSandboxEntry = (chunk: { isEntry: boolean; facadeModuleId: string | null }) =>
    chunk.isEntry && SANDBOX_WORKER_ENTRY.test(chunk.facadeModuleId ?? '');
  return {
    name: 'tickerglass:sandbox-worker-self-contained',
    renderChunk(code, chunk) {
      if (!isSandboxEntry(chunk) || code.startsWith(USE_STRICT)) return null;
      return { code: `${USE_STRICT}\n${code}`, map: null };
    },
    generateBundle(_options, bundle) {
      const files = Object.values(bundle);
      const entry = files.find((f) => f.type === 'chunk' && isSandboxEntry(f));
      if (!entry || entry.type !== 'chunk') return; // another worker
      if (!entry.code.startsWith(USE_STRICT))
        this.error(`sandbox worker must start with ${USE_STRICT} (${entry.fileName})`);
      const deps = [...entry.imports, ...entry.dynamicImports];
      const others = files.filter((f) => f !== entry && !f.fileName.endsWith('.map'));
      if (deps.length > 0 || others.length > 0) {
        this.error(
          `sandbox worker must be a single self-contained file (CSP script-src has no 'self'); ` +
            `it references or emits: ${[...deps, ...others.map((f) => f.fileName)].join(', ')}`,
        );
      }
    },
  };
}

/**
 * App-build guard: the emitted sandbox worker file must not mention any other
 * emitted file (asset URLs, chunks), since its production CSP loads nothing.
 */
function sandboxWorkerNoAssetRefs(): Plugin {
  return {
    name: 'tickerglass:sandbox-worker-no-asset-refs',
    apply: 'build',
    generateBundle(_options, bundle) {
      const files = Object.values(bundle);
      for (const worker of files) {
        if (!SANDBOX_WORKER_ASSET_PATH.test(`/${worker.fileName}`)) continue;
        const code = worker.type === 'chunk' ? worker.code : String(worker.source);
        const refs = files
          .map((f) => f.fileName.slice(f.fileName.lastIndexOf('/') + 1))
          .filter((name) => name !== worker.fileName.slice(worker.fileName.lastIndexOf('/') + 1))
          .filter((name) => code.includes(name));
        if (refs.length > 0) {
          this.error(
            `${worker.fileName} must be self-contained; it references: ${refs.join(', ')}`,
          );
        }
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), sandboxCsp(), sandboxWorkerNoAssetRefs()],
  worker: {
    // One classic-script file per worker: no chunk imports (sandboxWorkerSelfContained).
    format: 'iife',
    plugins: () => [sandboxWorkerSelfContained()],
  },
  build: {
    rolldownOptions: {
      output: {
        // React (rarely changes) and the chart engine in their own chunks: each stays
        // under the 500 kB warning and caches independently of app code.
        codeSplitting: {
          groups: [
            { name: 'react', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
            { name: 'engine', test: /packages[\\/]engine[\\/]/ },
          ],
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': apiTarget,
      '/ws': { target: apiTarget.replace(/^http/, 'ws'), ws: true },
    },
  },
});
