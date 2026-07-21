import { describe, it, expect } from 'vitest';
import { buildSemanticAst } from '../../src/ui-analysis/ast/ast-builder.js';
import type { LayoutIR, VisionDetection } from '../../src/ui-analysis/ir/types.js';

function makeLayout(): LayoutIR {
  return {
    regions: [],
    layoutType: 'stack',
    spacing: { averageGap: 10, scale: 'comfortable', verticalGaps: [], horizontalGaps: [] },
  };
}

describe('AST builder parent-child', () => {
  it('allows a button detection to be parent of an icon detection', () => {
    const detections: VisionDetection[] = [
      { type: 'button', bbox: { x: 0, y: 0, w: 100, h: 50 }, score: 0.9 },
      { type: 'icon', bbox: { x: 10, y: 10, w: 30, h: 30 }, score: 0.8 },
    ];
    const ast = buildSemanticAst(makeLayout(), undefined, detections);
    const button = ast.root.children.find((c) => c.type === 'button');
    expect(button).toBeDefined();
    expect(button!.children.find((c) => c.type === 'icon')).toBeDefined();
  });

  it('allows a card detection to be parent of an image detection', () => {
    const detections: VisionDetection[] = [
      { type: 'card', bbox: { x: 0, y: 0, w: 200, h: 150 }, score: 0.9 },
      { type: 'image', bbox: { x: 10, y: 10, w: 180, h: 80 }, score: 0.85 },
    ];
    const ast = buildSemanticAst(makeLayout(), undefined, detections);
    const card = ast.root.children.find((c) => c.type === 'card');
    expect(card).toBeDefined();
    const imageChild = card!.children.find((c) => c.type === 'image');
    expect(imageChild).toBeDefined();
  });
});
