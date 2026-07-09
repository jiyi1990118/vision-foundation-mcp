import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
  buildStructuredContent,
  enhanceRegionOcr,
  extractKeyContent,
  extractOcrItems,
  itemsInsideRegion,
  resolveTargetRegion,
  shouldExtractKeyContent,
} from '../src/core/key-content-extractor.js';
import type { VisionProvider } from '../src/providers/types.js';
import type { InferenceRequest, InferenceResponse } from '../src/types/domain.js';

class FakeOcrProvider implements VisionProvider {
  readonly name = 'fake-ocr';
  readonly runtime = 'native-ocr';
  readonly supportedRuntimes = ['native-ocr'];
  readonly supportedSkills = ['ocr'];
  readonly requirements = { minMemoryMB: 1, gpuRequired: false, modelSizeMB: 1 };
  lastImageSize = 0;
  lastImageMetadata: sharp.Metadata | undefined;

  async load(): Promise<void> {}
  async unload(): Promise<void> {}
  isLoaded(): boolean { return true; }

  async infer(req: InferenceRequest): Promise<InferenceResponse> {
    this.lastImageSize = req.image.buffer.length;
    this.lastImageMetadata = await sharp(req.image.buffer).metadata();
    return {
      text: JSON.stringify({
        texts: [
          { text: '(元)', position: '100,100,180,150', confidence: 0.99 },
          { text: '¥', position: '220,260,250,310', confidence: 0.9 },
        ],
        language: 'zh',
      }),
      duration: 1,
    };
  }
}

describe('key-content extractor activation', () => {
  it('activates when options.target is provided', () => {
    expect(shouldExtractKeyContent({
      target: { color: 'red', description: '虚线红框中的内容' },
      intent: 'auto',
      annotations: undefined,
      skillNames: ['classify', 'summary'],
    })).toBe(true);
  });

  it('activates for region extraction intent keywords', () => {
    expect(shouldExtractKeyContent({
      intent: '请提取红色虚线框中的内容',
      annotations: undefined,
      skillNames: ['ocr', 'summary'],
    })).toBe(true);
  });

  it('does not activate for classification-only requests', () => {
    expect(shouldExtractKeyContent({
      intent: 'classify this image',
      annotations: { redBoxes: [{ box: '10,10,100,100', confidence: 0.8, insideText: [], insideTextLines: [], nearbyText: [] }] },
      skillNames: ['classify'],
    })).toBe(false);
  });

  it('does not activate for generic table analysis without target or annotations', () => {
    expect(shouldExtractKeyContent({
      intent: '分析这个表格',
      annotations: undefined,
      skillNames: ['classify', 'summary'],
    })).toBe(false);
  });

  it('activates when annotations exist and OCR or summary is requested', () => {
    expect(shouldExtractKeyContent({
      intent: '分析这个需求截图',
      annotations: { redBoxes: [{ box: '10,10,100,100', confidence: 0.8, insideText: [], insideTextLines: [], nearbyText: [] }] },
      skillNames: ['ocr', 'summary'],
    })).toBe(true);
  });
});

