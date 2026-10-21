import { describe, expect, it } from 'vitest';
import { leaves, sumOf, type GridNode } from './grid';
import { balancedRows, MAX_CHARTS, TEMPLATES, template, templateIdFor } from './templates';

function sizesSumToOne(node: GridNode): boolean {
  if (node.kind === 'leaf') return true;
  return sumOf(node.sizes) === 1 && node.children.every(sizesSumToOne);
}

describe('grid templates', () => {
  it('every chart count 1..16 has a template with that many leaves', () => {
    for (let n = 1; n <= MAX_CHARTS; n++) {
      const t = template(n);
      expect(t, `n=${n}`).not.toBeNull();
      expect(leaves(t!)).toHaveLength(n);
      expect(sizesSumToOne(t!)).toBe(true);
      expect(templateIdFor(n)).not.toBeNull();
    }
    expect(template(0)).toBeNull();
    expect(template(17)).toBeNull();
    expect(template('nope')).toBeNull();
  });

  it('every listed template builds with its chart count and unique placeholder ids', () => {
    expect(new Set(TEMPLATES.map((t) => t.id)).size).toBe(TEMPLATES.length);
    for (const info of TEMPLATES) {
      const t = template(info.id)!;
      const ids = leaves(t);
      expect(ids, info.id).toHaveLength(info.count);
      expect(new Set(ids).size).toBe(ids.length);
      expect(sizesSumToOne(t)).toBe(true);
    }
    // Sorted by count for the picker.
    const counts = TEMPLATES.map((t) => t.count);
    expect(counts).toEqual([...counts].sort((a, b) => a - b));
  });

  it('includes the hand-picked set', () => {
    const ids = TEMPLATES.map((t) => t.id);
    for (const id of ['1', '2c', '2r', '1L+2', '2+1B', '2x2', '1L+4', '4+3', '3x3', '4x4'])
      expect(ids).toContain(id);
    expect(template('2c')).toMatchObject({ kind: 'split', dir: 'row' });
    expect(template('2r')).toMatchObject({ kind: 'split', dir: 'col' });
  });

  it('generates balanced rows for counts without a hand-picked template', () => {
    expect(balancedRows(11)).toEqual([4, 4, 3]);
    expect(balancedRows(13)).toEqual([5, 4, 4]);
    expect(balancedRows(14)).toEqual([5, 5, 4]);
    expect(balancedRows(15)).toEqual([5, 5, 5]);
    expect(templateIdFor(11)).toBe('rows-11');
    const t = template(13)!;
    expect(t.kind === 'split' && t.children.map((r) => leaves(r).length)).toEqual([5, 4, 4]);
  });

  it('marks uniform grids aligned', () => {
    for (const id of ['2x2', '3x2', '2x3', '3x3', '4x4', 'rows-15'])
      expect(template(id), id).toMatchObject({ kind: 'split', dir: 'col', aligned: true });
    expect(template('3+2')).not.toHaveProperty('aligned');
    expect(template('2c')).not.toHaveProperty('aligned');
  });
});
