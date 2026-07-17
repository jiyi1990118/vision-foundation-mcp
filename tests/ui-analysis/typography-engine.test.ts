import { describe, expect, it } from 'vitest';
import { inferTypography } from '../../src/ui-analysis/typography/typography-engine.js';
import type { VisionOcrItem } from '../../src/ui-analysis/ir/types.js';

function ocrWithHeights(heights: number[]): VisionOcrItem[] {
  return heights.map((h, i) => ({
    text: `t${i}`,
    bbox: { x: 0, y: i * 100, w: 50, h },
    confidence: 1,
  }));
}

describe('typography-engine', () => {
  it('returns an empty scale and no weights for empty OCR input', () => {
    expect(inferTypography([])).toEqual({ scale: [], weights: [] });
  });

  it('infers title / body / caption levels from bbox heights', () => {
    const r = inferTypography(ocrWithHeights([40, 24, 12]));

    expect(r.weights).toEqual(['regular']);
    expect(r.scale).toHaveLength(3);
    expect(r.scale[0]).toEqual({ level: 'title', sizePx: 40, count: 1 });
    expect(r.scale[1]).toEqual({ level: 'body', sizePx: 24, count: 1 });
    expect(r.scale[2]).toEqual({ level: 'caption', sizePx: 12, count: 1 });
  });
});
