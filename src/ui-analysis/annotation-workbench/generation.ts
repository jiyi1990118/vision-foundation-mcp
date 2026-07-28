import type { InferenceResponse } from '../../types/domain.js';
import { extractOcrItems, type OcrItem } from '../../core/key-content-extractor.js';
import { buildReviewReport, type AnnotationReviewReport } from './diff.js';
import type { AnnotationFile } from '../benchmark/annotation-loader.js';

export function shouldCopySourceImage(sourcePath: string, destinationPath: string): boolean {
  return sourcePath !== destinationPath;
}

export function ocrItemsFromInferenceResponse(response: InferenceResponse): OcrItem[] {
  return extractOcrItems(JSON.parse(response.text), 'full');
}

export function createPipelineBaseline(annotation: AnnotationFile): {
  draft: AnnotationFile;
  prediction: AnnotationFile;
  review: AnnotationReviewReport;
} {
  const prediction = structuredClone(annotation);
  const draft = structuredClone(annotation);
  return {
    draft,
    prediction,
    review: buildReviewReport(prediction, draft),
  };
}
