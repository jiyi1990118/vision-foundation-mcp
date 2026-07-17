import { describe, expect, it } from 'vitest';
import { validateReconstruction } from '../../src/ui-analysis/validate.js';
import type { UiReconstructionSpec } from '../../src/ui-analysis/reconstruction/index.js';

function validSpec(): UiReconstructionSpec {
  return {
    version: '1.0.0',
    page: { type: 'page', layoutType: 'stack', bbox: { x: 0, y: 0, w: 320, h: 480 } },
    tree: {
      id: 'page',
      type: 'page',
      bbox: { x: 0, y: 0, w: 320, h: 480 },
      props: { layoutType: 'stack' },
      children: [
        { id: 'b1', type: 'button', bbox: { x: 10, y: 10, w: 80, h: 30 }, props: {}, children: [] },
      ],
    },
    constraints: [],
    images: [],
    stats: { nodeCount: 2, componentCounts: { page: 1, button: 1 } },
  };
}

describe('validateReconstruction (S24 G-B1)', () => {
  it('does not throw for a valid spec', () => {
    expect(() => validateReconstruction(validSpec())).not.toThrow();
  });

  it('throws when page is missing', () => {
    const broken = { ...validSpec() } as Partial<UiReconstructionSpec>;
    delete broken.page;
    expect(() => validateReconstruction(broken as UiReconstructionSpec)).toThrow(/page/);
  });

  it('throws when stats.nodeCount is 0 (empty tree)', () => {
    const spec = validSpec();
    spec.stats.nodeCount = 0;
    expect(() => validateReconstruction(spec)).toThrow(/nodeCount/);
  });

  it('throws when tree is missing', () => {
    const broken = { ...validSpec() } as Partial<UiReconstructionSpec>;
    delete broken.tree;
    expect(() => validateReconstruction(broken as UiReconstructionSpec)).toThrow(/tree/);
  });

  it('throws when constraints is not an array', () => {
    const spec = validSpec() as unknown as { constraints: unknown };
    spec.constraints = 'nope';
    expect(() => validateReconstruction(spec as unknown as UiReconstructionSpec)).toThrow(/constraints/);
  });
});
