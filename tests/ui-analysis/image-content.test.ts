import { describe, expect, it } from 'vitest';
import { extractImageContents } from '../../src/ui-analysis/image-content/index.js';
import type { MediaArea } from '../../src/core/extractors/ui-layout-extractor.js';

function media(
  type: MediaArea['type'],
  bbox: { x: number; y: number; w: number; h: number },
  nearbyText?: string,
): MediaArea {
  return { type, bbox, nearbyText };
}

describe('image-content-extractor', () => {
  it('uses nearbyText as altText and crops to bbox for an icon', () => {
    const bbox = { x: 120, y: 80, w: 24, h: 24 };
    const r = extractImageContents([media('icon', bbox, '搜索')]);

    expect(r).toHaveLength(1);
    expect(r[0]!.index).toBe(0);
    expect(r[0]!.type).toBe('icon');
    expect(r[0]!.altText).toBe('搜索');
    expect(r[0]!.crop).toEqual({ x: 120, y: 80, w: 24, h: 24 });
    expect(r[0]!.nearbyText).toBe('搜索');
  });

  it('falls back to default alt text when nearbyText is missing for an image', () => {
    const r = extractImageContents([media('image', { x: 10, y: 10, w: 200, h: 150 })]);

    expect(r).toHaveLength(1);
    expect(r[0]!.type).toBe('image');
    expect(r[0]!.altText).toBe('图片');
    expect(r[0]!.nearbyText).toBeUndefined();
  });

  it('skips tiny noise bboxes and clamps negative coordinates', () => {
    const r = extractImageContents([
      media('icon', { x: 0, y: 0, w: 2, h: 2 }, 'tiny'),
      media('logo', { x: -5, y: -3, w: 40, h: 40 }, '  '),
    ]);

    expect(r).toHaveLength(1);
    expect(r[0]!.type).toBe('logo');
    expect(r[0]!.altText).toBe('Logo');
    expect(r[0]!.crop).toEqual({ x: 0, y: 0, w: 35, h: 37 });
    expect(r[0]!.nearbyText).toBeUndefined();
  });
});
