import type { BBox } from '../ir/types.js';

export interface GroundTruthItem {
  id: string;
  type: string;
  bbox: BBox;
}

export interface PredictedItem {
  id: string;
  type: string;
  bbox: BBox;
}

export interface MatchResult {
  gtId: string;
  predId: string;
  iou: number;
}

export interface PerTypeMetrics {
  recall: number;
  precision: number;
  f1: number;
  gtCount: number;
  predCount: number;
  matched: number;
}

export interface MetricsReport {
  recall: number;
  precision: number;
  f1: number;
  coverage: number;
  gtCount: number;
  predCount: number;
  matchedCount: number;
  perType: Record<string, PerTypeMetrics>;
}

export interface MetricsOptions {
  iouThreshold: number;
  imageWidth: number;
  imageHeight: number;
}

export function bboxIoU(a: BBox, b: BBox): number {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  const interW = Math.max(0, x1 - x0);
  const interH = Math.max(0, y1 - y0);
  const intersection = interW * interH;
  const union = a.w * a.h + b.w * b.h - intersection;
  return union > 0 ? intersection / union : 0;
}

export function matchDetections(
  gt: GroundTruthItem[],
  pred: PredictedItem[],
  options: { iouThreshold: number },
): MatchResult[] {
  const matches: MatchResult[] = [];
  const usedPred = new Set<string>();

  for (const g of gt) {
    let bestIoU = 0;
    let bestPred: PredictedItem | null = null;
    for (const p of pred) {
      if (usedPred.has(p.id)) continue;
      if (p.type !== g.type) continue;
      const iou = bboxIoU(g.bbox, p.bbox);
      if (iou >= options.iouThreshold && iou > bestIoU) {
        bestIoU = iou;
        bestPred = p;
      }
    }
    if (bestPred !== null) {
      usedPred.add(bestPred.id);
      matches.push({ gtId: g.id, predId: bestPred.id, iou: bestIoU });
    }
  }
  return matches;
}

export function computeRecall(matches: MatchResult[], gtCount: number): number {
  if (gtCount === 0) return 0;
  return matches.length / gtCount;
}

export function computePrecision(matches: MatchResult[], predCount: number): number {
  if (predCount === 0) return 0;
  return matches.length / predCount;
}

export function computeF1(recall: number, precision: number): number {
  if (recall + precision === 0) return 0;
  return (2 * recall * precision) / (recall + precision);
}

export function computeCoverage(preds: BBox[], imageWidth: number, imageHeight: number): number {
  const totalArea = imageWidth * imageHeight;
  if (totalArea === 0) return 0;
  let coveredArea = 0;
  for (const bbox of preds) {
    coveredArea += Math.max(0, bbox.w) * Math.max(0, bbox.h);
  }
  return Math.min(1, coveredArea / totalArea);
}

export function computeMetrics(
  gt: GroundTruthItem[],
  pred: PredictedItem[],
  options: MetricsOptions,
): MetricsReport {
  const matches = matchDetections(gt, pred, { iouThreshold: options.iouThreshold });
  const recall = computeRecall(matches, gt.length);
  const precision = computePrecision(matches, pred.length);
  const f1 = computeF1(recall, precision);
  const coverage = computeCoverage(
    pred.map((p) => p.bbox),
    options.imageWidth,
    options.imageHeight,
  );

  const allTypes = new Set<string>([...gt.map((g) => g.type), ...pred.map((p) => p.type)]);
  const perType: Record<string, PerTypeMetrics> = {};
  for (const type of allTypes) {
    const typeGt = gt.filter((g) => g.type === type);
    const typePred = pred.filter((p) => p.type === type);
    const typeMatches = matches.filter((m) => {
      const g = gt.find((item) => item.id === m.gtId);
      return g !== undefined && g.type === type;
    });
    const tr = computeRecall(typeMatches, typeGt.length);
    const tp = computePrecision(typeMatches, typePred.length);
    perType[type] = {
      recall: tr,
      precision: tp,
      f1: computeF1(tr, tp),
      gtCount: typeGt.length,
      predCount: typePred.length,
      matched: typeMatches.length,
    };
  }

  return {
    recall,
    precision,
    f1,
    coverage,
    gtCount: gt.length,
    predCount: pred.length,
    matchedCount: matches.length,
    perType,
  };
}
