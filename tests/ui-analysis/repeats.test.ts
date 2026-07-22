import { describe, expect, it } from 'vitest';
import { detectRepeats } from '../../src/ui-analysis/repeats/index.js';
import type { ASTNode, SemanticAST } from '../../src/ui-analysis/ir/types.js';

function ast(root: ASTNode): SemanticAST {
  return { root, version: '1.0.0' };
}

function leaf(id: string, type: ASTNode['type'], bbox: ASTNode['bbox']): ASTNode {
  return { id, type, bbox, props: {}, children: [] };
}

describe('repeat-engine / detectRepeats', () => {
  it('emits a reusable template for two same-size list items', () => {
    const page = ast({
      id: 'page',
      type: 'page',
      bbox: { x: 0, y: 0, w: 400, h: 600 },
      props: {},
      children: [{
        id: 'list',
        type: 'list',
        bbox: { x: 0, y: 0, w: 300, h: 100 },
        props: {},
        children: [
          leaf('i1', 'listItem', { x: 0, y: 0, w: 280, h: 40 }),
          leaf('i2', 'listItem', { x: 0, y: 60, w: 280, h: 40 }),
        ],
      }],
    });

    expect(detectRepeats(page)).toEqual([
      { targetId: 'list', count: 2, templateId: 'i1', templateType: 'listItem' },
    ]);
  });

  it('emits one repeat with count 3 for three same-size list items', () => {
    const page = ast({
      id: 'page',
      type: 'page',
      bbox: { x: 0, y: 0, w: 400, h: 600 },
      props: {},
      children: [
        {
          id: 'list',
          type: 'list',
          bbox: { x: 0, y: 0, w: 300, h: 160 },
          props: {},
          children: [
            leaf('i1', 'listItem', { x: 0, y: 0, w: 280, h: 40 }),
            leaf('i2', 'listItem', { x: 0, y: 60, w: 280, h: 40 }),
            leaf('i3', 'listItem', { x: 0, y: 120, w: 280, h: 40 }),
          ],
        },
      ],
    });

    const repeats = detectRepeats(page);
    expect(repeats).toEqual([{ targetId: 'list', count: 3, templateId: 'i1', templateType: 'listItem' }]);
  });

  it('does not report repeated action controls as data templates', () => {
    const page = ast({
      id: 'page',
      type: 'page',
      bbox: { x: 0, y: 0, w: 400, h: 600 },
      props: {},
      children: [
        {
          id: 'form',
          type: 'container',
          bbox: { x: 0, y: 0, w: 300, h: 200 },
          props: {},
          children: [
            leaf('b1', 'button', { x: 0, y: 0, w: 80, h: 40 }),
            leaf('b2', 'button', { x: 100, y: 0, w: 80, h: 40 }),
            leaf('b3', 'button', { x: 200, y: 0, w: 80, h: 40 }),
            leaf('i1', 'input', { x: 0, y: 60, w: 200, h: 28 }),
            leaf('i2', 'input', { x: 0, y: 100, w: 200, h: 28 }),
            leaf('i3', 'input', { x: 0, y: 140, w: 200, h: 28 }),
          ],
        },
      ],
    });

    const repeats = detectRepeats(page);
    expect(repeats).toEqual([]);
  });

  it('emits no repeat for two same-type nodes with dissimilar sizes', () => {
    const page = ast({
      id: 'page',
      type: 'page',
      bbox: { x: 0, y: 0, w: 400, h: 600 },
      props: {},
      children: [
        {
          id: 'mix',
          type: 'container',
          bbox: { x: 0, y: 0, w: 300, h: 200 },
          props: {},
          children: [
            leaf('a', 'button', { x: 0, y: 0, w: 40, h: 30 }),
            leaf('b', 'button', { x: 100, y: 0, w: 120, h: 80 }),
          ],
        },
      ],
    });

    expect(detectRepeats(page)).toEqual([]);
  });

  it('returns an empty array for a tree with no multi-child containers', () => {
    const page = ast({
      id: 'page',
      type: 'page',
      bbox: { x: 0, y: 0, w: 400, h: 600 },
      props: {},
      children: [leaf('hero', 'card', { x: 120, y: 260, w: 160, h: 80 })],
    });

    expect(detectRepeats(page)).toEqual([]);
  });

  it('is deterministic across sibling permutations with non-transitive sizes', () => {
    const makePage = (widths: number[]): SemanticAST => ast({
      id: 'page',
      type: 'page',
      bbox: { x: 0, y: 0, w: 400, h: 600 },
      props: {},
      children: [{
        id: 'list',
        type: 'list',
        bbox: { x: 0, y: 0, w: 200, h: 300 },
        props: {},
        children: widths.map((w, index) => leaf(`i${w}`, 'listItem', { x: 0, y: index * 70, w, h: 50 })),
      }],
    });

    expect(detectRepeats(makePage([100, 115, 132]))).toEqual(
      detectRepeats(makePage([115, 132, 100])),
    );
  });
});
