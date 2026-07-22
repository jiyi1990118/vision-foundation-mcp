import { describe, expect, it } from 'vitest';
import { runUiAnalysis } from '../../src/ui-analysis/orchestrator.js';
import type { UiLayoutExtraction } from '../../src/core/extractors/ui-layout-extractor.js';
import type { DesignExtraction } from '../../src/core/extractors/design-extractor.js';
import type { ASTNode } from '../../src/ui-analysis/ir/types.js';

function makeLayout(): UiLayoutExtraction {
  return {
    structure: {
      pageType: 'admin-ui',
      layoutType: 'sidebar',
      regions: [
        { id: 'r0', type: 'header', bbox: { x: 0, y: 0, w: 300, h: 50 }, relativeArea: 0.25, bgColor: '#1677ff', children: [] },
        { id: 'r1', type: 'card', bbox: { x: 20, y: 70, w: 120, h: 80 }, relativeArea: 0.2, bgColor: '#ffffff', children: [] },
      ],
    },
    components: [
      { type: 'button', bbox: { x: 40, y: 80, w: 80, h: 24 }, text: '保存', state: 'default', variant: 'primary' },
      { type: 'input', bbox: { x: 40, y: 120, w: 80, h: 24 }, text: '请输入', state: 'default', variant: 'default' },
    ],
    texts: [
      { text: '标题', bbox: { x: 10, y: 10, w: 40, h: 20 }, estimatedLevel: 'title' },
      { text: '保存', bbox: { x: 45, y: 84, w: 30, h: 16 }, estimatedLevel: 'body' },
      { text: '取消', bbox: { x: 50, y: 90, w: 30, h: 16 }, estimatedLevel: 'body' },
    ],
    spacing: { averageGap: 10, scale: 'comfortable', verticalGaps: [10], horizontalGaps: [10] },
    mediaAreas: [
      { bbox: { x: 250, y: 10, w: 24, h: 24 }, type: 'icon', nearbyText: '搜索' },
      { bbox: { x: 270, y: 10, w: 24, h: 24 }, type: 'logo', nearbyText: 'Logo' },
    ],
    summary: '',
  };
}

function makeDesign(): DesignExtraction {
  return {
    palette: [
      { hex: '#1677ff', rgb: [22, 119, 255], role: 'primary', frequency: 0.5 },
      { hex: '#ffffff', rgb: [255, 255, 255], role: 'background', frequency: 0.4 },
      { hex: '#000000', rgb: [0, 0, 0], role: 'text', frequency: 0.1 },
    ],
    background: '#ffffff',
    primary: '#1677ff',
    textColor: '#000000',
    isDarkMode: false,
    contrastRatio: 21,
    colorCount: 3,
    summary: '',
  };
}

function collectTypes(node: ASTNode, acc: string[] = []): string[] {
  acc.push(node.type);
  for (const child of node.children) collectTypes(child, acc);
  return acc;
}

