import { describe, it, expect } from 'vitest';
import { detectGradient } from '../../src/ui-analysis/style/style-extractor.js';
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

describe('Gradient detection', () => {
  it('detects a vertical linear gradient', () => {
    const img = makeImage(100, 100, (x, y) => {
      const t = y / 99;
      const r = Math.round(22 + (125 - 22) * t);
      const g = Math.round(119 + (63 - 119) * t);
      const b = Math.round(255 + (210 - 255) * t);
      return [r, g, b];
    });
    const gradient = detectGradient(img, { x: 0, y: 0, w: 100, h: 100 });
    expect(gradient).not.toBeNull();
    expect(gradient!.type).toBe('linear');
    expect(gradient!.stops.length).toBeGreaterThanOrEqual(2);
  });

  it('returns null for solid color (no gradient)', () => {
    const img = makeImage(100, 100, () => [255, 255, 255]);
    const gradient = detectGradient(img, { x: 0, y: 0, w: 100, h: 100 });
    expect(gradient).toBeNull();
  });

  it('returns null for very small regions', () => {
    const img = makeImage(100, 100, (x, y) => {
      const t = y / 99;
      return [Math.round(22 + 100 * t), 119, 255];
    });
    const gradient = detectGradient(img, { x: 0, y: 0, w: 5, h: 5 });
    expect(gradient).toBeNull();
  });
});
