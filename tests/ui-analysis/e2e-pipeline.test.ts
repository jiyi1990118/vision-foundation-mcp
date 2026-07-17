import { describe, expect, it } from 'vitest';
import { analyzeUiPipeline } from '../../src/ui-analysis/pipeline.js';
import type { UiLayoutExtraction } from '../../src/core/extractors/ui-layout-extractor.js';
import type { ASTNode } from '../../src/ui-analysis/ir/types.js';

function makeRichLayout(): UiLayoutExtraction {
  return {
    structure: {
      pageType: 'admin-ui',
      layoutType: 'sidebar',
      regions: [
        { id: 'r-header', type: 'header', bbox: { x: 0, y: 0, w: 800, h: 60 }, relativeArea: 0.06, children: [] },
        { id: 'r-sidebar', type: 'sidebar', bbox: { x: 0, y: 60, w: 160, h: 540 }, relativeArea: 0.18, children: [] },
        { id: 'r-main', type: 'main', bbox: { x: 160, y: 60, w: 640, h: 540 }, relativeArea: 0.7, children: [] },
        { id: 'r-card', type: 'card', bbox: { x: 200, y: 100, w: 400, h: 300 }, relativeArea: 0.5, children: [] },
      ],
    },
    components: [
      { type: 'tab', bbox: { x: 220, y: 120, w: 60, h: 28 }, text: '', state: 'default', variant: 'default' },
      { type: 'input', bbox: { x: 220, y: 200, w: 200, h: 32 }, text: '', state: 'default', variant: 'default' },
      { type: 'button', bbox: { x: 220, y: 340, w: 100, h: 36 }, text: '', state: 'default', variant: 'primary' },
    ],
    texts: [
      { text: 'Dashboard Title', bbox: { x: 20, y: 20, w: 200, h: 20 }, estimatedLevel: 'heading' },
      { text: 'Card Heading', bbox: { x: 220, y: 140, w: 120, h: 24 }, estimatedLevel: 'heading' },
      { text: 'Save', bbox: { x: 230, y: 348, w: 40, h: 16 }, estimatedLevel: 'body' },
    ],
    spacing: { averageGap: 12, scale: 'comfortable', verticalGaps: [48, 108], horizontalGaps: [20] },
    mediaAreas: [],
    summary: 'rich 3-region layout with components and texts',
  };
}

function findWithParent(
  root: ASTNode,
  pred: (n: ASTNode) => boolean,
  parent?: ASTNode,
): { node: ASTNode; parent?: ASTNode } | undefined {
  if (pred(root)) return { node: root, parent };
  for (const child of root.children) {
    const found = findWithParent(child, pred, root);
    if (found) return found;
  }
  return undefined;
}

describe('ui-analysis e2e pipeline', () => {
  const layout = makeRichLayout();

  it('root is a page node with children', () => {
    const r = analyzeUiPipeline({ uiLayoutExtraction: layout });
    expect(r.ui).toBeDefined();
    expect(r.ui!.root.type).toBe('page');
    expect(r.ui!.root.children.length).toBeGreaterThan(0);
  });

  it('nests a component under its containing region', () => {
    const r = analyzeUiPipeline({ uiLayoutExtraction: layout });
    const match = findWithParent(r.ui!.root, (n) => n.type === 'button');
    expect(match).toBeDefined();
    expect(match!.parent).toBeDefined();
    expect(match!.parent!.props.regionId).toBe('r-card');
  });

  it('binds OCR text to the innermost enclosing container', () => {
    const r = analyzeUiPipeline({ uiLayoutExtraction: layout });
    const match = findWithParent(r.ui!.root, (n) => n.props.regionId === 'r-card');
    expect(match).toBeDefined();
    expect(match!.node.text).toBe('Card Heading');
  });

  it('produces codegenIr with constraints when exportCodegen is true', () => {
    const r = analyzeUiPipeline({ uiLayoutExtraction: layout, options: { exportCodegen: true } });
    expect(r.codegenIr).toBeDefined();
    expect(Array.isArray(r.codegenIr!.constraints)).toBe(true);
    expect(r.codegenIr!.constraints.length).toBeGreaterThan(0);
  });

  it('produces a FRAME figma document with children when exportFigma is true', () => {
    const r = analyzeUiPipeline({ uiLayoutExtraction: layout, options: { exportFigma: true } });
    expect(r.figma).toBeDefined();
    const doc = r.figma as { document: { type: string; children: unknown[] } };
    expect(doc.document.type).toBe('FRAME');
    expect(doc.document.children.length).toBeGreaterThan(0);
  });

  it('is deterministic across two runs with identical input', () => {
    const opts = { buildTree: true, exportCodegen: true, exportFigma: true, exportMarkdown: true };
    const r1 = analyzeUiPipeline({ uiLayoutExtraction: layout, options: opts });
    const r2 = analyzeUiPipeline({ uiLayoutExtraction: layout, options: opts });
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });

  it('omits ui when buildTree is false but still exports codegen', () => {
    const r = analyzeUiPipeline({
      uiLayoutExtraction: layout,
      options: { buildTree: false, exportCodegen: true },
    });
    expect(r.ui).toBeUndefined();
    expect(r.codegenIr).toBeDefined();
    expect(r.codegenIr!.root.type).toBe('page');
  });

  it('degrades gracefully on empty regions with a zero page bbox', () => {
    const empty: UiLayoutExtraction = {
      structure: { pageType: 'empty', layoutType: 'stack', regions: [] },
      components: [],
      texts: [],
      spacing: { averageGap: 0, scale: 'comfortable', verticalGaps: [], horizontalGaps: [] },
      mediaAreas: [],
      summary: 'empty',
    };
    const r = analyzeUiPipeline({ uiLayoutExtraction: empty });
    expect(r.ui).toBeDefined();
    expect(r.ui!.root.type).toBe('page');
    expect(r.ui!.root.bbox).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });
});
