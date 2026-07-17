import { describe, expect, it } from 'vitest';
import { buildSemanticAst } from '../../src/ui-analysis/ast/ast-builder.js';
import type { LayoutIR, VisionOcrItem, VisionDetection } from '../../src/ui-analysis/ir/types.js';

function makeLayout(): LayoutIR {
  return {
    regions: [
      { id: 'r0', type: 'main', bbox: { x: 0, y: 0, w: 400, h: 400 }, relativeArea: 1, children: [] },
      { id: 'r1', type: 'card', bbox: { x: 10, y: 10, w: 100, h: 100 }, relativeArea: 0.06, children: [] },
      { id: 'r2', type: 'card', bbox: { x: 10, y: 200, w: 100, h: 100 }, relativeArea: 0.06, children: [] },
    ],
    layoutType: 'stack',
    spacing: { averageGap: 8, scale: 'comfortable', verticalGaps: [5], horizontalGaps: [10] },
  };
}

describe('ast-builder', () => {
  it('builds a hierarchical tree by bbox containment', () => {
    const ast = buildSemanticAst(makeLayout());

    expect(ast.root.type).toBe('page');
    expect(ast.version).toBe('1.0.0');
    expect(ast.root.children).toHaveLength(1);

    const main = ast.root.children[0]!;
    expect(main.type).toBe('section');
    expect(main.children).toHaveLength(2);

    const cardTypes = main.children.map((c) => c.type);
    expect(cardTypes).toEqual(['card', 'card']);

    for (const card of main.children) {
      expect(card.bbox.x).toBeGreaterThanOrEqual(main.bbox.x);
      expect(card.bbox.y).toBeGreaterThanOrEqual(main.bbox.y);
      expect(card.bbox.x + card.bbox.w).toBeLessThanOrEqual(main.bbox.x + main.bbox.w);
      expect(card.bbox.y + card.bbox.h).toBeLessThanOrEqual(main.bbox.y + main.bbox.h);
    }
  });

  it('binds OCR text to the tightest enclosing node and attaches detections as leaves', () => {
    const ocr: VisionOcrItem[] = [
      { text: 'Card Title', bbox: { x: 12, y: 12, w: 80, h: 16 }, confidence: 0.9 },
      { text: 'desc', bbox: { x: 12, y: 32, w: 40, h: 12 }, confidence: 0.8 },
    ];
    const detections: VisionDetection[] = [
      { type: 'button', bbox: { x: 20, y: 60, w: 40, h: 20 }, score: 0.95 },
      { type: 'toggle', bbox: { x: 20, y: 80, w: 24, h: 12 }, score: 0.9 },
    ];

    const ast = buildSemanticAst(makeLayout(), ocr, detections);
    const card = ast.root.children[0]!.children[0]!;

    expect(card.text).toBe('Card Title');
    const textChild = card.children.find((c) => c.type === 'text');
    expect(textChild).toBeDefined();
    expect(textChild!.text).toBe('desc');

    const leafTypes = card.children.map((c) => c.type).sort();
    expect(leafTypes).toEqual(['button', 'switch', 'text']);
  });
});
