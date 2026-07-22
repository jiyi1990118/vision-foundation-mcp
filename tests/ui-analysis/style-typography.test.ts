import { describe, it, expect } from 'vitest';
import { analyzeTypography } from '../../src/ui-analysis/style/style-extractor.js';
import type { DecodedImage } from '../../src/ui-analysis/ir/types.js';

function makeImage(width: number, height: number, fillFn: (x: number, y: number) => [number, number, number]): DecodedImage {
  const stride = 4;
  const data = Buffer.alloc(width * height * stride);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = fillFn(x, y);
      const idx = (y * width + x) * stride;
      data[idx] = r; data[idx + 1] = g; data[idx + 2] = b; data[idx + 3] = 255;
    }
  }
  return { data, width, height, stride };
}

describe('Typography analysis', () => {
  it('detects center-aligned text', () => {
    // 100x30 white bg, dark text in center columns 40-60
    const img = makeImage(100, 30, (x, y) => {
      if (x >= 40 && x < 60 && y >= 10 && y < 20) return [50, 50, 50];
      return [255, 255, 255];
    });
    const ty = analyzeTypography(img, { x: 0, y: 0, w: 100, h: 30 });
    expect(ty).not.toBeNull();
    expect(ty!.textAlign).toBe('center');
  });

  it('detects left-aligned text', () => {
    // 100x30 white bg, dark text starting from left columns 5-25
    const img = makeImage(100, 30, (x, y) => {
      if (x >= 5 && x < 25 && y >= 10 && y < 20) return [50, 50, 50];
      return [255, 255, 255];
    });
    const ty = analyzeTypography(img, { x: 0, y: 0, w: 100, h: 30 });
    expect(ty).not.toBeNull();
    expect(ty!.textAlign).toBe('left');
  });

  it('detects right-aligned text', () => {
    // 100x30 white bg, dark text near right columns 75-95
    const img = makeImage(100, 30, (x, y) => {
      if (x >= 75 && x < 95 && y >= 10 && y < 20) return [50, 50, 50];
      return [255, 255, 255];
    });
    const ty = analyzeTypography(img, { x: 0, y: 0, w: 100, h: 30 });
    expect(ty).not.toBeNull();
    expect(ty!.textAlign).toBe('right');
  });

  it('detects underline text decoration', () => {
    // 100x30: text at y=10-15, underline at y=18-19
    const img = makeImage(100, 30, (x, y) => {
      if (y >= 10 && y < 15 && x >= 10 && x < 90) return [50, 50, 50]; // text
      if (y >= 18 && y < 20 && x >= 10 && x < 90) return [50, 50, 50]; // underline
      return [255, 255, 255];
    });
    const ty = analyzeTypography(img, { x: 0, y: 0, w: 100, h: 30 });
    expect(ty).not.toBeNull();
    expect(ty!.textDecoration).toBe('underline');
  });

  it('returns null for non-text (no dark pixels)', () => {
    const img = makeImage(100, 30, () => [255, 255, 255]);
    const ty = analyzeTypography(img, { x: 0, y: 0, w: 100, h: 30 });
    expect(ty).toBeNull();
  });
});
