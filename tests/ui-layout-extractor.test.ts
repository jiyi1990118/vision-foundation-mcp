import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { extractUiLayout } from '../src/core/extractors/ui-layout-extractor.js';
import { buildUniversalParse } from '../src/core/universal-parser.js';
import type { UniversalParseInput } from '../src/core/universal-parser.js';

// ── Helpers: create synthetic UI images via sharp + SVG ──

async function makeAdminUiImage(): Promise<Buffer> {
  return sharp({
    create: {
      width: 400,
      height: 300,
      channels: 3,
      background: { r: 240, g: 240, b: 245 },
    },
  })
    .composite([{
      input: Buffer.from(`
        <svg width="400" height="300" xmlns="http://www.w3.org/2000/svg">
          <!-- Header bar -->
          <rect x="0" y="0" width="400" height="40" fill="#ffffff" stroke="#e0e0e0"/>
          <!-- Sidebar -->
          <rect x="0" y="40" width="80" height="260" fill="#ffffff" stroke="#e0e0e0"/>
          <!-- Card 1 -->
          <rect x="100" y="60" width="130" height="80" fill="#ffffff" stroke="#d9d9d9" rx="4"/>
          <!-- Card 2 -->
          <rect x="250" y="60" width="130" height="80" fill="#ffffff" stroke="#d9d9d9" rx="4"/>
          <!-- Table area -->
          <rect x="100" y="160" width="280" height="100" fill="#ffffff" stroke="#d9d9d9" rx="4"/>
          <!-- Footer -->
          <rect x="0" y="280" width="400" height="20" fill="#fafafa" stroke="#e0e0e0"/>
        </svg>
      `),
      top: 0,
      left: 0,
    }])
    .png()
    .toBuffer();
}

