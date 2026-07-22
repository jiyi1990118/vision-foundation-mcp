import { describe, it, expect } from 'vitest';
import { analyzeControlAppearance } from '../../src/ui-analysis/control/index.js';
import type { DecodedImage } from '../../src/ui-analysis/ir/types.js';

function makeImage(width: number, height: number, fillFn: (x: number, y: number) => [number, number, number]): DecodedImage {
  const stride = 4;
  const data = Buffer.alloc(width * height * stride);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = fillFn(x, y);
      const idx = (y * width + x) * stride;
      data[idx] = r;
      data[idx + 1] = g;
      data[idx + 2] = b;
      data[idx + 3] = 255;
    }
  }
  return { data, width, height, stride };
}

describe('ControlAppearanceAnalyzer', () => {
  it('detects a checked checkbox (square with checkmark fill)', () => {
    // 24x24 white square with blue fill in center (checked)
    const img = makeImage(24, 24, (x, y) => {
      // border
      if (x < 2 || x >= 22 || y < 2 || y >= 22) return [200, 200, 200];
      // center fill (blue = checked)
      if (x >= 6 && x < 18 && y >= 6 && y < 18) return [22, 119, 255];
      return [255, 255, 255];
    });
    const result = analyzeControlAppearance(img, { x: 0, y: 0, w: 24, h: 24 });
    expect(result).not.toBeNull();
    expect(result!.family).toBe('checkbox');
    expect(result!.shape).toBe('square');
    expect(result!.state).toBe('checked');
  });

  it('detects an unchecked checkbox (empty square)', () => {
    // 24x24 white square, no fill
    const img = makeImage(24, 24, (x, y) => {
      if (x < 2 || x >= 22 || y < 2 || y >= 22) return [200, 200, 200];
      return [255, 255, 255];
    });
    const result = analyzeControlAppearance(img, { x: 0, y: 0, w: 24, h: 24 });
    expect(result).not.toBeNull();
    expect(result!.family).toBe('checkbox');
    expect(result!.state).toBe('unchecked');
  });

  it('detects a checked radio (circle with dot)', () => {
    // 24x24: ring border + center dot
    const cx = 12, cy = 12;
    const img = makeImage(24, 24, (x, y) => {
      const dx = x - cx, dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist >= 10 && dist <= 11) return [22, 119, 255]; // ring
      if (dist <= 5) return [22, 119, 255]; // dot
      return [255, 255, 255];
    });
    const result = analyzeControlAppearance(img, { x: 0, y: 0, w: 24, h: 24 });
    expect(result).not.toBeNull();
    expect(result!.family).toBe('radio');
    expect(result!.shape).toBe('circle');
    expect(result!.state).toBe('checked');
  });

  it('detects an unchecked radio (empty circle)', () => {
    const cx = 12, cy = 12;
    const img = makeImage(24, 24, (x, y) => {
      const dx = x - cx, dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist >= 10 && dist <= 11) return [200, 200, 200]; // ring
      return [255, 255, 255];
    });
    const result = analyzeControlAppearance(img, { x: 0, y: 0, w: 24, h: 24 });
    expect(result).not.toBeNull();
    expect(result!.family).toBe('radio');
    expect(result!.state).toBe('unchecked');
  });

  it('detects a switch in on state (pill with knob right)', () => {
    // 40x20 pill: green bg, white knob on right
    const img = makeImage(40, 20, (x, y) => {
      // pill shape: rounded ends
      const dx = Math.min(x, 39 - x);
      const dy = Math.min(y, 19 - y);
      if (dx < 0 || dy < 0) return [0, 0, 0];
      // green background
      let bg: [number, number, number] = [52, 199, 89];
      // white knob on right side
      const knobCx = 28, knobCy = 10;
      const kdx = x - knobCx, kdy = y - knobCy;
      if (Math.sqrt(kdx * kdx + kdy * kdy) <= 7) bg = [255, 255, 255];
      return bg;
    });
    const result = analyzeControlAppearance(img, { x: 0, y: 0, w: 40, h: 20 });
    expect(result).not.toBeNull();
    expect(result!.family).toBe('switch');
    expect(result!.shape).toBe('pill');
    expect(result!.state).toBe('checked');
  });

  it('detects a disabled control (grayscale, low saturation)', () => {
    const img = makeImage(24, 24, (x, y) => {
      if (x < 2 || x >= 22 || y < 2 || y >= 22) return [180, 180, 180];
      if (x >= 6 && x < 18 && y >= 6 && y < 18) return [180, 180, 180];
      return [240, 240, 240];
    });
    const result = analyzeControlAppearance(img, { x: 0, y: 0, w: 24, h: 24 });
    expect(result).not.toBeNull();
    expect(result!.state).toBe('disabled');
  });

  it('returns null for non-control region (large text area)', () => {
    // 100x30 white area - too wide for a control
    const img = makeImage(100, 30, () => [255, 255, 255]);
    const result = analyzeControlAppearance(img, { x: 0, y: 0, w: 100, h: 30 });
    expect(result).toBeNull();
  });
});
