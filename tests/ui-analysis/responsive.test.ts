import { describe, expect, it } from 'vitest';
import { inferResponsive } from '../../src/ui-analysis/responsive/index.js';
import type {
  ASTNode,
  LayoutIR,
  LayoutType,
  SemanticAST,
  VisualRegion,
} from '../../src/ui-analysis/ir/types.js';

function makeLayout(
  regions: VisualRegion[] = [],
  layoutType: LayoutType = 'stack',
): LayoutIR {
  return {
    regions,
    layoutType,
    spacing: { averageGap: 0, scale: 'compact', verticalGaps: [], horizontalGaps: [] },
  };
}

function ast(root: ASTNode): SemanticAST {
  return { root, version: '1.0.0' };
}

function leaf(id: string, type: ASTNode['type'], bbox: ASTNode['bbox']): ASTNode {
  return { id, type, bbox, props: {}, children: [] };
}

describe('responsive-engine / inferResponsive', () => {
  it('emits sidebar-collapse when layout has a sidebar region', () => {
    const page = ast({
      id: 'page',
      type: 'page',
      bbox: { x: 0, y: 0, w: 400, h: 600 },
      props: {},
      children: [leaf('s', 'sidebar', { x: 0, y: 0, w: 100, h: 600 })],
    });
    const layout = makeLayout(
      [
        {
          id: 's',
          type: 'sidebar',
          bbox: { x: 0, y: 0, w: 100, h: 600 },
          relativeArea: 0.25,
          children: [],
        },
      ],
      'sidebar',
    );

    const rules = inferResponsive(page, layout);
    expect(rules).toContainEqual({ breakpoint: 'mobile', layout: 'sidebar-collapse' });
  });

  it('emits sidebar-collapse from a left narrow sidebar AST node even without a sidebar region', () => {
    const page = ast({
      id: 'page',
      type: 'page',
      bbox: { x: 0, y: 0, w: 400, h: 600 },
      props: {},
      children: [leaf('s', 'sidebar', { x: 10, y: 0, w: 80, h: 600 })],
    });
    const layout = makeLayout([], 'stack');

    const rules = inferResponsive(page, layout);
    expect(rules).toContainEqual({ breakpoint: 'mobile', layout: 'sidebar-collapse' });
  });

  it('is invariant when the page and sidebar are translated away from the origin', () => {
    const page = ast({
      id: 'page',
      type: 'page',
      bbox: { x: 100, y: 50, w: 400, h: 600 },
      props: {},
      children: [leaf('s', 'sidebar', { x: 110, y: 50, w: 80, h: 600 })],
    });
    expect(inferResponsive(page, makeLayout([], 'stack'))).toContainEqual({
      breakpoint: 'mobile',
      layout: 'sidebar-collapse',
    });
  });

  it('emits horizontal-scroll when AST contains a table node', () => {
    const page = ast({
      id: 'page',
      type: 'page',
      bbox: { x: 0, y: 0, w: 400, h: 600 },
      props: {},
      children: [leaf('t', 'table', { x: 10, y: 10, w: 380, h: 200 })],
    });
    const layout = makeLayout(
      [
        {
          id: 't',
          type: 'table',
          bbox: { x: 10, y: 10, w: 380, h: 200 },
          relativeArea: 0.5,
          children: [],
        },
      ],
      'stack',
    );

    const rules = inferResponsive(page, layout);
    expect(rules).toContainEqual({ breakpoint: 'mobile', layout: 'horizontal-scroll' });
  });

  it('emits stack-vertically for a grid container with more than two children', () => {
    const page = ast({
      id: 'page',
      type: 'page',
      bbox: { x: 0, y: 0, w: 400, h: 600 },
      props: {},
      children: [
        {
          id: 'grid',
          type: 'container',
          bbox: { x: 0, y: 0, w: 400, h: 300 },
          props: {},
          children: [
            leaf('a', 'card', { x: 0, y: 0, w: 40, h: 30 }),
            leaf('b', 'card', { x: 200, y: 100, w: 40, h: 30 }),
            leaf('c', 'card', { x: 50, y: 250, w: 40, h: 30 }),
          ],
        },
      ],
    });
    const layout = makeLayout([], 'stack');

    const rules = inferResponsive(page, layout);
    expect(rules).toContainEqual({ breakpoint: 'mobile', layout: 'stack-vertically' });
  });

  it('emits merge-columns (tablet) when layout is columns with more than two regions', () => {
    const page = ast({
      id: 'page',
      type: 'page',
      bbox: { x: 0, y: 0, w: 900, h: 600 },
      props: {},
      children: [
        leaf('c1', 'column', { x: 0, y: 0, w: 300, h: 600 }),
        leaf('c2', 'column', { x: 300, y: 0, w: 300, h: 600 }),
        leaf('c3', 'column', { x: 600, y: 0, w: 300, h: 600 }),
      ],
    });
    const layout = makeLayout(
      [
        { id: 'c1', type: 'content', bbox: { x: 0, y: 0, w: 300, h: 600 }, relativeArea: 0.33, children: [] },
        { id: 'c2', type: 'content', bbox: { x: 300, y: 0, w: 300, h: 600 }, relativeArea: 0.33, children: [] },
        { id: 'c3', type: 'content', bbox: { x: 600, y: 0, w: 300, h: 600 }, relativeArea: 0.33, children: [] },
      ],
      'columns',
    );

    const rules = inferResponsive(page, layout);
    expect(rules).toContainEqual({ breakpoint: 'tablet', layout: 'merge-columns' });
  });

  it('returns an empty array for a simple single-region centered layout', () => {
    const page = ast({
      id: 'page',
      type: 'page',
      bbox: { x: 0, y: 0, w: 400, h: 600 },
      props: {},
      children: [leaf('hero', 'card', { x: 120, y: 260, w: 160, h: 80 })],
    });
    const layout = makeLayout(
      [
        {
          id: 'hero',
          type: 'content',
          bbox: { x: 120, y: 260, w: 160, h: 80 },
          relativeArea: 0.5,
          children: [],
        },
      ],
      'centered',
    );

    expect(inferResponsive(page, layout)).toEqual([]);
  });

  it('deduplicates identical (breakpoint, layout) pairs', () => {
    const page = ast({
      id: 'page',
      type: 'page',
      bbox: { x: 0, y: 0, w: 400, h: 600 },
      props: {},
      children: [
        leaf('t1', 'table', { x: 0, y: 0, w: 200, h: 100 }),
        leaf('t2', 'table', { x: 0, y: 120, w: 200, h: 100 }),
      ],
    });
    const layout = makeLayout(
      [
        { id: 't1', type: 'table', bbox: { x: 0, y: 0, w: 200, h: 100 }, relativeArea: 0.3, children: [] },
        { id: 't2', type: 'table', bbox: { x: 0, y: 120, w: 200, h: 100 }, relativeArea: 0.3, children: [] },
      ],
      'stack',
    );

    const rules = inferResponsive(page, layout);
    expect(rules.filter((r) => r.layout === 'horizontal-scroll')).toHaveLength(1);
  });
});
