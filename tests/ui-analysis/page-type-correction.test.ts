import { describe, expect, it } from 'vitest';
import { inferPageType } from '../../src/ui-analysis/semantic/page-type-engine.js';
import { buildSemanticAst } from '../../src/ui-analysis/ast/ast-builder.js';
import { enrichNodeTypes } from '../../src/ui-analysis/typing/index.js';
import { toVisionIRFromLayout, toLayoutIR } from '../../src/ui-analysis/ir/mappers.js';
import type { UiLayoutExtraction } from '../../src/core/extractors/ui-layout-extractor.js';
import type { VisionOcrItem } from '../../src/ui-analysis/ir/types.js';

// Regression: a card-list dashboard with a stray false button was classified
// 'form' (form's text:labels fired on any text + button:submit on the stray
// button). After tightening form (labels require an input) and re-inferring
// semantics post-correction (cards -> listItem), it must classify 'list'.
function makeLayout(): UiLayoutExtraction {
  return {
    structure: { pageType: 'admin', layoutType: 'sidebar', regions: [
      { id: 'r0', type: 'header', bbox: { x: 0, y: 0, w: 640, h: 56 }, relativeArea: 0.1, children: [] },
      { id: 'r1', type: 'sidebar', bbox: { x: 0, y: 56, w: 160, h: 424 }, relativeArea: 0.2, children: [] },
      { id: 'r2', type: 'main', bbox: { x: 160, y: 56, w: 480, h: 424 }, relativeArea: 0.7, children: [] },
    ] },
    components: [
      { type: 'card', bbox: { x: 180, y: 76, w: 440, h: 90 }, text: '', state: 'default', variant: 'default' },
      { type: 'card', bbox: { x: 180, y: 180, w: 440, h: 90 }, text: '', state: 'default', variant: 'default' },
      { type: 'card', bbox: { x: 180, y: 284, w: 440, h: 90 }, text: '', state: 'default', variant: 'default' },
    ],
    texts: [
      { text: '商品A', bbox: { x: 196, y: 92, w: 54, h: 20 }, estimatedLevel: 'body' },
      { text: '商品B', bbox: { x: 196, y: 196, w: 54, h: 20 }, estimatedLevel: 'body' },
      { text: '商品C', bbox: { x: 196, y: 300, w: 54, h: 20 }, estimatedLevel: 'body' },
      { text: '提交', bbox: { x: 528, y: 413, w: 52, h: 20 }, estimatedLevel: 'body' },
    ],
    spacing: { averageGap: 10, scale: 'comfortable', verticalGaps: [10], horizontalGaps: [10] },
    mediaAreas: [],
    summary: '',
  };
}

describe('page-type post-correction re-inference (S33)', () => {
  it('classifies a card-list dashboard as list (not form) after correction', () => {
    const layout = makeLayout();
    const visionIR = toVisionIRFromLayout(layout);
    const layoutIR = toLayoutIR(layout);
    const ocr: VisionOcrItem[] = visionIR.ocr;
    const ast = buildSemanticAst(layoutIR, ocr, visionIR.detections, layout.mediaAreas);
    // pre-correction: still cards/table-like -> not yet list
    const pre = inferPageType({ ast, layout: layoutIR, ocr });
    enrichNodeTypes(ast, ocr); // cards -> listItem
    const post = inferPageType({ ast, layout: layoutIR, ocr });
    expect(post.pageType).toBe('list');
    expect(post.pageType).not.toBe('form');
  });
});
