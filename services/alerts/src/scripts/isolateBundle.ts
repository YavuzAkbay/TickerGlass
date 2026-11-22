/**
 * The isolate entry as one string of JS (`isolate-entry.ts` bundled with the
 * runtime and `ta`). Production reads `isolate.js` next to the service bundle
 * (the build script emits it). Dev, tests and a checkout without a build
 * bundle it on demand with esbuild (a devDependency: never needed in the image).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let cached: string | null = null;

export function isolateBuildOptions(entry: string) {
  return {
    entryPoints: [entry],
    bundle: true,
    format: 'iife' as const,
    platform: 'neutral' as const,
    target: 'es2022',
    legalComments: 'none' as const,
    // The runtime is shared with the browser: it must not need a DOM or Node API.
    logLevel: 'silent' as const,
  };
}

/** Whether this module runs from TypeScript sources (dev/tests) rather than the bundle. */
function fromSources(): boolean {
  return import.meta.url.endsWith('.ts');
}

export async function loadIsolateBundle(): Promise<string> {
  if (cached !== null) return cached;
  if (!fromSources()) {
    cached = readFileSync(fileURLToPath(new URL('./isolate.js', import.meta.url)), 'utf8');
    return cached;
  }
  const { build } = await import('esbuild');
  const entry = fileURLToPath(new URL('./isolate-entry.ts', import.meta.url));
  const res = await build({ ...isolateBuildOptions(entry), write: false });
  const file = res.outputFiles[0];
  if (!file) throw new Error('isolate bundle: esbuild produced no output');
  cached = file.text;
  return cached;
}
