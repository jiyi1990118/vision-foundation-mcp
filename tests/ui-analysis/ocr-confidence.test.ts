import { describe, expect, it } from 'vitest';
import { runUiAnalysis } from '../../src/ui-analysis/orchestrator.js';
import type { UiLayoutExtraction } from '../../src/core/extractors/ui-layout-extractor.js';
import type { OcrItem } from '../../src/core/key-content-extractor.js';

function makeLayout(texts: UiLayoutExtraction['texts']): UiLayoutExtraction {
  return {
    structure: {
      pageType: 'admin-ui',
      layoutType: 'centered',
      regions: [
        { id: 'r0', type: 'header', bbox: { x: 0, y: 0, w: 300, h: 50 }, relativeArea: 1, children: [] },
      ],
    },
    components: [],
    texts,
    spacing: { averageGap: 10, scale: 'comfortable', verticalGaps: [], horizontalGaps: [] },
    mediaAreas: [],
    summary: '',
  };
}

function findTextChild(node: { children: { text?: string; props: Record<string, unknown> }[] }, text: string) {
  return node.children.find((c) => c.text === text);
}

describe('OCR confidence propagation (S30 G-D2)', () => {
  it('threads real OCR confidence into AST text node props', async () => {
    const ocrItems: OcrItem[] = [
      { text: 'First', box: { x1: 10, y1: 10, x2: 50, y2: 20 }, confidence: 0.9, source: 'full' },
      { text: 'Second', box: { x1: 100, y1: 10, x2: 140, y2: 20 }, confidence: 0.5, source: 'full' },
    ];

    const result = await runUiAnalysis({
      uiLayoutExtraction: makeLayout([]),
      ocrItems,
      options: { buildTree: true },
    });

    expect(result.ui).toBeDefined();
    const header = result.ui!.root.children[0]!;
    const textChild = findTextChild(header, 'Second');
    expect(textChild).toBeDefined();
    expect(textChild!.props.confidence).toBe(0.5);
  });

  it('falls back to legacy confidence:1 from mappers when no ocrItems supplied', async () => {
    const result = await runUiAnalysis({
      uiLayoutExtraction: makeLayout([
        { text: 'First', bbox: { x: 10, y: 10, w: 40, h: 10 }, estimatedLevel: 'body' },
        { text: 'Second', bbox: { x: 100, y: 10, w: 40, h: 10 }, estimatedLevel: 'body' },
      ]),
      options: { buildTree: true },
    });

    expect(result.ui).toBeDefined();
    const header = result.ui!.root.children[0]!;
    const textChild = findTextChild(header, 'Second');
    expect(textChild).toBeDefined();
    expect(textChild!.props.confidence).toBe(1);
  });
});