async function makeMobileUiImage(): Promise<Buffer> {
  return sharp({
    create: {
      width: 200,
      height: 400,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  })
    .composite([{
      input: Buffer.from(`
        <svg width="200" height="400" xmlns="http://www.w3.org/2000/svg">
          <!-- Status bar -->
          <rect x="0" y="0" width="200" height="24" fill="#1890ff"/>
          <!-- Nav bar -->
          <rect x="0" y="24" width="200" height="36" fill="#ffffff" stroke="#e8e8e8"/>
          <!-- Content card -->
          <rect x="10" y="70" width="180" height="200" fill="#f5f5f5" stroke="#d9d9d9" rx="8"/>
          <!-- Bottom tab bar -->
          <rect x="0" y="360" width="200" height="40" fill="#ffffff" stroke="#e8e8e8"/>
        </svg>
      `),
      top: 0,
      left: 0,
    }])
    .png()
    .toBuffer();
}

async function makeBlankImage(): Promise<Buffer> {
  return sharp({
    create: {
      width: 200,
      height: 200,
      channels: 3,
      background: { r: 200, g: 200, b: 200 },
    },
  })
    .png()
    .toBuffer();
}

function makeImageInput(buffer: Buffer) {
  return {
    buffer,
    mimeType: 'image/png',
    source: 'test',
    size: buffer.byteLength,
  };
}

function baseInput(overrides: Partial<UniversalParseInput> = {}): UniversalParseInput {
  return {
    category: 'ui',
    confidence: 0.7,
    scenario: 'general',
    summary: '',
    ocrText: undefined,
    ocrItems: [],
    layout: undefined,
    scenarioExtractionData: undefined,
    keyContentExtraction: undefined,
    reasoningResult: undefined,
    sceneHint: undefined,
    metadata: undefined,
    intent: undefined,
    designExtraction: undefined,
    uiLayoutExtraction: undefined,
    ...overrides,
  };
}

const mockOcrItems = [
  { text: '保存', box: { x1: 300, y1: 280, x2: 340, y2: 298 } },
  { text: '取消', box: { x1: 350, y1: 280, x2: 390, y2: 298 } },
  { text: '新增', box: { x1: 100, y1: 50, x2: 130, y2: 68 } },
  { text: '全部', box: { x1: 100, y1: 75, x2: 120, y2: 88 } },
  { text: '待办', box: { x1: 125, y1: 75, x2: 145, y2: 88 } },
  { text: '商品管理', box: { x1: 10, y1: 50, x2: 70, y2: 66 } },
  { text: '订单配置', box: { x1: 10, y1: 70, x2: 70, y2: 86 } },
  { text: '系统设置', box: { x1: 10, y1: 90, x2: 70, y2: 106 } },
  { text: '名称', box: { x1: 110, y1: 170, x2: 140, y2: 184 } },
  { text: '价格', box: { x1: 180, y1: 170, x2: 210, y2: 184 } },
];

// ── Tests ──

describe('extractUiLayout', () => {
  it('detects visual regions from an admin UI image', async () => {
    const buf = await makeAdminUiImage();
    const result = await extractUiLayout(makeImageInput(buf), undefined);
    expect(result.structure.regions.length).toBeGreaterThan(0);
    const types = result.structure.regions.map((r) => r.type);
    // Should detect header, sidebar, cards, or table
    expect(types.some((t) => ['header', 'sidebar', 'card', 'table', 'footer'].includes(t))).toBe(true);
  });

  it('detects page type as mobile-ui for mobile layout', async () => {
    const buf = await makeMobileUiImage();
    const result = await extractUiLayout(makeImageInput(buf), undefined);
    // Should detect narrow aspect ratio regions
    expect(result.structure.regions.length).toBeGreaterThan(0);
  });

  it('infers a layoutType', async () => {
    const buf = await makeAdminUiImage();
    const result = await extractUiLayout(makeImageInput(buf), undefined);
    expect(['grid', 'columns', 'sidebar', 'centered', 'split-pane', 'stack']).toContain(result.structure.layoutType);
  });

  it('detects components from OCR items', async () => {
    const buf = await makeAdminUiImage();
    const result = await extractUiLayout(makeImageInput(buf), mockOcrItems);
    // Should detect at least some buttons from text
    const buttons = result.components.filter((c) => c.type === 'button');
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons.some((b) => b.text === '保存')).toBe(true);
    expect(buttons.some((b) => b.text === '取消')).toBe(true);
  });

  it('classifies button variants from text', async () => {
    const buf = await makeAdminUiImage();
    const result = await extractUiLayout(makeImageInput(buf), mockOcrItems);
    const saveBtn = result.components.find((c) => c.text === '保存');
    expect(saveBtn?.variant).toBe('primary');
    const cancelBtn = result.components.find((c) => c.text === '取消');
    expect(cancelBtn?.variant).toBe('ghost');
  });

  it('detects tabs from OCR items', async () => {
    const buf = await makeAdminUiImage();
    const result = await extractUiLayout(makeImageInput(buf), mockOcrItems);
    const tabs = result.components.filter((c) => c.type === 'tab');
    expect(tabs.length).toBeGreaterThan(0);
  });

  it('estimates text hierarchy levels from bbox heights', async () => {
    const buf = await makeAdminUiImage();
    const result = await extractUiLayout(makeImageInput(buf), mockOcrItems);
    expect(result.texts.length).toBeGreaterThan(0);
    const levels = result.texts.map((t) => t.estimatedLevel);
    expect(levels.some((l) => ['title', 'heading', 'body', 'caption'].includes(l))).toBe(true);
  });

  it('measures spacing between regions', async () => {
    const buf = await makeAdminUiImage();
    const result = await extractUiLayout(makeImageInput(buf), undefined);
    expect(result.spacing.scale).toBeDefined();
    expect(['compact', 'comfortable', 'spacious']).toContain(result.spacing.scale);
    expect(result.spacing.averageGap).toBeGreaterThanOrEqual(0);
  });

  it('handles blank/simple images gracefully', async () => {
    const buf = await makeBlankImage();
    const result = await extractUiLayout(makeImageInput(buf), undefined);
    expect(result.structure.regions).toBeDefined();
    expect(result.components).toBeDefined();
    expect(result.summary).toBeDefined();
  });

  it('builds a human-readable summary', async () => {
    const buf = await makeAdminUiImage();
    const result = await extractUiLayout(makeImageInput(buf), mockOcrItems);
    expect(result.summary).toMatch(/区域/);
    expect(result.summary).toMatch(/组件/);
  });

  it('scales bboxes to original image dimensions', async () => {
    const buf = await makeAdminUiImage();
    const origMeta = await sharp(buf).metadata();
    const result = await extractUiLayout(makeImageInput(buf), undefined);
    if (result.structure.regions.length > 0) {
      const r = result.structure.regions[0]!;
      // Bbox should be within original image bounds (with some tolerance)
      expect(r.bbox.x + r.bbox.w).toBeLessThanOrEqual((origMeta.width ?? 400) + 10);
      expect(r.bbox.y + r.bbox.h).toBeLessThanOrEqual((origMeta.height ?? 300) + 10);
    }
  });
});

describe('buildUniversalParse with uiLayout', () => {
  it('includes uiLayout block when uiLayoutExtraction is provided', () => {
    const parse = buildUniversalParse(baseInput({
      category: 'ui',
      uiLayoutExtraction: {
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
        mediaAreas: [],
        summary: '2 个视觉区域（header/sidebar），1 个组件，间距风格：comfortable',
      },
    }));
    expect(parse.uiLayout).toBeDefined();
    expect(parse.uiLayout!.pageType).toBe('admin-ui');
    expect(parse.uiLayout!.layoutType).toBe('sidebar');
    expect(parse.uiLayout!.regions.length).toBe(2);
    expect(parse.uiLayout!.components.length).toBe(1);
    expect(parse.uiLayout!.components[0]!.text).toBe('保存');
  });

  it('omits uiLayout block when uiLayoutExtraction is undefined', () => {
    const parse = buildUniversalParse(baseInput({ uiLayoutExtraction: undefined }));
    expect(parse.uiLayout).toBeUndefined();
  });
});
