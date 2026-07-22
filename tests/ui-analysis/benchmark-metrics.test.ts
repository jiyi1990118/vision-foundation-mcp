import { describe, it, expect } from 'vitest';
import {
  bboxIoU,
  matchDetections,
  computeRecall,
  computePrecision,
  computeF1,
  computeCoverage,
  computeMetrics,
} from '../../src/ui-analysis/benchmark/metrics.js';
import type { BBox } from '../../src/ui-analysis/ir/types.js';

const box = (x: number, y: number, w: number, h: number): BBox => ({ x, y, w, h });

describe('Benchmark metrics', () => {
  describe('bboxIoU', () => {
    it('computes IoU for overlapping boxes', () => {
      expect(bboxIoU(box(0, 0, 100, 50), box(50, 0, 100, 50))).toBeCloseTo(0.333, 1);
    });
    it('returns 0 for non-overlapping boxes', () => {
      expect(bboxIoU(box(0, 0, 50, 50), box(100, 100, 50, 50))).toBe(0);
    });
    it('returns 1 for identical boxes', () => {
      expect(bboxIoU(box(0, 0, 100, 100), box(0, 0, 100, 100))).toBe(1);
    });
  });

  describe('matchDetections', () => {
    const gt = [
      { id: 'g1', type: 'button', bbox: box(0, 0, 100, 40) },
      { id: 'g2', type: 'text', bbox: box(10, 50, 80, 20) },
    ];
    const pred = [
      { id: 'p1', type: 'button', bbox: box(2, 1, 98, 39) },
      { id: 'p2', type: 'text', bbox: box(12, 51, 78, 19) },
    ];
    const matches = matchDetections(gt, pred, { iouThreshold: 0.5 });
    it('matches both predictions to GT', () => {
      expect(matches).toHaveLength(2);
      expect(matches[0]!.gtId).toBe('g1');
      expect(matches[0]!.predId).toBe('p1');
    });
  });

  describe('computeRecall', () => {
    it('returns 1.0 when all GT matched', () => {
      const matches = [{ gtId: 'g1', predId: 'p1', iou: 0.9 }];
      expect(computeRecall(matches, 1)).toBe(1.0);
    });
    it('returns 0.5 when half GT matched', () => {
      const matches = [{ gtId: 'g1', predId: 'p1', iou: 0.9 }];
      expect(computeRecall(matches, 2)).toBe(0.5);
    });
    it('returns 0 when no GT matched', () => {
      expect(computeRecall([], 3)).toBe(0);
    });
  });

  describe('computePrecision', () => {
    it('returns 1.0 when all predictions matched', () => {
      const matches = [{ gtId: 'g1', predId: 'p1', iou: 0.9 }];
      expect(computePrecision(matches, 1)).toBe(1.0);
    });
    it('returns 0.5 when half predictions matched', () => {
      const matches = [{ gtId: 'g1', predId: 'p1', iou: 0.9 }];
      expect(computePrecision(matches, 2)).toBe(0.5);
    });
  });

  describe('computeF1', () => {
    it('computes harmonic mean', () => {
      expect(computeF1(1.0, 1.0)).toBe(1.0);
      expect(computeF1(0.5, 0.5)).toBe(0.5);
      expect(computeF1(0, 1)).toBe(0);
    });
  });

  describe('computeCoverage', () => {
    it('computes fraction of image area covered', () => {
      const preds = [box(0, 0, 100, 100)];
      expect(computeCoverage(preds, 200, 200)).toBe(0.25);
    });
    it('caps at 1.0 for overlapping predictions', () => {
      const preds = [box(0, 0, 200, 200), box(0, 0, 200, 200)];
      expect(computeCoverage(preds, 200, 200)).toBe(1.0);
    });
  });

  describe('computeMetrics', () => {
    it('produces a full metrics report', () => {
      const gt = [
        { id: 'g1', type: 'button', bbox: box(0, 0, 100, 40) },
        { id: 'g2', type: 'text', bbox: box(10, 50, 80, 20) },
      ];
      const pred = [
        { id: 'p1', type: 'button', bbox: box(2, 1, 98, 39) },
        { id: 'p2', type: 'text', bbox: box(12, 51, 78, 19) },
      ];
      const report = computeMetrics(gt, pred, { iouThreshold: 0.5, imageWidth: 200, imageHeight: 200 });
      expect(report.recall).toBe(1.0);
      expect(report.precision).toBe(1.0);
      expect(report.f1).toBe(1.0);
      expect(report.coverage).toBeGreaterThan(0);
      expect(report.perType).toBeDefined();
      expect(report.perType['button']!.recall).toBe(1.0);
      expect(report.perType['text']!.recall).toBe(1.0);
    });
  });
});
