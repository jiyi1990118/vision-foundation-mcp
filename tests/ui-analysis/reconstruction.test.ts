import { describe, expect, it } from 'vitest';
import { buildUiReconstruction } from '../../src/ui-analysis/reconstruction/index.js';
import type { SemanticAST } from '../../src/ui-analysis/ir/types.js';
import type { ImageContentInfo } from '../../src/ui-analysis/image-content/image-content-extractor.js';

function pageAst(): SemanticAST {
  return {
    root: {
      id: 'page',
      type: 'page',
      bbox: { x: 0, y: 0, w: 320, h: 480 },
      props: { layoutType: 'stack' },
      children: [
        { id: 'h1', type: 'header', bbox: { x: 0, y: 0, w: 320, h: 60 }, props: {}, children: [] },
        { id: 'b1', type: 'button', bbox: { x: 10, y: 70, w: 100, h: 40 }, props: {}, children: [] },
      ],
    },
    version: '1.0.0',
  };
}

describe('reconstruction-spec / buildUiReconstruction', () => {
  it('aggregates ast + semantics + images into a single spec with correct page/stats', () => {
    const ast = pageAst();
    const images: ImageContentInfo[] = [
      {
        index: 0,
        type: 'icon',
        bbox: { x: 10, y: 10, w: 24, h: 24 },
        crop: { x: 10, y: 10, w: 24, h: 24 },
        altText: '搜索',
      },
    ];

    const spec = buildUiReconstruction({
      ast,
      semantics: { pageType: 'dashboard', confidence: 0.9, summary: 'a dashboard page' },
      images,
    });

    expect(spec.version).toBe('1.0.0');
    expect(spec.page.type).toBe('page');
    expect(spec.page.layoutType).toBe('stack');
    expect(spec.page.bbox).toEqual({ x: 0, y: 0, w: 320, h: 480 });
    expect(spec.tree).toBe(ast.root);
    expect(spec.images).toBe(images);
    expect(spec.semantics).toEqual({ pageType: 'dashboard', confidence: 0.9, summary: 'a dashboard page' });
    expect(spec.stats.nodeCount).toBe(3);
    expect(spec.stats.componentCounts.page).toBe(1);
    expect(spec.stats.componentCounts.header).toBe(1);
    expect(spec.stats.componentCounts.button).toBe(1);
    expect(Array.isArray(spec.constraints)).toBe(true);
    expect(spec.constraints.length).toBeGreaterThan(0);
  });

  it('falls back to inferConstraints when constraints are not provided', () => {
    const ast = pageAst();
    const spec = buildUiReconstruction({ ast });

    expect(Array.isArray(spec.constraints)).toBe(true);
    expect(spec.constraints.length).toBeGreaterThan(0);
    expect(spec.constraints[0]!.targetId).toBe('page');
  });

  it('omits semantics and theme fields when not provided (exactOptionalPropertyTypes)', () => {
    const ast = pageAst();
    const spec = buildUiReconstruction({ ast });

    expect('semantics' in spec).toBe(false);
    expect('theme' in spec).toBe(false);
    expect(spec.semantics).toBeUndefined();
    expect(spec.theme).toBeUndefined();
    expect(spec.images).toEqual([]);
  });
});
