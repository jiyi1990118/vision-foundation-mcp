/**
 * Phase C2: Manifest and Data Export.
 *
 * Generates per-sample manifests with content hashes and review state, and
 * exports samples with separated fields (human-final, pipeline-prediction,
 * ai-pre-review, review-actions, manifest) so every exported artifact is
 * traceable to a reviewed source.
 *
 * @see Docs/superpowers/specs/2026-07-24-annotation-mainline-supplement.md
 */
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, basename, extname, relative } from 'node:path';
import {
  loadAnnotation,
  loadDatasetWithExclusions,
  type AnnotationFile,
} from './annotation-loader.js';

const DRAFT_WARNING = 'pipeline-generated draft annotation - not human verified';

export interface SampleManifest {
  sampleId: string;
  imageFile: string;
  annotationFile: string;
  imageHash: string;
  annotationHash: string;
  predictionHash: string | null;
  aiReviewHash: string | null;
  reviewActionsHash: string | null;
  reviewed: boolean;
  split: string | null;
}

export interface ExportedSample {
  sampleId: string;
  manifest: SampleManifest;
  humanFinal: AnnotationFile;
  pipelinePrediction: AnnotationFile | null;
  aiPreReview: unknown | null;
  reviewActions: unknown | null;
}

export type DatasetExport = ExportedSample[];

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function hashFile(path: string): string {
  return sha256(readFileSync(path));
}

function hashOptional(path: string): string | null {
  return existsSync(path) ? hashFile(path) : null;
}

function readOptionalJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf-8')) as T;
}

function sampleIdFromAnnotation(filename: string): string {
  return basename(filename, extname(filename));
}

/**
 * Build a per-sample manifest with content hashes, review state, and split
 * assignment. The split defaults to null until C3 assigns it.
 */
export function buildManifest(datasetDir: string, annotationRelativePath: string): SampleManifest {
  const annotationPath = join(datasetDir, annotationRelativePath);
  const annotation = loadAnnotation(annotationPath);
  const imageDir = dirname(annotationPath);
  const imagePath = join(imageDir, annotation.image);

  return {
    sampleId: sampleIdFromAnnotation(annotationRelativePath),
    imageFile: annotation.image,
    annotationFile: annotationRelativePath,
    imageHash: hashFile(imagePath),
    annotationHash: hashFile(annotationPath),
    predictionHash: hashOptional(`${annotationPath}.prediction.json`),
    aiReviewHash: hashOptional(`${annotationPath}.ai-review.json`),
    reviewActionsHash: hashOptional(`${annotationPath}.session.json`),
    reviewed: !annotation.warnings.includes(DRAFT_WARNING),
    split: null,
  };
}

/**
 * Export all eligible (reviewed) samples from a dataset directory with
 * separated fields. Draft annotations are excluded so every exported sample
 * is traceable to a human-reviewed source.
 */
export function exportDataset(datasetDir: string): DatasetExport {
  const { entries } = loadDatasetWithExclusions(datasetDir);
  const samples: ExportedSample[] = [];

  for (const { annotation, imagePath } of entries) {
    const annotationDir = dirname(imagePath);
    const annotationFileName = basename(imagePath.replace(/\.(jpg|jpeg|png)$/i, '.json'));
    const annotationFullPath = join(annotationDir, annotationFileName);
    const annotationRelativePath = relative(datasetDir, annotationFullPath);

    const manifest = buildManifest(datasetDir, annotationRelativePath);
    const prediction = readOptionalJson<AnnotationFile>(`${annotationFullPath}.prediction.json`);
    const aiReview = readOptionalJson(`${annotationFullPath}.ai-review.json`);
    const reviewActions = readOptionalJson(`${annotationFullPath}.session.json`);

    samples.push({
      sampleId: manifest.sampleId,
      manifest,
      humanFinal: annotation,
      pipelinePrediction: prediction,
      aiPreReview: aiReview,
      reviewActions,
    });
  }

  return samples;
}
