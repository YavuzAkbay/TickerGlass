import { describe, expect, it } from 'vitest';
import { BUILTIN_INDICATORS } from '../src/builtins';
import type { AnyIndicatorDefinition } from '../src/registry';
import { GOLDEN_CASES, expectGolden, isCaseOf } from './golden-harness';

/** Longest registered id that is the case name or a `<id>-` prefix of it. */
function definitionFor(name: string): AnyIndicatorDefinition {
  const def = [...BUILTIN_INDICATORS]
    .filter((d) => isCaseOf(name, d.id))
    .sort((a, b) => b.id.length - a.id.length)[0];
  if (!def) throw new Error(`No indicator for golden case "${name}"`);
  return def;
}

describe('golden reference values', () => {
  it('has a golden case for every built-in', () => {
    const covered = new Set(GOLDEN_CASES.map((c) => definitionFor(c).id));
    expect(BUILTIN_INDICATORS.map((d) => d.id).filter((id) => !covered.has(id))).toEqual([]);
  });

  it.each(GOLDEN_CASES)('%s', (name) => {
    expectGolden(name, definitionFor(name));
  });
});
