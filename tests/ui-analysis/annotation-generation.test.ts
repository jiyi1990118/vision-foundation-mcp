import { describe, expect, it } from 'vitest';
import {
  createPipelineBaseline,
  ocrItemsFromInferenceResponse,
  shouldCopySourceImage,
} from '../../src/ui-analysis/annotation-workbench/generation.js';

describe('ocrItemsFromInferenceResponse', () => {
  it('parses positioned OCR text from a provider response for annotation generation', () => {
    const items = ocrItemsFromInferenceResponse({
      text: JSON.stringify({
        texts: [{ text: '保存', position: '900,700,950,732', confidence: 0.89 }],
        language: 'zh',
      }),
      duration: 12,
    });

    expect(items).toEqual([{
      text: '保存',
      box: { x1: 900, y1: 700, x2: 950, y2: 732 },
      confidence: 0.89,
      source: 'full',
    }]);
  });

  it('creates independent draft and prediction snapshots before human review', () => {
    const annotation = {
      image: 'screen.png',
      imageSize: { width: 100, height: 200 },
      platform: 'app' as const,
      theme: 'light' as const,
      language: 'zh' as const,
      dpi: 'standard' as const,
      elements: [{ id: 'text-1', type: 'text', bbox: { x: 1, y: 2, w: 30, h: 12 }, render: 'native', text: '保存' }],
      relations: [],
      zOrder: [],
      warnings: ['pipeline-generated draft annotation - not human verified'],
    };

    const { draft, prediction, review } = createPipelineBaseline(annotation);
    draft.elements[0]!.text = '已保存';

    expect(prediction.elements[0]!.text).toBe('保存');
    expect(review.differences).toEqual([]);
  });

  it('does not copy an image onto itself when regenerating an in-place dataset', () => {
    expect(shouldCopySourceImage('/tmp/dataset/screen.png', '/tmp/dataset/screen.png')).toBe(false);
    expect(shouldCopySourceImage('/tmp/source/screen.png', '/tmp/dataset/screen.png')).toBe(true);
  });
});
