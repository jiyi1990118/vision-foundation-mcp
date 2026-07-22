export type {
  GroundTruthItem,
  PredictedItem,
  MatchResult,
  PerTypeMetrics,
  MetricsReport,
  MetricsOptions,
} from './metrics.js';
export {
  bboxIoU,
  matchDetections,
  computeRecall,
  computePrecision,
  computeF1,
  computeCoverage,
  computeMetrics,
} from './metrics.js';
export type {
  BenchmarkImageInput,
  BenchmarkImageResult,
  BenchmarkSummary,
  BenchmarkResult,
  RunBenchmarkInput,
} from './runner.js';
export { extractPredictionsFromAst, runBenchmark } from './runner.js';
