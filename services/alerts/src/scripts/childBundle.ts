/**
 * The script child's entry file. Production: `scripthost.js` next to the service bundle (the
 * build script emits it, with `isolate.js`). Dev, tests and a checkout without a build bundle
 * it on demand with esbuild (a devDependency: never needed in the image) into a per-process
 * cache directory inside `node_modules`, so that `isolated-vm` resolves from there.
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadIsolateBundle } from './isolateBundle';

let cached: Promise<string> | null = null;

export function childEntry(): Promise<string> {
  if (!import.meta.url.endsWith('.ts'))
    return Promise.resolve(fileURLToPath(new URL('./scripthost.js', import.meta.url)));
  cached ??= buildChildEntry();
  return cached;
}

async function buildChildEntry(): Promise<string> {
  const { build } = await import('esbuild');
  const dir = fileURLToPath(
    new URL(`../../node_modules/.cache/scripthost-${process.pid}/`, import.meta.url),
  );
  removeStale(fileURLToPath(new URL('../../node_modules/.cache/', import.meta.url)));
  mkdirSync(dir, { recursive: true });
  process.once('exit', () => rmSync(dir, { recursive: true, force: true }));
  const outfile = `${dir}scripthost.mjs`;
  await build({
    entryPoints: [fileURLToPath(new URL('./child.ts', import.meta.url))],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    external: ['isolated-vm', 'esbuild'],
    outfile,
    logLevel: 'silent',
  });
  writeFileSync(`${dir}isolate.js`, await loadIsolateBundle());
  return outfile;
}

/** Directories of earlier processes that ended without cleaning up (a killed test worker). */
function removeStale(root: string): void {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return;
  }
  for (const name of names) {
    const pid = /^scripthost-(\d+)$/.exec(name)?.[1];
    if (pid === undefined) continue;
    try {
      process.kill(Number(pid), 0);
    } catch {
      rmSync(`${root}${name}`, { recursive: true, force: true });
    }
  }
}
