import { describe, expect, it } from 'vitest';
import { buildReviewReport } from '../../src/ui-analysis/annotation-workbench/diff.js';
import type { AnnotationFile } from '../../src/ui-analysis/benchmark/annotation-loader.js';

function annotation(elements: AnnotationFile['elements']): AnnotationFile {
  return {
    image: 'screen.png',
    imageSize: { width: 100, height: 200 },
    platform: 'app', theme: 'light', language: 'en', dpi: 'standard',
    elements, relations: [], zOrder: [], warnings: [],
  };
}

function element(id: string, type: string, x: number, y: number, w: number, h: number, text?: string) {
  return { id, type, bbox: { x, y, w, h }, render: 'native', ...(text ? { text } : {}) };
}

describe('buildReviewReport', () => {
  it('pairs by IoU before type and classifies a type correction', () => {
    const report = buildReviewReport(
      annotation([element('pred-1', 'icon', 10, 10, 20, 20)]),
      annotation([element('human-1', 'text', 10, 10, 20, 20)]),
    );

    expect(report.differences).toEqual([expect.objectContaining({
      category: 'wrong_type', predictionId: 'pred-1', annotationId: 'human-1', severity: 'high', iou: 1,
    })]);
  });

  it('reports unmatched human and prediction elements as missed and false positives', () => {
    const report = buildReviewReport(
      annotation([element('pred-only', 'button', 0, 0, 10, 10)]),
      annotation([element('human-only', 'input', 50, 50, 10, 10)]),
    );

    expect(report.differences).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'false_positive', predictionId: 'pred-only', severity: 'high' }),
      expect.objectContaining({ category: 'missed', annotationId: 'human-only', severity: 'high' }),
    ]));
  });

  it('classifies a geometry-only correction below the bbox tolerance', () => {
    const report = buildReviewReport(
      annotation([element('pred-1', 'card', 0, 0, 100, 100)]),
      annotation([element('human-1', 'card', 10, 0, 100, 100)]),
    );

    expect(report.differences).toEqual([expect.objectContaining({
      category: 'wrong_bbox', severity: 'low', iou: expect.closeTo(0.818, 2),
    })]);
  });
});