describe('key-content target resolution', () => {
  it('prefers red annotation boxes when color is red', () => {
    const region = resolveTargetRegion({
      target: { color: 'red', position: 'right' },
      annotations: {
        redBoxes: [
          { box: '10,10,100,100', confidence: 0.7, insideText: [], insideTextLines: [], nearbyText: [] },
          { box: '400,50,700,300', confidence: 0.8, insideText: [], insideTextLines: [], nearbyText: [] },
        ],
      },
      ocrItems: [],
    });

    expect(region).toMatchObject({ type: 'redBox', box: '400,50,700,300', confidence: 0.8 });
  });

  it('returns undefined for non-red explicit color when only red boxes exist', () => {
    const region = resolveTargetRegion({
      target: { color: 'blue' },
      annotations: {
        redBoxes: [{ box: '10,10,100,100', confidence: 0.7, insideText: [], insideTextLines: [], nearbyText: [] }],
      },
      ocrItems: [],
    });

    expect(region).toBeUndefined();
  });

  it('can derive a right-side layout region from OCR items without annotations', () => {
    const region = resolveTargetRegion({
      target: { position: 'right', description: '右侧价格列' },
      ocrItems: [
        { text: '名称', box: { x1: 100, y1: 100, x2: 180, y2: 130 } },
        { text: '价格', box: { x1: 500, y1: 100, x2: 580, y2: 130 } },
        { text: '0.00', box: { x1: 500, y1: 160, x2: 580, y2: 190 } },
        { text: '0.00', box: { x1: 500, y1: 220, x2: 580, y2: 250 } },
      ],
    });

    expect(region?.type).toBe('layoutRegion');
    expect(region?.box).toBe('500,100,580,250');
  });
});

describe('OCR region extraction helpers', () => {
  it('extracts OCR items with boxes, confidence, and source from array-shaped data', () => {
    const items = extractOcrItems([
      { text: 'Total', box: { x1: 10, y1: 20, x2: 60, y2: 40 }, confidence: 0.98 },
      { text: 'ignored-without-box' },
      { text: '  ', box: { x1: 1, y1: 1, x2: 2, y2: 2 } },
      'raw text entry',
    ], 'local');

    expect(items).toEqual([
      { text: 'Total', box: { x1: 10, y1: 20, x2: 60, y2: 40 }, confidence: 0.98, source: 'local' },
      { text: 'ignored-without-box', source: 'local' },
      { text: 'raw text entry', source: 'local' },
    ]);
  });

  it('extracts Task 3 OCR texts and keeps text-only entries', () => {
    const items = extractOcrItems({
      texts: [
        { text: '默认基础价-半份', position: '1466,529,1688,567', confidence: 0.99 },
        { text: ' ', position: '0,0,1,1' },
        '无坐标文本',
      ],
    });

    expect(items).toEqual([
      { text: '默认基础价-半份', box: { x1: 1466, y1: 529, x2: 1688, y2: 567 }, confidence: 0.99, source: 'full' },
      { text: '无坐标文本', source: 'full' },
    ]);
  });

  it('extracts OCR items from nested provider result shapes', () => {
    const items = extractOcrItems({
      ocr: {
        items: [
          { text: 'SKU', boundingBox: [100, 50, 160, 80] },
          { text: 'Name', bbox: { x: 180, y: 50, width: 120, height: 30 }, confidence: '0.87' },
        ],
      },
    });

    expect(items).toEqual([
      { text: 'SKU', box: { x1: 100, y1: 50, x2: 160, y2: 80 }, source: 'full' },
      { text: 'Name', box: { x1: 180, y1: 50, x2: 300, y2: 80 }, confidence: 0.87, source: 'full' },
    ]);
  });

  it('returns OCR items with center in expanded region or substantial overlap', () => {
    const items = extractOcrItems([
      { text: 'inside', box: { x1: 11, y1: 11, x2: 49, y2: 49 } },
      { text: 'same-edge', box: { x1: 10, y1: 11, x2: 49, y2: 49 } },
      { text: 'touches-outside-edge', box: { x1: 9, y1: 11, x2: 49, y2: 49 } },
      { text: 'near-left-center', box: { x1: 0, y1: 20, x2: 16, y2: 30 } },
      { text: 'overlaps-right-edge', box: { x1: 45, y1: 11, x2: 51, y2: 49 } },
      { text: 'substantial-overlap', box: { x1: 48, y1: 20, x2: 58, y2: 30 } },
      { text: 'minimal-overlap', box: { x1: 48, y1: 60, x2: 68, y2: 80 } },
      { text: 'no-box' },
      'text-only',
    ]);

    expect(itemsInsideRegion(items, { x1: 10, y1: 10, x2: 50, y2: 50 }).map((item) => item.text)).toEqual([
      'inside',
      'same-edge',
      'touches-outside-edge',
      'near-left-center',
      'overlaps-right-edge',
      'substantial-overlap',
    ]);
  });

  it('excludes TAPD header text outside the right-side annotation region', () => {
    const items = extractOcrItems([
      { text: '默认附加价(元)', box: { x1: 1252, y1: 542, x2: 1457, y2: 584 } },
      { text: '默认基础价-半份', box: { x1: 1466, y1: 529, x2: 1688, y2: 567 } },
    ]);

    expect(itemsInsideRegion(items, { x1: 1450, y1: 500, x2: 1918, y2: 1090 }).map((item) => item.text)).toEqual([
      '默认基础价-半份',
    ]);
  });
});

