import { describe, expect, it } from 'vitest';
import { ocrItemsToVisionOcr } from '../../src/ui-analysis/ir/ocr-adapter.js';
import type { OcrItem } from '../../src/core/key-content-extractor.js';

describe('ocrItemsToVisionOcr (S30 G-D2)', () => {
  it('converts box + confidence and maps {x1,y1,x2,y2} -> {x,y,w,h}', () => {
    const items: OcrItem[] = [
      { text: '保存', box: { x1: 10, y1: 20, x2: 70, y2: 40 }, confidence: 0.85, source: 'full' },
    ];

    const out = ocrItemsToVisionOcr(items);

    expect(out).toHaveLength(1);
    expect(out[0]!.text).toBe('保存');
    expect(out[0]!.bbox).toEqual({ x: 10, y: 20, w: 60, h: 20 });
    expect(out[0]!.confidence).toBe(0.85);
  });

  it('skips items without a box', () => {
    const items: OcrItem[] = [
      { text: 'no-box', confidence: 0.9 },
      { text: 'has-box', box: { x1: 0, y1: 0, x2: 5, y2: 5 }, confidence: 0.5 },
    ];

    const out = ocrItemsToVisionOcr(items);

    expect(out).toHaveLength(1);
    expect(out[0]!.text).toBe('has-box');
  });

  it('defaults confidence to 1 when missing', () => {
    const items: OcrItem[] = [{ text: 'no-conf', box: { x1: 0, y1: 0, x2: 10, y2: 10 } }];

    const out = ocrItemsToVisionOcr(items);

    expect(out[0]!.confidence).toBe(1);
  });

  it('skips degenerate (zero/negative) boxes', () => {
    const items: OcrItem[] = [
      { text: 'zero-w', box: { x1: 5, y1: 5, x2: 5, y2: 10 }, confidence: 0.9 },
      { text: 'neg-h', box: { x1: 0, y1: 10, x2: 10, y2: 5 }, confidence: 0.9 },
      { text: 'ok', box: { x1: 0, y1: 0, x2: 10, y2: 10 }, confidence: 0.9 },
    ];

    const out = ocrItemsToVisionOcr(items);

    expect(out).toHaveLength(1);
    expect(out[0]!.text).toBe('ok');
  });

  it('returns empty for empty input', () => {
    expect(ocrItemsToVisionOcr([])).toEqual([]);
  });

  it('skips non-finite coordinates and confidence values outside 0..1', () => {
    const items: OcrItem[] = [
      { text: 'infinite', box: { x1: 0, y1: 0, x2: Infinity, y2: 10 }, confidence: 0.9 },
      { text: 'high', box: { x1: 0, y1: 0, x2: 10, y2: 10 }, confidence: 2 },
      { text: 'low', box: { x1: 0, y1: 0, x2: 10, y2: 10 }, confidence: -1 },
      { text: 'ok', box: { x1: 0, y1: 0, x2: 10, y2: 10 }, confidence: 0.5 },
    ];
    expect(ocrItemsToVisionOcr(items)).toEqual([
      { text: 'ok', bbox: { x: 0, y: 0, w: 10, h: 10 }, confidence: 0.5 },
    ]);
  });
});
