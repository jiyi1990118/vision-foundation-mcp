import { describe, expect, it } from 'vitest';
import { enrichNodeTypes } from '../../src/ui-analysis/typing/index.js';
import type { SemanticAST, ASTNode, BBox } from '../../src/ui-analysis/ir/types.js';

function box(x: number, y: number, w: number, h: number): BBox {
  return { x, y, w, h };
}
function leaf(id: string, type: ASTNode['type'], bbox: BBox, extra?: { text?: string; style?: unknown }): ASTNode {
  const props: Record<string, unknown> = {};
  if (extra?.style) props.style = extra.style;
  return { id, type, bbox, props, text: extra?.text, children: [] };
}
function ast(root: ASTNode): SemanticAST {
  return { root, version: '1.0.0' };
}

describe('correctMisclassified + pruneOutOfBounds (S32)', () => {
  it('re-types a table of cards to a list of listItems', () => {
    const page = ast({
      id: 'p',
      type: 'page',
      bbox: box(0, 0, 400, 600),
      props: {},
      children: [
        {
          id: 't',
          type: 'table',
          bbox: box(0, 0, 400, 600),
          props: {},
          children: [
            leaf('c1', 'card', box(10, 10, 380, 80)),
            leaf('c2', 'card', box(10, 100, 380, 80)),
            leaf('c3', 'card', box(10, 190, 380, 80)),
          ],
        },
      ],
    });
    enrichNodeTypes(page);
    const table = page.root.children[0]!;
    expect(table.type).toBe('list');
    expect(table.children.every((c) => c.type === 'listItem')).toBe(true);
  });

  it('re-types a small saturated-bg leaf container to a button', () => {
    const page = ast({
      id: 'p',
      type: 'page',
      bbox: box(0, 0, 400, 600),
      props: {},
      children: [
        leaf('b', 'container', box(100, 400, 100, 36), { style: { backgroundColor: '#1677ff' } }),
      ],
    });
    enrichNodeTypes(page);
    expect(page.root.children[0]!.type).toBe('button');
  });

  it('does not promote a gray (low-saturation) container to button', () => {
    const page = ast({
      id: 'p',
      type: 'page',
      bbox: box(0, 0, 400, 600),
      props: {},
      children: [
        leaf('g', 'container', box(10, 10, 100, 36), { style: { backgroundColor: '#bfbfbf' } }),
      ],
    });
    enrichNodeTypes(page);
    expect(page.root.children[0]!.type).not.toBe('button');
  });

  it('prunes a node entirely outside the page bbox', () => {
    const page = ast({
      id: 'p',
      type: 'page',
      bbox: box(0, 0, 640, 480),
      props: {},
      children: [
        leaf('ok', 'card', box(10, 10, 100, 80)),
        leaf('oob', 'button', box(845, 661, 80, 30)),
      ],
    });
    enrichNodeTypes(page);
    expect(page.root.children).toHaveLength(1);
    expect(page.root.children[0]!.id).toBe('ok');
  });
});
