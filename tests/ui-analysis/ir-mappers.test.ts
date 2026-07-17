import { describe, expect, it } from 'vitest';
import { toVisionIRFromLayout, toLayoutIR } from '../../src/ui-analysis/ir/mappers.js';
import type { UiLayoutExtraction } from '../../src/core/extractors/ui-layout-extractor.js';
import type { DesignExtraction } from '../../src/core/extractors/design-extractor.js';

function makeLayout(): UiLayoutExtraction {
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
    mediaAreas: [{ bbox: { x: 100, y: 60, w: 20, h: 20 }, type: 'icon', nearbyText: undefined }],
    summary: '2 个视觉区域（header/sidebar），1 个组件',
  };
}

function makeDesign(): DesignExtraction {
  return {
    palette: [
      { hex: '#ffffff', rgb: [255, 255, 255], role: 'background', frequency: 0.8 },
      { hex: '#1890ff', rgb: [24, 144, 255], role: 'primary', frequency: 0.1 },
      { hex: '#333333', rgb: [51, 51, 51], role: 'text', frequency: 0.05 },
    ],
    background: '#ffffff',
    primary: '#1890ff',
    textColor: '#333333',
    isDarkMode: false,
    contrastRatio: 12.63,
    colorCount: 3,
    summary: '浅色模式，3 色配色方案',
  };
}

describe('ir mappers', () => {
  it('maps UiLayoutExtraction components and texts into VisionIR', () => {
    const ext = makeLayout();
    const ir = toVisionIRFromLayout(ext);

    expect(ir.detections).toHaveLength(1);
    expect(ir.detections[0]!.type).toBe('button');
    expect(ir.detections[0]!.bbox).toEqual({ x: 300, y: 280, w: 40, h: 18 });
    expect(ir.detections[0]!.score).toBe(1);

    expect(ir.ocr).toHaveLength(1);
    expect(ir.ocr[0]!.text).toBe('商品管理');
    expect(ir.ocr[0]!.bbox).toEqual({ x: 10, y: 50, w: 60, h: 16 });
    expect(ir.ocr[0]!.confidence).toBe(1);

    expect(ir.masks).toBeUndefined();
    expect(ir.colorSamples).toBeUndefined();
  });

  it('maps UiLayoutExtraction into LayoutIR without theme when design is absent', () => {
    const ext = makeLayout();
    const layout = toLayoutIR(ext);

    expect(layout.regions).toHaveLength(2);
    expect(layout.regions[0]!.id).toBe('r0');
    expect(layout.layoutType).toBe('sidebar');
    expect(layout.spacing.scale).toBe('comfortable');
    expect(layout.spacing.averageGap).toBe(8);
    expect(layout.theme).toBeUndefined();
  });

  it('attaches theme from DesignExtraction when provided', () => {
    const ext = makeLayout();
    const design = makeDesign();
    const layout = toLayoutIR(ext, design);

    expect(layout.theme).toBeDefined();
    expect(layout.theme!.background).toBe('#ffffff');
    expect(layout.theme!.primary).toBe('#1890ff');
    expect(layout.theme!.textColor).toBe('#333333');
    expect(layout.theme!.isDarkMode).toBe(false);
    expect(layout.theme!.contrastRatio).toBe(12.63);
    expect(layout.theme!.palette).toHaveLength(3);
    expect(layout.theme!.palette[1]!.rgb).toEqual([24, 144, 255]);
  });
});
