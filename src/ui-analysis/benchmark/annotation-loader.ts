/**
 * Annotation loader for the UI reconstruction benchmark.
 *
 * Loads ground-truth annotation JSON files conforming to
 * `Docs/02-contracts/05-annotation-spec.md` and pairs them with
 * screenshot images for benchmark evaluation.
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import type { BBox } from '../ir/types.js';

export interface AnnotationElement {
  id: string;
  type: string;
  semanticRole?: string;
  bbox: BBox;
  render: string;
  text?: string;
  variant?: string;
  control?: { family: string; state: string; shape?: string };
  labelNodeId?: string;
  children?: string[];
  backgroundAsset?: boolean;
  assetRegion?: { kind: string; allowFallback?: boolean };
}

export type RelationSource = 'human' | 'derived' | 'ai';
export type ReviewStatus = 'auto' | 'confirmed' | 'overridden' | 'suppressed';

export interface AnnotationRelation {
  from: string;
  to: string;
  type: string;
  source?: RelationSource;
  confidence?: number;
  reviewStatus?: ReviewStatus;
}

export interface ZOrderEntry {
  id: string;
  z: number;
}

export interface AnnotationFile {
  image: string;
  imageSize: { width: number; height: number };
  platform: 'app' | 'web' | 'desktop';
  theme: 'light' | 'dark';
  language: 'zh' | 'en' | 'mixed';
  dpi: 'standard' | 'high';
  elements: AnnotationElement[];
  relations: AnnotationRelation[];
  zOrder: ZOrderEntry[];
  warnings: string[];
}

export interface DatasetEntry {
  annotation: AnnotationFile;
  imagePath: string;
}

function validateAnnotation(raw: unknown): AnnotationFile {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('annotation root must be an object');
  }
  const obj = raw as Record<string, unknown>;
  const required = ['image', 'imageSize', 'platform', 'theme', 'language', 'dpi', 'elements'];
  for (const key of required) {
    if (!(key in obj)) {
      throw new Error(`annotation missing required field: ${key}`);
    }
  }
  const size = obj.imageSize as Record<string, unknown>;
  if (typeof size?.width !== 'number' || typeof size?.height !== 'number') {
    throw new Error('annotation imageSize must have numeric width and height');
  }
  if (!Array.isArray(obj.elements)) {
    throw new Error('annotation elements must be an array');
  }
  for (const el of obj.elements as Record<string, unknown>[]) {
    if (typeof el.id !== 'string' || typeof el.type !== 'string') {
      throw new Error('annotation element missing id or type');
    }
    const bbox = el.bbox as Record<string, unknown>;
    if (
      typeof bbox?.x !== 'number' ||
      typeof bbox?.y !== 'number' ||
      typeof bbox?.w !== 'number' ||
      typeof bbox?.h !== 'number'
    ) {
      throw new Error(`annotation element ${String(el.id)} has invalid bbox`);
    }
    if (typeof el.render !== 'string') {
      throw new Error(`annotation element ${String(el.id)} missing render field`);
    }
  }
  return {
    image: obj.image as string,
    imageSize: obj.imageSize as { width: number; height: number },
    platform: obj.platform as 'app' | 'web' | 'desktop',
    theme: obj.theme as 'light' | 'dark',
    language: obj.language as 'zh' | 'en' | 'mixed',
    dpi: obj.dpi as 'standard' | 'high',
    elements: obj.elements as AnnotationElement[],
    relations: Array.isArray(obj.relations) ? (obj.relations as AnnotationRelation[]) : [],
    zOrder: Array.isArray(obj.zOrder) ? (obj.zOrder as ZOrderEntry[]) : [],
    warnings: Array.isArray(obj.warnings) ? (obj.warnings as string[]) : [],
  };
}

export function loadAnnotation(filePath: string): AnnotationFile {
  const raw = readFileSync(filePath, 'utf-8');
  return validateAnnotation(JSON.parse(raw));
}

const DRAFT_WARNING = 'pipeline-generated draft annotation - not human verified';

const SIDECAR_SUFFIXES = ['.prediction.json', '.review.json', '.ai-review.json', '.session.json', '.bak'];

export function isSidecarFile(filename: string): boolean {
  return SIDECAR_SUFFIXES.some((suffix) => filename.endsWith(suffix));
}

export interface BenchmarkEligibility {
  eligible: boolean;
  reason?: string;
}

export function isBenchmarkEligible(annotation: AnnotationFile): BenchmarkEligibility {
  if (annotation.warnings.includes(DRAFT_WARNING)) {
    return { eligible: false, reason: 'draft: annotation not human-reviewed' };
  }
  return { eligible: true };
}

export interface DatasetLoadResult {
  entries: DatasetEntry[];
  excluded: Array<{ file: string; reason: string }>;
}

/**
 * Scan a dataset directory for annotation + image pairs.
 *
 * Expected structure:
 *   <dir>/
 *     app/screenshot_001.png
 *     app/screenshot_001.json
 *     web/...
 *     desktop/...
 *
 * Each `.json` annotation file is paired with the image file of the same
 * basename. If the image file does not exist, the entry is skipped with a
 * warning printed to stderr. Sidecar files (.prediction.json, .review.json,
 * .ai-review.json, .session.json, .bak) and draft annotations are excluded.
 */
export function loadDataset(dir: string): DatasetEntry[] {
  return loadDatasetWithExclusions(dir).entries;
}

export function loadDatasetWithExclusions(dir: string): DatasetLoadResult {
  if (!existsSync(dir)) {
    throw new Error(`dataset directory does not exist: ${dir}`);
  }
  const entries: DatasetEntry[] = [];
  const excluded: Array<{ file: string; reason: string }> = [];

  const scanDir = (d: string): void => {
    const items = readdirSync(d);
    for (const item of items) {
      const fullPath = join(d, item);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        scanDir(fullPath);
        continue;
      }
      if (extname(item).toLowerCase() !== '.json') continue;
      if (isSidecarFile(item)) {
        excluded.push({ file: item, reason: 'sidecar' });
        continue;
      }

      let annotation: AnnotationFile;
      try {
        annotation = loadAnnotation(fullPath);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        excluded.push({ file: item, reason: `invalid: ${message}` });
        continue;
      }
      const eligibility = isBenchmarkEligible(annotation);
      if (!eligibility.eligible) {
        excluded.push({ file: item, reason: eligibility.reason ?? 'ineligible' });
        continue;
      }
      const imageDir = dirname(fullPath);
      const imageBase = annotation.image;
      const imagePath = join(imageDir, imageBase);
      if (!existsSync(imagePath)) {
        process.stderr.write(`[warn] image not found for annotation ${item}: ${imageBase}\n`);
        continue;
      }
      entries.push({ annotation, imagePath });
    }
  };

  scanDir(dir);
  return { entries, excluded };
}

/**
 * Convert annotation elements to ground-truth items for benchmark matching.
 */
export function annotationToGroundTruth(
  annotation: AnnotationFile,
): Array<{ id: string; type: string; bbox: BBox }> {
  return annotation.elements.map((el) => ({
    id: el.id,
    type: el.type,
    bbox: el.bbox,
  }));
}
