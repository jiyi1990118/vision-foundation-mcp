/**
 * Phase D: Active Learning - Frequency-Guided Priority.
 *
 * Before the full active-learning threshold (20+ images, 30+ confirmed
 * elements per high-frequency type, calibrated structure rules), images
 * are prioritized for annotation by element-type frequency coverage.
 *
 * Images containing underrepresented element types get higher priority,
 * weighted by inverse frequency so rarer types contribute more.
 *
 * @see Docs/superpowers/specs/2026-07-24-annotation-mainline-supplement.md
 */
import type { AnnotationFile } from './annotation-loader.js';

const DEFAULT_THRESHOLD = 30;
const PAGE_TYPE = 'page';

export interface TypeFrequencyResult {
  counts: Record<string, number>;
  thresholds: Record<string, boolean>;
  typesMeetingThreshold: string[];
  typesNeedingSamples: string[];
  totalElements: number;
  totalTypes: number;
  threshold: number;
}

export interface PriorityEntry {
  image: string;
  score: number;
  underrepresentedTypes: string[];
}

/**
 * Count element types across all annotations (excluding page root).
 * Marks each type as meeting or not meeting the 30-sample threshold.
 */
export function analyzeTypeFrequency(
  annotations: AnnotationFile[],
  threshold: number = DEFAULT_THRESHOLD,
): TypeFrequencyResult {
  const counts: Record<string, number> = {};

  for (const annotation of annotations) {
    for (const element of annotation.elements) {
      if (element.type === PAGE_TYPE) continue;
      counts[element.type] = (counts[element.type] ?? 0) + 1;
    }
  }

  const thresholds: Record<string, boolean> = {};
  const typesMeetingThreshold: string[] = [];
  const typesNeedingSamples: string[] = [];

  for (const [type, count] of Object.entries(counts)) {
    const met = count >= threshold;
    thresholds[type] = met;
    if (met) typesMeetingThreshold.push(type);
    else typesNeedingSamples.push(type);
  }

  return {
    counts,
    thresholds,
    typesMeetingThreshold,
    typesNeedingSamples,
    totalElements: Object.values(counts).reduce((a, b) => a + b, 0),
    totalTypes: Object.keys(counts).length,
    threshold,
  };
}

/**
 * Score an image by how many underrepresented element types it contains.
 * Rarer types (lower count) contribute more to the score via inverse
 * frequency weighting. Images with only well-represented types score 0.
 */
export function scoreImagePriority(
  annotation: AnnotationFile,
  freq: TypeFrequencyResult,
): number {
  let score = 0;
  const seen = new Set<string>();

  for (const element of annotation.elements) {
    if (element.type === PAGE_TYPE) continue;
    if (seen.has(element.type)) continue;
    seen.add(element.type);

    if (!freq.thresholds[element.type]) {
      const count = freq.counts[element.type] ?? 0;
      const weight = count > 0 ? 1 / count : 1;
      score += weight;
    }
  }

  return Math.round(score * 1000) / 1000;
}

/**
 * Build a priority queue of images ranked by priority score descending.
 * Each entry includes the score and the underrepresented types found.
 */
export function buildPriorityQueue(
  annotations: AnnotationFile[],
  freq: TypeFrequencyResult,
): PriorityEntry[] {
  return annotations
    .map((annotation) => {
      const underrepresentedTypes: string[] = [];
      const seen = new Set<string>();
      for (const element of annotation.elements) {
        if (element.type === PAGE_TYPE || seen.has(element.type)) continue;
        seen.add(element.type);
        if (!freq.thresholds[element.type]) {
          underrepresentedTypes.push(element.type);
        }
      }
      return {
        image: annotation.image,
        score: scoreImagePriority(annotation, freq),
        underrepresentedTypes,
      };
    })
    .sort((a, b) => b.score - a.score);
}