describe('key-content table reconstruction', () => {
  it('merges wrapped two-column headers and reconstructs rows', () => {
    const extraction = buildStructuredContent([
      { text: '默认基础价-半份', box: { x1: 1466, y1: 529, x2: 1688, y2: 567 } },
      { text: '默认附加价-半份', box: { x1: 1680, y1: 529, x2: 1903, y2: 567 } },
      { text: '(元)', box: { x1: 1543, y1: 564, x2: 1605, y2: 600 }, source: 'local' },
      { text: '(元)', box: { x1: 1763, y1: 564, x2: 1824, y2: 600 }, source: 'local' },
      { text: '0.00', box: { x1: 1483, y1: 626, x2: 1571, y2: 680 } },
      { text: '¥', box: { x1: 1578, y1: 631, x2: 1605, y2: 675 }, source: 'local' },
      { text: '0.00', box: { x1: 1697, y1: 630, x2: 1789, y2: 672 } },
      { text: '¥', box: { x1: 1798, y1: 631, x2: 1824, y2: 675 }, source: 'local' },
      { text: '0.00', box: { x1: 1483, y1: 710, x2: 1571, y2: 752 } },
      { text: '夫', box: { x1: 1578, y1: 710, x2: 1605, y2: 752 }, source: 'local' },
      { text: '0.00', box: { x1: 1697, y1: 701, x2: 1793, y2: 756 } },
      { text: '夫', box: { x1: 1798, y1: 710, x2: 1824, y2: 752 }, source: 'local' },
    ], { type: 'redBox', box: '1450,500,1918,1090', confidence: 0.75 });

    expect(extraction.table).toEqual({
      columns: ['默认基础价-半份（元）', '默认附加价-半份（元）'],
      rows: [
        ['0.00 ¥', '0.00 ¥'],
        ['0.00 ¥', '0.00 ¥'],
      ],
    });
    expect(extraction.summary).toContain('默认基础价-半份（元）');
    expect(extraction.summary).toContain('共 2 行');
    expect(extraction.warnings).toEqual(expect.arrayContaining(['局部 OCR 将金额符号候选“夫”按金额上下文归一化为“¥”']));
  });

  it('preserves the first data row when headers are a single line', () => {
    const extraction = buildStructuredContent([
      { text: '名称', box: { x1: 100, y1: 100, x2: 150, y2: 130 } },
      { text: '数量', box: { x1: 220, y1: 100, x2: 270, y2: 130 } },
      { text: '苹果', box: { x1: 100, y1: 160, x2: 150, y2: 190 } },
      { text: '2', box: { x1: 220, y1: 160, x2: 240, y2: 190 } },
      { text: '香蕉', box: { x1: 100, y1: 220, x2: 150, y2: 250 } },
      { text: '5', box: { x1: 220, y1: 220, x2: 240, y2: 250 } },
    ], { type: 'layoutRegion', box: '90,90,300,260', confidence: 0.55 });

    expect(extraction.table).toEqual({
      columns: ['名称', '数量'],
      rows: [
        ['苹果', '2'],
        ['香蕉', '5'],
      ],
    });
  });

  it('reconstructs mixed text and number cells in table rows', () => {
    const extraction = buildStructuredContent([
      { text: '商品', box: { x1: 100, y1: 100, x2: 150, y2: 130 } },
      { text: '库存', box: { x1: 220, y1: 100, x2: 270, y2: 130 } },
      { text: '状态', box: { x1: 340, y1: 100, x2: 390, y2: 130 } },
      { text: 'A套餐', box: { x1: 100, y1: 160, x2: 155, y2: 190 } },
      { text: '12', box: { x1: 220, y1: 160, x2: 245, y2: 190 } },
      { text: '启用', box: { x1: 340, y1: 160, x2: 390, y2: 190 } },
      { text: 'B套餐', box: { x1: 100, y1: 220, x2: 155, y2: 250 } },
      { text: '0', box: { x1: 220, y1: 220, x2: 240, y2: 250 } },
      { text: '停用', box: { x1: 340, y1: 220, x2: 390, y2: 250 } },
    ], { type: 'layoutRegion', box: '90,90,420,260', confidence: 0.55 });

    expect(extraction.table).toEqual({
      columns: ['商品', '库存', '状态'],
      rows: [
        ['A套餐', '12', '启用'],
        ['B套餐', '0', '停用'],
      ],
    });
  });

  it('deduplicates overlapping OCR amounts before normalizing table currency cells', () => {
    const extraction = buildStructuredContent([
      { text: '默认基础价-半份', box: { x1: 1466, y1: 529, x2: 1688, y2: 567 } },
      { text: '默认附加价-半份', box: { x1: 1680, y1: 529, x2: 1903, y2: 567 } },
      { text: '0.00', box: { x1: 1483, y1: 626, x2: 1571, y2: 680 }, source: 'full' },
      { text: '0.00', box: { x1: 1485, y1: 628, x2: 1570, y2: 679 }, source: 'local' },
      { text: '夫', box: { x1: 1578, y1: 631, x2: 1605, y2: 675 }, source: 'local' },
      { text: '0.00', box: { x1: 1697, y1: 630, x2: 1789, y2: 672 } },
      { text: '夫', box: { x1: 1798, y1: 631, x2: 1824, y2: 675 }, source: 'local' },
    ], { type: 'redBox', box: '1450,500,1918,1090', confidence: 0.75 });

    expect(extraction.table).toEqual({
      columns: ['默认基础价-半份', '默认附加价-半份'],
      rows: [['0.00 ¥', '0.00 ¥']],
    });
    expect(extraction.table?.rows[0]?.[0]).not.toBe('0.00 夫');
    expect(extraction.table?.rows[0]?.[0]).not.toBe('0.00 0.00 ¥');
  });

  it('normalizes table cells containing amount and OCR currency candidate tokens', () => {
    const extraction = buildStructuredContent([
      { text: '默认基础价-半份', box: { x1: 1466, y1: 529, x2: 1688, y2: 567 } },
      { text: '默认附加价-半份', box: { x1: 1680, y1: 529, x2: 1903, y2: 567 } },
      { text: '0.00', box: { x1: 1483, y1: 626, x2: 1571, y2: 680 } },
      { text: '夫', box: { x1: 1578, y1: 631, x2: 1605, y2: 675 }, source: 'local' },
      { text: '0.00', box: { x1: 1697, y1: 630, x2: 1789, y2: 672 }, source: 'full' },
      { text: '0.00', box: { x1: 1699, y1: 632, x2: 1788, y2: 671 }, source: 'local' },
      { text: '¥', box: { x1: 1798, y1: 631, x2: 1824, y2: 675 }, source: 'local' },
    ], { type: 'redBox', box: '1450,500,1918,1090', confidence: 0.75 });

    expect(extraction.table).toEqual({
      columns: ['默认基础价-半份', '默认附加价-半份'],
      rows: [['0.00 ¥', '0.00 ¥']],
    });
  });

  it('does not normalize 夫 when it is not next to a numeric amount', () => {
    const extraction = buildStructuredContent([
      { text: '负责人', box: { x1: 100, y1: 100, x2: 180, y2: 130 } },
      { text: '夫', box: { x1: 100, y1: 160, x2: 130, y2: 190 } },
    ], { type: 'layoutRegion', box: '100,100,200,200', confidence: 0.55 });

    expect(extraction.textLines).toEqual(['负责人', '夫']);
    expect(extraction.summary).toContain('负责人');
    expect(extraction.warnings).not.toEqual(expect.arrayContaining(['局部 OCR 将金额符号候选“夫”按金额上下文归一化为“¥”']));
  });
});

