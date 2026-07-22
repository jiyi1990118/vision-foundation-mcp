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

  it('preserves standalone OCR boxes as text nodes and binds control text to detections', () => {
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

    expect(card.text).toBeUndefined();
    const textChildren = card.children.filter((c) => c.type === 'text');
    expect(textChildren.map((c) => c.text)).toEqual(['Card Title', 'desc']);
    expect(textChildren[0]!.bbox).toEqual(ocr[0]!.bbox);

    const leafTypes = card.children.map((c) => c.type).sort();
    expect(leafTypes).toEqual(['button', 'switch', 'text', 'text']);
  });

  it('uses the union of regions, detections, OCR and media as the fallback page bbox', () => {
    const layout: LayoutIR = {
      regions: [{ id: 'r', type: 'content', bbox: { x: 10, y: 10, w: 40, h: 40 }, relativeArea: 0.1, children: [] }],
      layoutType: 'stack',
      spacing: { averageGap: 0, scale: 'compact', verticalGaps: [], horizontalGaps: [] },
    };
    const ast = buildSemanticAst(
      layout,
      [{ text: 'Outside region', bbox: { x: 120, y: 80, w: 60, h: 20 }, confidence: 1 }],
      [{ type: 'button', bbox: { x: 200, y: 100, w: 80, h: 40 }, score: 0.9 }],
      [{ type: 'image', bbox: { x: 300, y: 160, w: 100, h: 80 }, nearbyText: undefined }],
    );

    expect(ast.root.bbox).toEqual({ x: 10, y: 10, w: 390, h: 230 });
    const ids = new Set<string>();
    const walk = (node: typeof ast.root): void => {
      ids.add(node.id);
      expect(node.bbox.x).toBeGreaterThanOrEqual(ast.root.bbox.x);
      expect(node.bbox.y).toBeGreaterThanOrEqual(ast.root.bbox.y);
      expect(node.bbox.x + node.bbox.w).toBeLessThanOrEqual(ast.root.bbox.x + ast.root.bbox.w);
      expect(node.bbox.y + node.bbox.h).toBeLessThanOrEqual(ast.root.bbox.y + ast.root.bbox.h);
      for (const child of node.children) walk(child);
    };
    walk(ast.root);
    expect(ids.size).toBeGreaterThan(4);
  });

  it('clips facts to an explicit page bbox and drops facts outside it', () => {
    const layout: LayoutIR = {
      regions: [{ id: 'partial', type: 'content', bbox: { x: -10, y: 20, w: 30, h: 20 }, relativeArea: 0.1, children: [] }],
      layoutType: 'stack',
      spacing: { averageGap: 0, scale: 'compact', verticalGaps: [], horizontalGaps: [] },
    };
    const ast = buildSemanticAst(
      layout,
      undefined,
      [{ type: 'button', bbox: { x: 120, y: 20, w: 20, h: 20 }, score: 1 }],
      undefined,
      { x: 0, y: 0, w: 100, h: 100 },
    );

    expect(ast.root.bbox).toEqual({ x: 0, y: 0, w: 100, h: 100 });
    expect(ast.root.children).toHaveLength(1);
    expect(ast.root.children[0]!.bbox).toEqual({ x: 0, y: 20, w: 20, h: 20 });
  });

  it('deduplicates overlapping duplicate detections and OCR facts', () => {
    const layout = makeLayout();
    const detection = { type: 'button', bbox: { x: 20, y: 60, w: 60, h: 24 }, score: 0.8 };
    const ocrItem = { text: 'Save', bbox: { x: 30, y: 64, w: 40, h: 16 }, confidence: 0.8 };
    const ast = buildSemanticAst(
      layout,
      [ocrItem, { ...ocrItem, confidence: 0.95 }],
      [detection, { ...detection, score: 0.99 }],
    );
    const nodes: typeof ast.root[] = [];
    const walk = (node: typeof ast.root): void => {
      nodes.push(node);
      for (const child of node.children) walk(child);
    };
    walk(ast.root);

    const buttons = nodes.filter((node) => node.type === 'button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.props.score).toBe(0.99);
    expect(buttons[0]!.text).toBe('Save');
    expect(buttons[0]!.props.confidence).toBe(0.95);
    expect(nodes.filter((node) => node.text === 'Save')).toHaveLength(1);
  });

  it('does not bind a long OCR label to a tiny icon containing only its center', () => {
    const layout: LayoutIR = {
      regions: [{ id: 'main', type: 'main', bbox: { x: 0, y: 0, w: 240, h: 100 }, relativeArea: 1, children: [] }],
      layoutType: 'stack',
      spacing: { averageGap: 0, scale: 'compact', verticalGaps: [], horizontalGaps: [] },
    };
    const label = { text: 'Very long label', bbox: { x: 10, y: 20, w: 180, h: 20 }, confidence: 0.9 };
    const ast = buildSemanticAst(
      layout,
      [label],
      undefined,
      [{ type: 'icon', bbox: { x: 95, y: 22, w: 10, h: 10 }, nearbyText: undefined }],
    );
    const main = ast.root.children[0]!;
    const icon = main.children.find((node) => node.type === 'icon');
    const text = main.children.find((node) => node.type === 'text');
    expect(icon?.text).toBeUndefined();
    expect(text?.text).toBe(label.text);
    expect(text?.bbox).toEqual(label.bbox);
  });

  it('preserves detector text, state and variant facts on component nodes', () => {
    const ast = buildSemanticAst(makeLayout(), undefined, [{
      type: 'button',
      bbox: { x: 20, y: 60, w: 60, h: 24 },
      score: 1,
      text: '保存',
      state: 'disabled',
      variant: 'primary',
    }]);
    const main = ast.root.children[0]!;
    const card = main.children[0]!;
    const button = card.children.find((node) => node.type === 'button');
    expect(button?.text).toBe('保存');
    expect(button?.props.state).toBe('disabled');
    expect(button?.props.variant).toBe('primary');
  });

  it('does not duplicate OCR already represented by detector text', () => {
    const bbox = { x: 20, y: 60, w: 60, h: 24 };
    const ast = buildSemanticAst(
      makeLayout(),
      [{ text: '保存', bbox, confidence: 0.9 }],
      [{ type: 'button', bbox, score: 1, text: '保存' }],
    );
    const matches: typeof ast.root[] = [];
    const walk = (node: typeof ast.root): void => {
      if (node.text === '保存') matches.push(node);
      for (const child of node.children) walk(child);
    };
    walk(ast.root);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.type).toBe('button');
  });
});
