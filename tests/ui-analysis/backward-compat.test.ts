import { describe, expect, it } from 'vitest';
import { analyzeUiPipeline } from '../../src/ui-analysis/pipeline.js';
import type { UiLayoutExtraction } from '../../src/core/extractors/ui-layout-extractor.js';
import type { VisionResult } from '../../src/types/domain.js';

interface SimParse {
  uiLayout: { layoutType: string; pageType: string };
}

function makeUiLayoutExtraction(): UiLayoutExtraction {
  return {
    structure: {
      pageType: 'admin-ui',
      layoutType: 'sidebar',
      regions: [
        { id: 'r0', type: 'header', bbox: { x: 0, y: 0, w: 400, h: 40 }, relativeArea: 0.13, children: [] },
        { id: 'r1', type: 'sidebar', bbox: { x: 0, y: 40, w: 80, h: 260 }, relativeArea: 0.17, children: [] },
        { id: 'r2', type: 'main', bbox: { x: 80, y: 40, w: 320, h: 260 }, relativeArea: 0.7, children: [] },
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
    summary: '3 regions, 1 component',
  };
}

function makeVisionResult(): VisionResult {
  return {
    category: 'ui',
    confidence: 0.9,
    summary: 'simulated',
    skills: ['ui'],
    result: {
      parse: {
        uiLayout: { layoutType: 'sidebar', pageType: 'admin-ui' },
      },
    },
    metadata: { provider: 'gguf', runtime: 'gguf', duration: 10, cached: false },
  };
}

function mountUiFields(vr: VisionResult, ext: UiLayoutExtraction): void {
  const uiPipeline = analyzeUiPipeline({
    uiLayoutExtraction: ext,
    options: { buildTree: true, exportCodegen: true, exportFigma: true, exportMarkdown: true },
  });
  if (uiPipeline.ui) vr.result.ui = uiPipeline.ui;
  if (uiPipeline.codegenIr) vr.result.codegenIr = uiPipeline.codegenIr;
  if (uiPipeline.figma) vr.result.figmaJson = uiPipeline.figma;
  if (uiPipeline.markdown) vr.result.uiMarkdown = uiPipeline.markdown;
}

describe('backward-compat: S4 integration contract', () => {
  it('result.parse.uiLayout and result.ui coexist (parse.uiLayout not overwritten)', () => {
    const vr = makeVisionResult();
    mountUiFields(vr, makeUiLayoutExtraction());

    const parse = vr.result.parse as SimParse;
    expect(parse.uiLayout).toEqual({ layoutType: 'sidebar', pageType: 'admin-ui' });

    expect(vr.result.ui).toBeDefined();
    expect(vr.result.codegenIr).toBeDefined();
    expect(vr.result.figmaJson).toBeDefined();
    expect(vr.result.uiMarkdown).toBeDefined();

    expect(vr.result.ui).not.toBe(parse.uiLayout);
    expect(vr.result.codegenIr).not.toBe(parse.uiLayout);
    expect(vr.result.figmaJson).not.toBe(parse.uiLayout);
    expect(vr.result.uiMarkdown).not.toBe(parse.uiLayout);
  });

  it('VisionResult index signature accepts ui / codegenIr / figmaJson / uiMarkdown keys', () => {
    const vr = makeVisionResult();
    vr.result.ui = { root: { id: 'p', type: 'page', bbox: { x: 0, y: 0, w: 0, h: 0 }, props: {}, children: [] }, version: '1.0.0' };
    vr.result.codegenIr = { root: { id: 'p', type: 'page', props: {}, children: [] }, constraints: [], slots: [], repeats: [] };
    vr.result.figmaJson = { document: { id: 'p', name: 'page', type: 'FRAME', visible: true, absoluteBoundingBox: null, fills: [] }, version: '1.0.0' };
    vr.result.uiMarkdown = '# UI Semantic AST';

    expect(vr.result.ui).toBeDefined();
    expect(vr.result.codegenIr).toBeDefined();
    expect(vr.result.figmaJson).toBeDefined();
    expect(vr.result.uiMarkdown).toBe('# UI Semantic AST');
  });

  it('parse.uiLayout is untouched when build_tree is false (ui not produced)', () => {
    const vr = makeVisionResult();
    const ext = makeUiLayoutExtraction();

    const uiPipeline = analyzeUiPipeline({ uiLayoutExtraction: ext, options: { buildTree: false } });
    if (uiPipeline.ui) vr.result.ui = uiPipeline.ui;

    const parse = vr.result.parse as SimParse;
    expect(parse.uiLayout).toEqual({ layoutType: 'sidebar', pageType: 'admin-ui' });
    expect(vr.result.ui).toBeUndefined();
  });

  it('mounted result.ui is a hierarchical SemanticAST whose root is a page', () => {
    const vr = makeVisionResult();
    mountUiFields(vr, makeUiLayoutExtraction());

    const ui = vr.result.ui as { root: { type: string; children: unknown[] } };
    expect(ui.root.type).toBe('page');
    expect(ui.root.children.length).toBeGreaterThan(0);
  });
});