describe('runUiAnalysis detect_* toggles (S24 G-B1)', () => {
  it('detect_component=false omits button/input component nodes', async () => {
    const result = await runUiAnalysis({
      uiLayoutExtraction: makeLayout(),
      designExtraction: makeDesign(),
      options: { detectComponent: false },
    });

    expect(result.uiReconstruction).toBeDefined();
    const types = collectTypes(result.uiReconstruction!.tree);
    expect(types).not.toContain('button');
    expect(types).not.toContain('input');
    expect(types).toContain('page');
  });

  it('detect_component=false does not re-infer a button from a styled region', async () => {
    const layout = makeLayout();
    layout.structure.regions = [{
      id: 'cta',
      type: 'content',
      bbox: { x: 20, y: 70, w: 120, h: 40 },
      relativeArea: 0.2,
      bgColor: '#1677ff',
      children: [],
    }];
    layout.components = [];
    layout.texts = [{ text: '保存', bbox: { x: 40, y: 80, w: 80, h: 24 }, estimatedLevel: 'body' }];
    const result = await runUiAnalysis({
      uiLayoutExtraction: layout,
      options: { detectComponent: false },
    });
    expect(collectTypes(result.uiReconstruction!.tree)).not.toContain('button');
  });

  it('detect_text=false omits text child nodes', async () => {
    const result = await runUiAnalysis({
      uiLayoutExtraction: makeLayout(),
      options: { detectText: false },
    });

    expect(result.uiReconstruction).toBeDefined();
    const types = collectTypes(result.uiReconstruction!.tree);
    expect(types).not.toContain('text');
  });

  it('detect_text=false also ignores externally supplied OCR items', async () => {
    const result = await runUiAnalysis({
      uiLayoutExtraction: makeLayout(),
      ocrItems: [{
        text: '外部OCR',
        box: { x1: 30, y1: 20, x2: 120, y2: 40 },
        confidence: 0.99,
      }],
      options: { detectText: false },
    });

    const texts: string[] = [];
    const walk = (node: ASTNode): void => {
      if (node.text) texts.push(node.text);
      for (const child of node.children) walk(child);
    };
    walk(result.uiReconstruction!.tree);
    expect(texts).not.toContain('外部OCR');
    expect(texts).toEqual([]);
  });

  it('detect_icon=false empties imageContents', async () => {
    const result = await runUiAnalysis({
      uiLayoutExtraction: makeLayout(),
      options: { detectIcon: false },
    });

    expect(result.imageContents).toBeDefined();
    expect(result.imageContents!.length).toBe(0);
    const types = collectTypes(result.uiReconstruction!.tree);
    expect(types).not.toContain('icon');
    expect(types).not.toContain('image');
    expect(types).not.toContain('avatar');
  });

  it('detect_theme=false omits the theme field from uiReconstruction', async () => {
    const result = await runUiAnalysis({
      uiLayoutExtraction: makeLayout(),
      designExtraction: makeDesign(),
      options: { detectTheme: false },
    });

    expect(result.uiReconstruction).toBeDefined();
    expect('theme' in result.uiReconstruction!).toBe(false);
    expect(result.uiReconstruction!.theme).toBeUndefined();
  });

  it('detect_layout=false clears constraints', async () => {
    const result = await runUiAnalysis({
      uiLayoutExtraction: makeLayout(),
      options: { detectLayout: false },
    });

    expect(result.uiReconstruction).toBeDefined();
    expect(result.uiReconstruction!.constraints).toEqual([]);
  });

  it('detect_layout=false also clears constraints in an exported CodegenIR', async () => {
    const result = await runUiAnalysis({
      uiLayoutExtraction: makeLayout(),
      options: { detectLayout: false, exportCodegen: true },
    });
    expect(result.codegenIr!.constraints).toEqual([]);
    expect(result.codegenIr!.responsive).toEqual([]);
  });

  it('strict_mode=true with valid input does not throw and produces uiReconstruction', async () => {
    const result = await runUiAnalysis({
      uiLayoutExtraction: makeLayout(),
      designExtraction: makeDesign(),
      options: { strictMode: true },
    });

    expect(result.uiReconstruction).toBeDefined();
    expect(result.uiReconstruction!.tree.type).toBe('page');
    expect(result.uiReconstruction!.stats.nodeCount).toBeGreaterThan(0);
  });

  it('default options preserve components/text/icons (no regression)', async () => {
    const result = await runUiAnalysis({
      uiLayoutExtraction: makeLayout(),
      designExtraction: makeDesign(),
      options: {},
    });

    const types = collectTypes(result.uiReconstruction!.tree);
    expect(types).toContain('button');
    expect(result.imageContents!.length).toBe(2);
    expect('theme' in result.uiReconstruction!).toBe(true);
    expect(result.uiReconstruction!.constraints.length).toBeGreaterThan(0);
  });
});
