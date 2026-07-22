import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { extractUiLayout } from '../../src/core/extractors/ui-layout-extractor.js';
import { extractUiLayoutForAnalysis } from '../../src/ui-analysis/adapters/index.js';
import type { OcrItem } from '../../src/core/key-content-extractor.js';
import type { ImageInput } from '../../src/types/domain.js';

async function makeImage(): Promise<ImageInput> {
  const svg = `<svg width="800" height="600" xmlns="http://www.w3.org/2000/svg">
    <rect width="800" height="600" fill="#ffffff"/>
    <rect x="50" y="50" width="200" height="100" fill="#eeeeee" stroke="#111111"/>
    <rect x="50" y="170" width="200" height="100" fill="#eeeeee" stroke="#111111"/>
  </svg>`;
  const buffer = await sharp(Buffer.from(svg)).png().toBuffer();
  return { buffer, mimeType: 'image/png', source: 'adapter-test', size: buffer.length };
}

async function makeThresholdImage(): Promise<ImageInput> {
  const svg = `<svg width="2000" height="600" xmlns="http://www.w3.org/2000/svg">
    <rect width="2000" height="600" fill="#ffffff"/>
    <rect x="60" y="60" width="300" height="120" fill="#eeeeee" stroke="#111111" stroke-width="6"/>
    <rect x="60" y="240" width="300" height="120" fill="#eeeeee" stroke="#111111" stroke-width="6"/>
  </svg>`;
  const buffer = await sharp(Buffer.from(svg)).png().toBuffer();
  return { buffer, mimeType: 'image/png', source: 'adapter-threshold-test', size: buffer.length };
}

describe('extractUiLayoutForAnalysis', () => {
  it('keeps OCR-derived components and texts in original-image coordinates', async () => {
    const image = await makeImage();
    const ocr: OcrItem[] = [{
      text: '保存',
      box: { x1: 600, y1: 500, x2: 700, y2: 540 },
      confidence: 0.9,
    }];

    const result = await extractUiLayoutForAnalysis(image, ocr);
    expect(result.components).toHaveLength(1);
    expect(result.components[0]!.bbox).toEqual({ x: 600, y: 500, w: 100, h: 40 });
    expect(result.texts[0]!.bbox).toEqual({ x: 600, y: 500, w: 100, h: 40 });
    expect(result.components[0]!.bbox.x + result.components[0]!.bbox.w).toBeLessThanOrEqual(800);
    expect(result.components[0]!.bbox.y + result.components[0]!.bbox.h).toBeLessThanOrEqual(600);
  });

  it('restores thumbnail spacing to original-image units', async () => {
    const image = await makeImage();
    const raw = await extractUiLayout(image, undefined);
    const restored = await extractUiLayoutForAnalysis(image, undefined);

    expect(raw.spacing.verticalGaps.length).toBeGreaterThan(0);
    expect(restored.spacing.verticalGaps).toEqual(raw.spacing.verticalGaps.map((gap) => gap * 2));
    expect(restored.spacing.horizontalGaps).toEqual(raw.spacing.horizontalGaps.map((gap) => gap * 2));
    const gaps = [...restored.spacing.verticalGaps, ...restored.spacing.horizontalGaps];
    expect(restored.spacing.averageGap).toBe(gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length);
    expect(restored.spacing.scale).toBe(
      restored.spacing.averageGap < 5
        ? 'compact'
        : restored.spacing.averageGap < 15 ? 'comfortable' : 'spacious',
    );
  });

  it('reclassifies spacing after restored gaps cross a scale threshold', async () => {
    const image = await makeThresholdImage();
    const raw = await extractUiLayout(image, undefined);
    const restored = await extractUiLayoutForAnalysis(image, undefined);

    expect(raw.spacing.averageGap).toBeGreaterThan(0);
    expect(raw.spacing.scale).toBe('comfortable');
    expect(restored.spacing.averageGap).toBeGreaterThanOrEqual(15);
    expect(restored.spacing.scale).toBe('spacious');
  });
});