describe('key-content local OCR enhancement', () => {
  it('runs OCR on an upscaled crop and maps local positions back to original coordinates', async () => {
    const buffer = await sharp({ create: { width: 300, height: 300, channels: 3, background: 'white' } }).png().toBuffer();
    const provider = new FakeOcrProvider();
    const items = await enhanceRegionOcr({
      image: { buffer, mimeType: 'image/png', source: 'synthetic', size: buffer.length },
      region: { x1: 50, y1: 60, x2: 250, y2: 260 },
      provider,
      scale: 4,
    });

    expect(items).toEqual([
      { text: '(元)', box: { x1: 77, y1: 87, x2: 97, y2: 100 }, confidence: 0.99, source: 'local' },
      { text: '¥', box: { x1: 107, y1: 127, x2: 115, y2: 140 }, confidence: 0.9, source: 'local' },
    ]);
    expect(provider.lastImageSize).toBeGreaterThan(0);
    expect(provider.lastImageMetadata).toMatchObject({
      width: (250 - 50 - 4) * 4,
      height: (260 - 60 - 4) * 4,
      channels: 3,
    });
  });
});

describe('extractKeyContent', () => {
  it('extracts a red-box two-column table without adjacent outside headers', async () => {
    const buffer = await sharp({ create: { width: 2200, height: 1200, channels: 3, background: 'white' } }).png().toBuffer();
    const provider = new FakeOcrProvider();
    provider.infer = async () => ({
      text: JSON.stringify({
        texts: [
          { text: '(元)', position: '412,256,660,400', confidence: 0.99 },
          { text: '(元)', position: '1292,256,1540,400', confidence: 0.99 },
          { text: '¥', position: '512,524,620,700', confidence: 0.9 },
          { text: '¥', position: '1392,524,1500,700', confidence: 0.9 },
        ],
        language: 'zh',
      }),
      duration: 1,
    });

    const extraction = await extractKeyContent({
      image: { buffer, mimeType: 'image/png', source: 'synthetic', size: buffer.length },
      target: { color: 'red', position: 'right', description: '虚线红框中的内容' },
      annotations: {
        redBoxes: [{
          box: '1450,500,1918,1090',
          confidence: 0.75,
          insideText: ['默认基础价-半份', '默认附加价-半份', '0.00'],
          insideTextLines: ['默认基础价-半份', '默认附加价-半份', '0.00', '0.00'],
          nearbyText: [],
        }],
      },
      ocrData: {
        texts: [
          { text: '默认附加价(元)', position: '1252,542,1457,584', confidence: 0.99 },
          { text: '默认基础价-半份', position: '1466,529,1688,567', confidence: 0.99 },
          { text: '默认附加价-半份', position: '1680,529,1903,567', confidence: 0.99 },
          { text: '0.00', position: '1483,626,1571,680', confidence: 0.99 },
          { text: '0.00', position: '1697,630,1789,672', confidence: 0.99 },
        ],
      },
      ocrProvider: provider,
    });

    expect(extraction?.textLines.join('\n')).not.toContain('默认附加价(元)');
    expect(extraction?.table).toEqual({
      columns: ['默认基础价-半份（元）', '默认附加价-半份（元）'],
      rows: [['0.00 ¥', '0.00 ¥']],
    });
  });
});
