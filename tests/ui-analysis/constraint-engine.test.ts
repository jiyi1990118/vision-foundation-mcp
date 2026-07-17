import { describe, expect, it } from 'vitest';
import { inferConstraints } from '../../src/ui-analysis/constraint/constraint-engine.js';
import type { SemanticAST } from '../../src/ui-analysis/ir/types.js';

describe('constraint-engine', () => {
  it('infers row direction and a positive gap for horizontally arranged children', () => {
    const ast: SemanticAST = {
      root: {
        id: 'row',
        type: 'container',
        bbox: { x: 0, y: 0, w: 120, h: 30 },
        props: {},
        children: [
          { id: 'a', type: 'button', bbox: { x: 0, y: 0, w: 40, h: 30 }, props: {}, children: [] },
          { id: 'b', type: 'button', bbox: { x: 50, y: 0, w: 40, h: 30 }, props: {}, children: [] },
          { id: 'c', type: 'button', bbox: { x: 100, y: 0, w: 20, h: 30 }, props: {}, children: [] },
        ],
      },
      version: '1.0.0',
    };

    const constraints = inferConstraints(ast);
    expect(constraints).toHaveLength(1);
    const ct = constraints[0]!;
    expect(ct.targetId).toBe('row');
    expect(ct.direction).toBe('row');
    expect(ct.gap).toBeGreaterThan(0);
    expect(ct.align).toBe('top');
  });

  it('infers column direction for vertically stacked children', () => {
    const ast: SemanticAST = {
      root: {
        id: 'col',
        type: 'container',
        bbox: { x: 0, y: 0, w: 30, h: 120 },
        props: {},
        children: [
          { id: 'a', type: 'button', bbox: { x: 0, y: 0, w: 30, h: 40 }, props: {}, children: [] },
          { id: 'b', type: 'button', bbox: { x: 0, y: 50, w: 30, h: 40 }, props: {}, children: [] },
        ],
      },
      version: '1.0.0',
    };

    const constraints = inferConstraints(ast);
    expect(constraints[0]!.direction).toBe('column');
    expect(constraints[0]!.align).toBe('left');
  });

  it('grid direction uses the vertical (row) gap only, not the mixed x+y median', () => {
    // Two diagonally placed children -> neither axis aligned -> 'grid'.
    // Vertical row gap = 360 - (80 + 28) = 252; horizontal gap = 320 - 220 = 100.
    // The bug mixed x+y -> median([252, 100]) = 176; the fix uses vertical only = 252.
    const ast: SemanticAST = {
      root: {
        id: 'grid',
        type: 'container',
        bbox: { x: 100, y: 50, w: 300, h: 350 },
        props: {},
        children: [
          { id: 'a', type: 'input', bbox: { x: 120, y: 80, w: 100, h: 28 }, props: {}, children: [] },
          { id: 'b', type: 'button', bbox: { x: 320, y: 360, w: 60, h: 30 }, props: {}, children: [] },
        ],
      },
      version: '1.0.0',
    };
    const ct = inferConstraints(ast)[0]!;
    expect(ct.direction).toBe('grid');
    expect(ct.gap).toBe(252);
  });
});
