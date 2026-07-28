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
export type {
  SyntheticImage,
  SyntheticElement,
  SyntheticAnnotation,
  SyntheticSample,
  SyntheticLayoutType,
  SyntheticDataset,
} from './synthetic-generator.js';
export { generateSyntheticSample, generateSyntheticDataset } from './synthetic-generator.js';
export type {
  AnnotationElement,
  AnnotationRelation,
  ZOrderEntry,
  AnnotationFile,
  DatasetEntry,
  DatasetLoadResult,
} from './annotation-loader.js';
export {
  loadAnnotation,
  loadDataset,
  loadDatasetWithExclusions,
  annotationToGroundTruth,
} from './annotation-loader.js';
export { astToPredictions } from './ast-to-predictions.js';
export type {
  SampleManifest,
  ExportedSample,
  DatasetExport,
} from './manifest.js';
export { buildManifest, exportDataset } from './manifest.js';
export type {
  SplitName,
  SplitAssignment,
  SplitRatios,
  SplitOptions,
  LeakageResult,
} from './splitter.js';
export { assignSplits, defaultFamilyKey, verifyNoLeakage } from './splitter.js';
