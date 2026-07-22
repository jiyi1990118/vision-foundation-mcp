import { describe, it, expect } from 'vitest';
import { estimateBorderWidth, estimatePadding } from '../../src/ui-analysis/style/style-extractor.js';
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

describe('Border width estimation', () => {
  it('detects a 3px border', () => {
    // 50x50: 3px gray border, white interior
    const img = makeImage(50, 50, (x, y) => {
      if (x < 3 || x >= 47 || y < 3 || y >= 47) return [200, 200, 200];
      return [255, 255, 255];
    });
    const bw = estimateBorderWidth(img, { x: 0, y: 0, w: 50, h: 50 });
    expect(bw).toBeGreaterThanOrEqual(2);
    expect(bw).toBeLessThanOrEqual(4);
  });

  it('returns 0 for no border', () => {
    const img = makeImage(50, 50, () => [255, 255, 255]);
    const bw = estimateBorderWidth(img, { x: 0, y: 0, w: 50, h: 50 });
    expect(bw).toBe(0);
  });
});

describe('Padding estimation', () => {
  it('detects padding around content', () => {
    // 60x60: white bg, content (dark) in center 40x40 starting at (10,10)
    const img = makeImage(60, 60, (x, y) => {
      if (x >= 10 && x < 50 && y >= 10 && y < 50) return [100, 100, 100];
      return [255, 255, 255];
    });
    const padding = estimatePadding(img, { x: 0, y: 0, w: 60, h: 60 });
    expect(padding).not.toBeNull();
    expect(padding!.top).toBeGreaterThanOrEqual(8);
    expect(padding!.left).toBeGreaterThanOrEqual(8);
  });

  it('returns null for uniform color (no content boundary)', () => {
    const img = makeImage(60, 60, () => [255, 255, 255]);
    const padding = estimatePadding(img, { x: 0, y: 0, w: 60, h: 60 });
    expect(padding).toBeNull();
  });
});
