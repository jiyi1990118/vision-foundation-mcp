import { describe, expect, it } from 'vitest';
import { analyzeUiPipeline } from '../../src/ui-analysis/pipeline.js';
import type { UiLayoutExtraction } from '../../src/core/extractors/ui-layout-extractor.js';

function makeLoginLayout(): UiLayoutExtraction {
  return {
    structure: {
      pageType: 'general-ui',
      layoutType: 'centered',
      regions: [
        { id: 'r0', type: 'content', bbox: { x: 100, y: 80, w: 240, h: 240 }, relativeArea: 0.6, children: [] },
      ],
    },
    components: [
      { type: 'input', bbox: { x: 120, y: 120, w: 200, h: 32 }, text: '', state: 'default', variant: 'default' },
      { type: 'button', bbox: { x: 140, y: 200, w: 160, h: 36 }, text: '登录', state: 'default', variant: 'primary' },
    ],
    texts: [
      { text: '登录', bbox: { x: 160, y: 208, w: 120, h: 20 }, estimatedLevel: 'body' },
    ],
    spacing: { averageGap: 8, scale: 'comfortable', verticalGaps: [], horizontalGaps: [] },
    mediaAreas: [],
    summary: 'login layout',
  };
}

describe('ui-analysis pipeline semantics (S10)', () => {
  it('infers pageType=login from input + button + OCR "登录" + centered layout', () => {
    const result = analyzeUiPipeline({ uiLayoutExtraction: makeLoginLayout() });
    expect(result.ui).toBeDefined();
    expect(result.uiSemantics).toBeDefined();
    expect(result.uiSemantics!.pageType).toBe('login');
  });

  it('exposes uiSemantics alongside codegenIr when exportCodegen is true', () => {
    const result = analyzeUiPipeline({
      uiLayoutExtraction: makeLoginLayout(),
      options: { exportCodegen: true },
    });
    expect(result.codegenIr).toBeDefined();
    expect(result.uiSemantics).toBeDefined();
    expect(result.uiSemantics!.pageType).toBe('login');
  });

  it('omits both ui and uiSemantics when buildTree is false (semantics depend on ast)', () => {
    const result = analyzeUiPipeline({
      uiLayoutExtraction: makeLoginLayout(),
      options: { buildTree: false },
    });
    expect(result.ui).toBeUndefined();
    expect(result.uiSemantics).toBeUndefined();
  });
});
