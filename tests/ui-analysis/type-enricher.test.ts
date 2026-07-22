import { describe, expect, it } from 'vitest';
import { enrichNodeTypes } from '../../src/ui-analysis/typing/index.js';
import type { ASTNode, SemanticAST, BBox } from '../../src/ui-analysis/ir/types.js';

function ast(root: ASTNode): SemanticAST {
  return { root, version: '1.0.0' };
}

function box(x: number, y: number, w: number, h: number): BBox {
  return { x, y, w, h };
}

function leaf(id: string, type: ASTNode['type'], bbox: BBox, text?: string): ASTNode {
  const n: ASTNode = { id, type, bbox, props: {}, children: [] };
  if (text !== undefined) n.text = text;
  return n;
}

function container(id: string, type: ASTNode['type'], bbox: BBox, children: ASTNode[]): ASTNode {
  return { id, type, bbox, props: {}, children };
}

function textLeaf(id: string, bbox: BBox, fontSize: number, text: string): ASTNode {
  return { id, type: 'text', bbox, props: { style: { fontSize } }, text, children: [] };
}

describe('type-enricher / enrichNodeTypes', () => {
  it('promotes a container of 3 same-size cards to list with listItem children', () => {
    const page = ast(
      container('page', 'page', box(0, 0, 400, 600), [
        container('lst', 'container', box(0, 0, 300, 200), [
          leaf('c1', 'card', box(0, 0, 100, 60)),
          leaf('c2', 'card', box(0, 70, 100, 60)),
          leaf('c3', 'card', box(0, 140, 100, 60)),
        ]),
      ]),
    );
    enrichNodeTypes(page);
    expect(page.root.children[0]!.type).toBe('list');
    expect(page.root.children[0]!.children.map((c) => c.type)).toEqual([
      'listItem',
      'listItem',
      'listItem',
    ]);
  });

  it('does not promote a vertical stack of 3 buttons to list (button group)', () => {
    const page = ast(
      container('page', 'page', box(0, 0, 400, 600), [
        container('grp', 'container', box(0, 0, 120, 200), [
          leaf('b1', 'button', box(10, 0, 100, 40), 'Edit'),
          leaf('b2', 'button', box(10, 50, 100, 40), 'Save'),
          leaf('b3', 'button', box(10, 100, 100, 40), 'Done'),
        ]),
      ]),
    );
    enrichNodeTypes(page);
    const grp = page.root.children[0]!;
    expect(grp.type).toBe('container');
    expect(grp.children.map((c) => c.type)).toEqual(['button', 'button', 'button']);
  });

  it('does not promote a horizontal row of cards to a list', () => {
    const page = ast(
      container('page', 'page', box(0, 0, 400, 200), [
        container('cards', 'container', box(0, 0, 400, 120), [
          leaf('c1', 'card', box(0, 0, 100, 100)),
          leaf('c2', 'card', box(120, 0, 100, 100)),
          leaf('c3', 'card', box(240, 0, 100, 100)),
        ]),
      ]),
    );
    enrichNodeTypes(page);
    expect(page.root.children[0]!.type).toBe('row');
    expect(page.root.children[0]!.children.every((child) => child.type === 'card')).toBe(true);
  });

  it('promotes a thin textless node to divider', () => {
    const page = ast(
      container('page', 'page', box(0, 0, 400, 600), [
        leaf('d', 'unknown', box(0, 50, 200, 4)),
      ]),
    );
    enrichNodeTypes(page);
    expect(page.root.children[0]!.type).toBe('divider');
  });

  it('promotes a tall input to textarea', () => {
    const page = ast(
      container('page', 'page', box(0, 0, 400, 600), [
        leaf('ta', 'input', box(0, 0, 200, 100)),
      ]),
    );
    enrichNodeTypes(page);
    expect(page.root.children[0]!.type).toBe('textarea');
  });

  it('layers text nodes into title / subtitle / text by font size', () => {
    const page = ast(
      container('page', 'page', box(0, 0, 400, 600), [
        textLeaf('t1', box(0, 0, 200, 32), 32, 'Large heading line one'),
        textLeaf('t2', box(0, 40, 200, 18), 18, 'Subsection label text'),
        textLeaf('t3', box(0, 70, 200, 12), 12, 'Body paragraph text line'),
        textLeaf('t4', box(0, 90, 200, 14), 14, 'Filler caption number one'),
        textLeaf('t5', box(0, 110, 200, 14), 14, 'Filler caption number two'),
      ]),
    );
    enrichNodeTypes(page);
    const kids = page.root.children;
    expect(kids[0]!.type).toBe('title');
    expect(kids[1]!.type).toBe('subtitle');
    expect(kids[2]!.type).toBe('text');
  });

  it('promotes a small near-square textless button to iconButton', () => {
    const page = ast(
      container('page', 'page', box(0, 0, 400, 600), [
        leaf('ib', 'button', box(0, 0, 32, 32)),
      ]),
    );
    enrichNodeTypes(page);
    expect(page.root.children[0]!.type).toBe('iconButton');
  });

  it('promotes a short small text node to tag', () => {
    const page = ast(
      container('page', 'page', box(0, 0, 400, 600), [
        leaf('tg', 'unknown', box(0, 0, 60, 20), 'New'),
      ]),
    );
    enrichNodeTypes(page);
    expect(page.root.children[0]!.type).toBe('tag');
  });

  it('promotes a horizontal button-majority container to toolbar', () => {
    const page = ast(
      container('page', 'page', box(0, 0, 400, 600), [
        container('tb', 'container', box(0, 0, 240, 40), [
          leaf('b1', 'button', box(0, 0, 60, 40), 'Edit'),
          leaf('b2', 'button', box(80, 0, 60, 40), 'Save'),
          leaf('b3', 'button', box(160, 0, 60, 40), 'Done'),
        ]),
      ]),
    );
    enrichNodeTypes(page);
    expect(page.root.children[0]!.type).toBe('toolbar');
    expect(page.root.children[0]!.children.map((c) => c.type)).toEqual([
      'button',
      'button',
      'button',
    ]);
  });

  it('does not downgrade a specific type (avatar keeps its type)', () => {
    const page = ast(
      container('page', 'page', box(0, 0, 400, 600), [
        leaf('av', 'avatar', box(250, 10, 24, 24), 'Logo'),
      ]),
    );
    enrichNodeTypes(page);
    expect(page.root.children[0]!.type).toBe('avatar');
  });

  it('leaves the page root and a single-child tree unchanged', () => {
    const page = ast(
      container('page', 'page', box(0, 0, 400, 600), [
        leaf('c', 'card', box(20, 20, 120, 80)),
      ]),
    );
    enrichNodeTypes(page);
    expect(page.root.type).toBe('page');
    expect(page.root.children[0]!.type).toBe('card');
  });
});
