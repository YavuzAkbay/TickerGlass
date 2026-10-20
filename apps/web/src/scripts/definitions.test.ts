import { IndicatorRegistry, defaultRegistry } from '@investopen/indicators';
import { beforeEach, describe, expect, it } from 'vitest';
import type { UserScript } from '../api/types';
import { syncScriptDefinitions, userScriptProblem } from './definitions';
import { useScriptsStore } from './store';

const manifest = (id: string, name = 'My MA'): Record<string, unknown> => ({
  id: `user:${id}`,
  name,
  shortName: 'MyMA',
  category: 'movingAverage',
  overlay: true,
  inputs: { length: { kind: 'int', label: 'Length', default: 10, min: 1 } },
  outputs: [{ type: 'plot', id: 'ma', title: 'MA', kind: 'line', color: '#4f6bed' }],
});

const script = (id: string, o: Partial<UserScript> = {}): UserScript => ({
  id,
  name: id,
  source: `// ${id}`,
  manifest: manifest(id),
  apiVersion: 1,
  revision: 1,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...o,
});

describe('syncScriptDefinitions', () => {
  let reg: IndicatorRegistry;
  beforeEach(() => {
    reg = new IndicatorRegistry();
  });

  it('registers stubs and reports new scripts as changed', () => {
    expect(syncScriptDefinitions([script('a'), script('b')], reg)).toEqual(['a', 'b']);
    expect(reg.get('user:a')?.name).toBe('My MA');
    expect(() => reg.get('user:a')!.setup({} as never)).toThrow();
  });

  it('reports nothing when unchanged', () => {
    const list = [script('a')];
    syncScriptDefinitions(list, reg);
    const def = reg.get('user:a');
    expect(syncScriptDefinitions([script('a', { revision: 2 })], reg)).toEqual([]);
    expect(reg.get('user:a')).toBe(def);
  });

  it('replaces the stub when the manifest changes and reloads on source change alone', () => {
    syncScriptDefinitions([script('a')], reg);
    expect(
      syncScriptDefinitions([script('a', { manifest: manifest('a', 'Renamed') })], reg),
    ).toEqual(['a']);
    expect(reg.get('user:a')?.name).toBe('Renamed');
    const def = reg.get('user:a');
    expect(
      syncScriptDefinitions(
        [script('a', { manifest: manifest('a', 'Renamed'), source: 'x' })],
        reg,
      ),
    ).toEqual(['a']);
    expect(reg.get('user:a')?.name).toBe('Renamed');
    expect(reg.get('user:a')).not.toBe(def);
  });

  it('unregisters deleted scripts', () => {
    syncScriptDefinitions([script('a'), script('b')], reg);
    expect(syncScriptDefinitions([script('b')], reg)).toEqual(['a']);
    expect(reg.get('user:a')).toBeUndefined();
    expect(reg.get('user:b')).toBeDefined();
  });

  it('registers nothing for a null or invalid manifest, and drops an earlier stub', () => {
    expect(
      syncScriptDefinitions(
        [script('a', { manifest: null }), script('b', { manifest: { id: 'user:b', bogus: 1 } })],
        reg,
      ),
    ).toEqual(['a', 'b']);
    expect(reg.list()).toHaveLength(0);
    syncScriptDefinitions([script('c')], reg);
    expect(syncScriptDefinitions([script('c', { manifest: null })], reg)).toEqual(['c']);
    expect(reg.get('user:c')).toBeUndefined();
  });

  it('forces the registry id to the script id', () => {
    syncScriptDefinitions([script('a', { manifest: manifest('other') })], reg);
    expect(reg.get('user:a')).toBeDefined();
  });
});

describe('userScriptProblem', () => {
  beforeEach(() => {
    syncScriptDefinitions([], defaultRegistry);
    useScriptsStore.setState({ scripts: [], loaded: false });
  });

  it('is undefined for builtins and before scripts are loaded', () => {
    expect(userScriptProblem('sma')).toBeUndefined();
    expect(userScriptProblem('user:gone')).toBeUndefined();
  });

  it('reports deleted and broken scripts', () => {
    const ok = script('ok');
    const bad = script('bad', { manifest: null });
    useScriptsStore.getState().setScripts([ok, bad]);
    syncScriptDefinitions([ok, bad]);
    expect(userScriptProblem('user:ok')).toBeUndefined();
    expect(userScriptProblem('user:bad')).toBe('Script has errors – open it in the editor');
    expect(userScriptProblem('user:gone')).toBe('Script deleted');
    syncScriptDefinitions([]);
  });
});
