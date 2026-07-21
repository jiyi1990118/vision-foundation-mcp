import { describe, it, expect } from 'vitest';
import { buildUiReconstruction } from '../../src/ui-analysis/reconstruction/reconstruction-spec.js';
import type { SemanticAST } from '../../src/ui-analysis/ir/types.js';
import type { AssetManifest, QualityReport } from '../../src/ui-analysis/policy/types.js';

describe('Extended reconstruction spec', () => {
  it('includes assets and quality when provided', () => {
    const ast: SemanticAST = {
      root: { id: 'page', type: 'page', bbox: { x: 0, y: 0, w: 375, h: 800 }, props: { layoutType: 'stack' }, children: [] },
      version: '1.0.0',
    };
    const assets: AssetManifest = {
      items: [
        { id: 'a1', kind: 'icon', bbox: { x: 0, y: 0, w: 20, h: 20 }, mimeType: 'image/png', uri: 'file:///tmp/a1.png', sha256: 'abc', confidence: 0.9 },
      ],
    };
    const quality: QualityReport = {
      criticalElementCoverage: 0.95,
      editableElementRatio: 0.8,
      flattenedFallbackRatio: 0.15,
      unexplainedAreaRatio: 0.02,
      warnings: [],
    };
    const spec = buildUiReconstruction({ ast, assets, quality });
    expect(spec.assets).toBeDefined();
    expect(spec.assets!.items).toHaveLength(1);
    expect(spec.quality).toBeDefined();
    expect(spec.quality!.editableElementRatio).toBe(0.8);
  });

  it('omits assets and quality when not provided (backward compat)', () => {
    const ast: SemanticAST = {
      root: { id: 'page', type: 'page', bbox: { x: 0, y: 0, w: 375, h: 800 }, props: { layoutType: 'stack' }, children: [] },
      version: '1.0.0',
    };
    const spec = buildUiReconstruction({ ast });
    expect(spec.assets).toBeUndefined();
    expect(spec.quality).toBeUndefined();
  });
});
