import { describe, it, expect } from 'vitest';
import { layerizeBanner } from '../../src/ui-analysis/composition/banner-layerizer.js';
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

describe('Banner layerizer', () => {
  it('detects solid background as separable (hybrid)', () => {
    // 200x100 solid blue bg with some text pixels
    const img = makeImage(200, 100, (x, y) => {
      if (y >= 40 && y < 50 && x >= 20 && x < 180) return [255, 255, 255]; // text
      return [22, 119, 255]; // solid blue bg
    });
    const result = layerizeBanner(img, { x: 0, y: 0, w: 200, h: 100 });
    expect(result.backgroundType).toBe('solid');
    expect(result.separable).toBe(true);
    expect(result.renderMode).toBe('hybrid');
  });

  it('detects gradient background as separable (hybrid)', () => {
    const img = makeImage(200, 100, (x, y) => {
      const t = y / 99;
      return [Math.round(22 + 103 * t), Math.round(119 - 56 * t), Math.round(255 - 45 * t)];
    });
    const result = layerizeBanner(img, { x: 0, y: 0, w: 200, h: 100 });
    expect(result.backgroundType).toBe('gradient');
    expect(result.separable).toBe(true);
    expect(result.renderMode).toBe('hybrid');
  });

  it('detects complex image background as non-separable (asset)', () => {
    // Noisy/random pixels = complex image
    const img = makeImage(200, 100, (x, y) => {
      const r = (x * 7 + y * 13) % 256;
      const g = (x * 3 + y * 17 + 50) % 256;
      const b = (x * 11 + y * 5 + 100) % 256;
      return [r, g, b];
    });
    const result = layerizeBanner(img, { x: 0, y: 0, w: 200, h: 100 });
    expect(result.backgroundType).toBe('image');
    expect(result.separable).toBe(false);
    expect(result.renderMode).toBe('asset');
  });

  it('returns unknown for very small regions', () => {
    const img = makeImage(200, 100, () => [255, 255, 255]);
    const result = layerizeBanner(img, { x: 0, y: 0, w: 5, h: 5 });
    expect(result.backgroundType).toBe('unknown');
    expect(result.renderMode).toBe('asset');
  });
});
