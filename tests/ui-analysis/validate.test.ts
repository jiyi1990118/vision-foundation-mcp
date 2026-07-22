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

  it('throws when a constraint target does not exist in the tree', () => {
    const spec = validSpec();
    spec.constraints = [{ targetId: 'missing', direction: 'row' }];
    expect(() => validateReconstruction(spec)).toThrow(/constraint.*missing/i);
  });

  it('throws when repeat or slot references do not exist in the tree', () => {
    const repeatSpec = validSpec();
    repeatSpec.repeats = [{ targetId: 'page', count: 2, templateId: 'missing' }];
    expect(() => validateReconstruction(repeatSpec)).toThrow(/repeat.*missing/i);

    const slotSpec = validSpec();
    slotSpec.slots = [{ id: 'missing', name: 'itemTemplate' }];
    expect(() => validateReconstruction(slotSpec)).toThrow(/slot.*missing/i);
  });

  it('throws when node ids are duplicated', () => {
    const spec = validSpec();
    spec.tree.children.push({
      id: 'b1',
      type: 'text',
      bbox: { x: 10, y: 50, w: 80, h: 20 },
      props: {},
      children: [],
    });
    spec.stats = { nodeCount: 3, componentCounts: { page: 1, button: 1, text: 1 } };
    expect(() => validateReconstruction(spec)).toThrow(/duplicate.*b1/i);
  });

  it('throws when stats do not describe the emitted tree', () => {
    const spec = validSpec();
    spec.stats.componentCounts.button = 2;
    expect(() => validateReconstruction(spec)).toThrow(/componentCounts/);
  });

  it('rejects stale full-tree statistics instead of assuming summary mode', () => {
    const spec = validSpec();
    spec.stats = { nodeCount: 3, componentCounts: { page: 1, button: 2 } };
    expect(() => validateReconstruction(spec)).toThrow(/nodeCount|tree/i);
  });

  it('accepts retained full-tree statistics only in explicit summary mode', () => {
    const spec = validSpec();
    spec.tree.children = [];
    spec.constraints = [];
    spec.images = [];
    expect(() => validateReconstruction(spec, { summaryOnly: true })).not.toThrow();
    expect(() => validateReconstruction(spec)).toThrow(/nodeCount|tree/i);
  });

  it('rejects detailed repeat, slot, or responsive fields in summary mode', () => {
    const spec = validSpec();
    spec.tree.children = [];
    spec.constraints = [];
    spec.images = [];
    spec.responsive = [{ breakpoint: 'mobile', layout: 'stack' }];
    expect(() => validateReconstruction(spec, { summaryOnly: true })).toThrow(/summary/i);

    delete spec.responsive;
    spec.repeats = [{ targetId: 'page', count: 1 }];
    expect(() => validateReconstruction(spec, { summaryOnly: true })).toThrow(/summary/i);

    delete spec.repeats;
    spec.slots = [{ id: 'page', name: 'root' }];
    expect(() => validateReconstruction(spec, { summaryOnly: true })).toThrow(/summary/i);
  });
});
