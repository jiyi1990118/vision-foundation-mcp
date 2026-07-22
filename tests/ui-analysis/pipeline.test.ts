import { describe, expect, it } from 'vitest';
import { analyzeUiPipeline } from '../../src/ui-analysis/pipeline.js';
import type { UiLayoutExtraction } from '../../src/core/extractors/ui-layout-extractor.js';

function makeUiLayout(): UiLayoutExtraction {
  return {
    structure: {
      pageType: 'admin-ui',
      layoutType: 'sidebar',
      regions: [
        { id: 'r0', type: 'header', bbox: { x: 0, y: 0, w: 400, h: 40 }, relativeArea: 0.13, children: [] },
        { id: 'r1', type: 'sidebar', bbox: { x: 0, y: 40, w: 80, h: 260 }, relativeArea: 0.17, children: [] },
      ],
    },
    components: [
      { type: 'button', bbox: { x: 300, y: 280, w: 40, h: 18 }, text: '保存', state: 'default', variant: 'primary' },
    ],
    texts: [
      { text: '商品管理', bbox: { x: 10, y: 50, w: 60, h: 16 }, estimatedLevel: 'heading' },
    ],
    spacing: { averageGap: 8, scale: 'comfortable', verticalGaps: [5], horizontalGaps: [10] },
    mediaAreas: [],
    summary: '2 regions, 1 component',
  };
}

describe('ui-analysis pipeline', () => {
  it('builds a SemanticAST tree when buildTree is true (default)', () => {
    const result = analyzeUiPipeline({ uiLayoutExtraction: makeUiLayout() });
    expect(result.ui).toBeDefined();
    expect(result.ui!.root.type).toBe('page');
  });

  it('exports CodegenIR when exportCodegen is true', () => {
    const result = analyzeUiPipeline({
      uiLayoutExtraction: makeUiLayout(),
      options: { exportCodegen: true },
    });
    expect(result.codegenIr).toBeDefined();
    expect(result.codegenIr!.root.type).toBe('page');
    expect(Array.isArray(result.codegenIr!.constraints)).toBe(true);
  });

  it('computes codegenIr even without exportCodegen so reconstruction can use repeats/slots', () => {
    const result = analyzeUiPipeline({
      uiLayoutExtraction: makeUiLayout(),
      options: { exportCodegen: false },
    });
    expect(result.codegenIr).toBeDefined();
    expect(result.codegenIr!.root.type).toBe('page');
  });

  it('omits ui when buildTree is false but still exports codegen', () => {
    const result = analyzeUiPipeline({
      uiLayoutExtraction: makeUiLayout(),
      options: { buildTree: false, exportCodegen: true },
    });
    expect(result.ui).toBeUndefined();
    expect(result.codegenIr).toBeDefined();
  });

  it('exports figma and markdown when requested', () => {
    const result = analyzeUiPipeline({
      uiLayoutExtraction: makeUiLayout(),
      options: { exportFigma: true, exportMarkdown: true },
    });
    expect(result.figma).toBeDefined();
    expect(typeof result.markdown).toBe('string');
    expect(result.markdown).toContain('page');
  });
});
