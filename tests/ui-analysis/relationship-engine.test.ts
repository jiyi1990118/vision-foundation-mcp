import { describe, expect, it } from 'vitest';
import { inferRelationships } from '../../src/ui-analysis/relationship/relationship-engine.js';
import type { SemanticAST } from '../../src/ui-analysis/ir/types.js';

function makeAst(): SemanticAST {
  return {
    root: {
      id: 'page',
      type: 'page',
      bbox: { x: 0, y: 0, w: 100, h: 100 },
      props: {},
      children: [
        {
          id: 'c1',
          type: 'card',
          bbox: { x: 0, y: 0, w: 50, h: 50 },
          props: {},
          text: 'Title',
          children: [],
        },
        {
          id: 'c2',
          type: 'button',
          bbox: { x: 0, y: 60, w: 30, h: 20 },
          props: {},
          children: [],
        },
      ],
    },
    version: '1.0.0',
  };
}

describe('relationship-engine', () => {
  it('derives parent map, containment pairs, and text bindings', () => {
    const r = inferRelationships(makeAst());

    expect(r.parents['page']).toBeNull();
    expect(r.parents['c1']).toBe('page');
    expect(r.parents['c2']).toBe('page');

    expect(r.containment).toEqual([
      { parent: 'page', child: 'c1' },
      { parent: 'page', child: 'c2' },
    ]);

    expect(r.textBindings).toEqual([{ nodeId: 'c1', text: 'Title' }]);
  });
});
