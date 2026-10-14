// @vitest-environment node
import { describe, expect, it } from 'vitest';

/** The slice of `node:fs` this test uses (the engine is typed without @types/node). */
interface Fs {
  readFileSync(path: URL, encoding: 'utf8'): string;
  existsSync(path: URL): boolean;
}

const nodeModule = (name: string) => import(/* @vite-ignore */ name) as Promise<unknown>;

/** Runtime (non-`import type`) relative imports and re-exports of a source file. */
function runtimeImports(fs: Fs, file: URL): URL[] {
  const text = fs.readFileSync(file, 'utf8');
  const out: URL[] = [];
  const re = /^\s*(import|export)\s+(type\s+)?([^'";]*?)\s*from\s*'(\.[^']+)'/gms;
  for (const m of text.matchAll(re)) {
    if (m[2]) continue; // `import type` / `export type`: erased
    const spec = m[4] ?? '';
    const hit = [new URL(`${spec}.ts`, file), new URL(`${spec}/index.ts`, file)].find((u) =>
      fs.existsSync(u),
    );
    if (!hit) throw new Error(`cannot resolve ${spec} from ${file.pathname}`);
    out.push(hit);
  }
  return out;
}

describe('@investopen/engine/node', () => {
  it('runs without DOM globals', () => {
    expect(typeof globalThis.document).toBe('undefined');
    expect(typeof globalThis.window).toBe('undefined');
    expect('OffscreenCanvas' in globalThis).toBe(false);
  });

  it('exports the feed stack, symbols, anchor mapping and calendar', async () => {
    const mod = await import('@investopen/engine/node');
    for (const name of [
      'HttpDataFeed',
      'ResamplingFeed',
      'ExpressionFeed',
      'SyntheticFeed',
      'FeedError',
      'canonicalSymbol',
      'parseSymbolExpression',
      'timeToLogical',
      'logicalToTime',
      'stepTime',
      'buildTradingCalendar',
      'createTzConverter',
      'parseInterval',
      'formatInterval',
      'intervalSeconds',
    ]) {
      expect(typeof (mod as Record<string, unknown>)[name], name).toBe('function');
    }
    expect(mod.canonicalSymbol('aapl / msft')).toBe('AAPL/MSFT');
  });

  it('never reaches chart, render, canvas or interaction code at runtime', async () => {
    const fs = (await nodeModule('node:fs')) as Fs;
    const root = new URL('./', import.meta.url);
    const seen = new Set<string>();
    const stack = [new URL('node.ts', root)];
    while (stack.length) {
      const f = stack.pop() as URL;
      if (seen.has(f.href)) continue;
      seen.add(f.href);
      stack.push(...runtimeImports(fs, f));
    }
    const rel = [...seen].map((h) => h.slice(root.href.length)).sort();
    const banned =
      /^(chart|pane|options|style|events)\.ts$|^(render|interaction|studies|transforms|model)\/|^drawings\/(tools|layer|interaction|registry|draw-utils|geometry)/;
    expect(rel.filter((f) => banned.test(f))).toEqual([]);
    expect(rel).toContain('feed/http-feed.ts');
    expect(rel).toContain('drawings/mapping.ts');
    expect(rel).toContain('drawings/calendar.ts');
  });
});
