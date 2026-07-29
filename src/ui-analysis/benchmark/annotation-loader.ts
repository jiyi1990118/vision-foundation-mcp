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
import { analyzeAnnotationStructure, findingSubjectId, findingSignature } from '../annotation-workbench/tree.js';
import { reviewStatusFor, type ReviewSession } from '../annotation-workbench/review-types.js';

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

const OPEN_HIGH_SEVERITY_REASON = 'open-high-severity-findings';

/**
 * Gate #5: high-severity (medium) structure findings must be confirmed,
 * overridden, or suppressed in the review session before the annotation is
 * benchmark-eligible.
 *
 * A finding is "open" when the session has no matching action for its
 * subject id, or the stored action's signature no longer matches the current
 * finding (stale suppression - the element's bbox/type changed or the rule
 * version bumped). Returns true if ANY medium-severity finding is open.
 */
export function hasOpenHighSeverityFindings(
  annotation: AnnotationFile,
  session?: ReviewSession,
): boolean {
  const findings = analyzeAnnotationStructure(annotation).filter(
    (finding) => finding.severity === 'medium',
  );
  if (findings.length === 0) return false;
  for (const finding of findings) {
    const status = session
      ? reviewStatusFor(
          session,
          'structure-finding',
          findingSubjectId(finding),
          findingSignature(finding),
        )
      : undefined;
    const resolved =
      status === 'confirmed' || status === 'overridden' || status === 'suppressed';
    if (!resolved) return true;
  }
  return false;
}

export function isBenchmarkEligible(
  annotation: AnnotationFile,
  session?: ReviewSession,
): BenchmarkEligibility {
  if (annotation.warnings.includes(DRAFT_WARNING)) {
    return { eligible: false, reason: 'draft: annotation not human-reviewed' };
  }
  if (hasOpenHighSeverityFindings(annotation, session)) {
    return { eligible: false, reason: OPEN_HIGH_SEVERITY_REASON };
  }
  return { eligible: true };
}

export interface ExcludedEntry {
  file: string;
  reason: string;
}

export interface ExclusionCounts {
  total: number;
  sidecar: number;
  invalid: number;
  draft: number;
  openHighSeverityExcluded: number;
  other: number;
}

export interface DatasetLoadResult {
  entries: DatasetEntry[];
  excluded: ExcludedEntry[];
  counts: ExclusionCounts;
}

function readReviewSession(annotationPath: string): ReviewSession | undefined {
  const sessionPath = `${annotationPath}.session.json`;
  if (!existsSync(sessionPath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(sessionPath, 'utf-8'));
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as ReviewSession).actions)) {
      return parsed as ReviewSession;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function tallyExclusions(excluded: ExcludedEntry[]): ExclusionCounts {
  const counts: ExclusionCounts = {
    total: excluded.length,
    sidecar: 0,
    invalid: 0,
    draft: 0,
    openHighSeverityExcluded: 0,
    other: 0,
  };
  for (const entry of excluded) {
    if (entry.reason === 'sidecar') counts.sidecar += 1;
    else if (entry.reason.startsWith('invalid')) counts.invalid += 1;
    else if (entry.reason.startsWith('draft')) counts.draft += 1;
    else if (entry.reason === OPEN_HIGH_SEVERITY_REASON) counts.openHighSeverityExcluded += 1;
    else counts.other += 1;
  }
  return counts;
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
  const excluded: ExcludedEntry[] = [];

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
      const session = readReviewSession(fullPath);
      const eligibility = isBenchmarkEligible(annotation, session);
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
  return { entries, excluded, counts: tallyExclusions(excluded) };
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
