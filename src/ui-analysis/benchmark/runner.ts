import type { BBox, ASTNode } from '../ir/types.js';
import type { GroundTruthItem, PredictedItem, MetricsReport, MetricsOptions } from './metrics.js';
import { computeMetrics } from './metrics.js';

export interface BenchmarkImageInput {
  image: string;
  imageWidth: number;
  imageHeight: number;
  annotations?: {
    elements: Array<{ id: string; type: string; bbox: BBox }>;
  };
  predictions?: PredictedItem[];
}

export interface BenchmarkImageResult {
  image: string;
  metrics?: MetricsReport;
  predictionCount: number;
  gtCount: number;
  error?: string;
}

export interface BenchmarkSummary {
  meanRecall: number;
  meanPrecision: number;
  meanF1: number;
  meanCoverage: number;
  totalImages: number;
  totalPredictions: number;
  totalGt: number;
  perTypeMacroF1: number;
}

export interface BenchmarkResult {
  mode: 'annotated' | 'no-annotation';
  images: BenchmarkImageResult[];
  summary: BenchmarkSummary;
}

export interface RunBenchmarkInput {
  images: BenchmarkImageInput[];
  mode: 'annotated' | 'no-annotation';
  imageWidth: number;
  imageHeight: number;
  iouThreshold?: number;
}

export function extractPredictionsFromAst(root: ASTNode): PredictedItem[] {
  const preds: PredictedItem[] = [];
  const walk = (node: ASTNode): void => {
    if (node.type !== 'page') {
      preds.push({ id: node.id, type: node.type, bbox: node.bbox });
    }
    for (const c of node.children) walk(c);
  };
  walk(root);
  return preds;
}

export async function runBenchmark(input: RunBenchmarkInput): Promise<BenchmarkResult> {
  const iouThreshold = input.iouThreshold ?? 0.5;
  const imageResults: BenchmarkImageResult[] = [];

  for (const img of input.images) {
    try {
      if (input.mode === 'annotated' && img.annotations !== undefined && img.predictions !== undefined) {
        const gt: GroundTruthItem[] = img.annotations.elements.map((e) => ({
          id: e.id,
          type: e.type,
          bbox: e.bbox,
        }));
        const opts: MetricsOptions = {
          iouThreshold,
          imageWidth: img.imageWidth,
          imageHeight: img.imageHeight,
        };
        const metrics = computeMetrics(gt, img.predictions, opts);
        imageResults.push({
          image: img.image,
          metrics,
          predictionCount: img.predictions.length,
          gtCount: gt.length,
        });
      } else {
        // No-annotation mode: only coverage
        const predBboxes = (img.predictions ?? []).map((p) => p.bbox);
        const totalArea = img.imageWidth * img.imageHeight;
        const coveredArea = predBboxes.reduce((sum, b) => sum + Math.max(0, b.w) * Math.max(0, b.h), 0);
        imageResults.push({
          image: img.image,
          predictionCount: predBboxes.length,
          gtCount: 0,
          ...(coveredArea > 0 ? {
            metrics: {
              recall: 0,
              precision: 0,
              f1: 0,
              coverage: totalArea > 0 ? Math.min(1, coveredArea / totalArea) : 0,
              gtCount: 0,
              predCount: predBboxes.length,
              matchedCount: 0,
              perType: {},
            } as MetricsReport,
          } : {}),
        });
      }
    } catch (err) {
      imageResults.push({
        image: img.image,
        predictionCount: 0,
        gtCount: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const annotatedResults = imageResults.filter((r) => r.metrics !== undefined && input.mode === 'annotated');
  const count = Math.max(1, annotatedResults.length);
  const meanRecall = annotatedResults.reduce((s, r) => s + (r.metrics!.recall), 0) / count;
  const meanPrecision = annotatedResults.reduce((s, r) => s + (r.metrics!.precision), 0) / count;
  const meanF1 = annotatedResults.reduce((s, r) => s + (r.metrics!.f1), 0) / count;
  const meanCoverage = imageResults.reduce((s, r) => s + (r.metrics?.coverage ?? 0), 0) / Math.max(1, imageResults.length);

  // Per-type macro F1
  const allTypes = new Set<string>();
  for (const r of annotatedResults) {
    for (const t of Object.keys(r.metrics!.perType)) allTypes.add(t);
  }
  let typeF1Sum = 0;
  for (const t of allTypes) {
    const typeResults = annotatedResults.filter((r) => r.metrics!.perType[t] !== undefined);
    if (typeResults.length > 0) {
      typeF1Sum += typeResults.reduce((s, r) => s + r.metrics!.perType[t]!.f1, 0) / typeResults.length;
    }
  }
  const perTypeMacroF1 = allTypes.size > 0 ? typeF1Sum / allTypes.size : 0;

  return {
    mode: input.mode,
    images: imageResults,
    summary: {
      meanRecall,
      meanPrecision,
      meanF1,
      meanCoverage,
      totalImages: imageResults.length,
      totalPredictions: imageResults.reduce((s, r) => s + r.predictionCount, 0),
      totalGt: imageResults.reduce((s, r) => s + r.gtCount, 0),
      perTypeMacroF1,
    },
  };
}
