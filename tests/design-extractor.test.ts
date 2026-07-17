import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
  extractDesignTokens,
  contrastRatio,
} from '../src/core/extractors/design-extractor.js';
import { buildUniversalParse } from '../src/core/universal-parser.js';
import type { UniversalParseInput } from '../src/core/universal-parser.js';

// ── Helpers: create synthetic images via sharp ──

async function makeSolidColorImage(r: number, g: number, b: number): Promise<Buffer> {
  return sharp({
    create: {
      width: 200,
      height: 200,
      channels: 3,
      background: { r, g, b },
    },
  })
    .png()
    .toBuffer();
}

async function makeDarkModeImage(): Promise<Buffer> {
  // Dark background + light text area
  return sharp({
    create: {
      width: 200,
      height: 200,
      channels: 3,
      background: { r: 24, g: 24, b: 28 },
    },
  })
    .composite([{
      input: Buffer.from(`
        <svg width="200" height="200">
          <rect x="20" y="20" width="160" height="30" fill="#e0e0e0"/>
          <rect x="20" y="70" width="80" height="20" fill="#1890ff"/>
        </svg>
      `),
      top: 0,
      left: 0,
    }])
    .png()
    .toBuffer();
}

async function makeLightModeImage(): Promise<Buffer> {
  // White background + dark text + blue accent
  return sharp({
    create: {
      width: 200,
      height: 200,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  })
    .composite([{
      input: Buffer.from(`
        <svg width="200" height="200">
          <rect x="20" y="20" width="160" height="30" fill="#333333"/>
          <rect x="20" y="70" width="80" height="20" fill="#1890ff"/>
          <rect x="20" y="110" width="160" height="2" fill="#e8e8e8"/>
        </svg>
      `),
      top: 0,
      left: 0,
    }])
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
    ...overrides,
  };
}

// ── Tests ──

describe('contrastRatio', () => {
  it('black vs white = 21', () => {
    expect(contrastRatio({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 })).toBeCloseTo(21, 0);
  });

  it('same color = 1', () => {
    expect(contrastRatio({ r: 100, g: 100, b: 100 }, { r: 100, g: 100, b: 100 })).toBeCloseTo(1, 1);
  });
});

describe('extractDesignTokens', () => {
  it('extracts a single dominant color from a solid image', async () => {
    const buf = await makeSolidColorImage(24, 144, 255);
    const result = await extractDesignTokens(makeImageInput(buf));
    expect(result.colorCount).toBeGreaterThanOrEqual(1);
    expect(result.palette.length).toBeGreaterThanOrEqual(1);
    expect(result.palette[0]!.hex).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('detects dark mode', async () => {
    const buf = await makeDarkModeImage();
    const result = await extractDesignTokens(makeImageInput(buf));
    expect(result.isDarkMode).toBe(true);
  });

  it('detects light mode', async () => {
    const buf = await makeLightModeImage();
    const result = await extractDesignTokens(makeImageInput(buf));
    expect(result.isDarkMode).toBe(false);
    expect(result.background).toMatch(/^#f{2}f{2}f{2}$/i);
  });

  it('identifies background and text roles', async () => {
    const buf = await makeLightModeImage();
    const result = await extractDesignTokens(makeImageInput(buf));
    const bg = result.palette.find((p) => p.role === 'background');
    expect(bg).toBeDefined();
    expect(bg!.frequency).toBeGreaterThan(0.5);
  });

  it('computes WCAG contrast ratio', async () => {
    const buf = await makeLightModeImage();
    const result = await extractDesignTokens(makeImageInput(buf));
    expect(result.contrastRatio).toBeGreaterThan(4.5);
  });

  it('builds a human-readable summary', async () => {
    const buf = await makeLightModeImage();
    const result = await extractDesignTokens(makeImageInput(buf));
    expect(result.summary).toContain('浅色模式');
    expect(result.summary).toMatch(/配色方案/);
  });

  it('returns palette with hex, role, and frequency', async () => {
    const buf = await makeDarkModeImage();
    const result = await extractDesignTokens(makeImageInput(buf));
    for (const token of result.palette) {
      expect(token.hex).toMatch(/^#[0-9a-f]{6}$/);
      expect(token.role).toBeTypeOf('string');
      expect(token.frequency).toBeGreaterThan(0);
      expect(token.frequency).toBeLessThanOrEqual(1);
    }
  });

  it('caps palette at 10 entries', async () => {
    const buf = await makeSolidColorImage(100, 150, 200);
    const result = await extractDesignTokens(makeImageInput(buf));
    expect(result.palette.length).toBeLessThanOrEqual(10);
  });
});

describe('buildUniversalParse with design', () => {
  it('includes design block when designExtraction is provided', () => {
    const parse = buildUniversalParse(baseInput({
      category: 'ui',
      designExtraction: {
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
        summary: '浅色模式，3 色配色方案（background/primary/text），对比度优秀（WCAG AAA）',
      },
    }));
    expect(parse.design).toBeDefined();
    expect(parse.design!.background).toBe('#ffffff');
    expect(parse.design!.primary).toBe('#1890ff');
    expect(parse.design!.isDarkMode).toBe(false);
    expect(parse.design!.palette.length).toBe(3);
  });

  it('omits design block when designExtraction is undefined', () => {
    const parse = buildUniversalParse(baseInput({ designExtraction: undefined }));
    expect(parse.design).toBeUndefined();
  });
});
