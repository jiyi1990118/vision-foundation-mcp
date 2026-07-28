import { copyFile, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';
import type { AnnotationFile } from '../benchmark/annotation-loader.js';
import { buildReviewReport, type AnnotationReviewReport } from './diff.js';
import { analyzeAnnotationStructure, normalizeAnnotationTree, type StructureIssue } from './tree.js';
import { validateAnnotation as validateAnnotationStructure, type ValidationResult } from './validate.js';
import { emptyReviewSession, applyReviewAction, type ReviewAction, type ReviewSession } from './review-types.js';

export interface AiReviewProposal {
  kind: 'add' | 'replace';
  target?: string;
  type: string;
  bbox: { x: number; y: number; w: number; h: number };
  text?: string;
  note?: string;
}

export interface AiReview {
  source: string;
  status: string;
  summary?: string;
  proposals: AiReviewProposal[];
}

export const DRAFT_WARNING = 'pipeline-generated draft annotation - not human verified';
export const REVIEW_WARNING = 'human-reviewed: local-workbench';

export interface WorkbenchEntry {
  annotationPath: string;
  imagePath: string;
  image: string;
  reviewed: boolean;
}

function isImagePath(filePath: string): boolean {
  return /\.(png|jpe?g)$/i.test(filePath);
}

function validateAnnotation(value: unknown): asserts value is AnnotationFile {
  if (typeof value !== 'object' || value === null) throw new Error('annotation root must be an object');
  const annotation = value as Record<string, unknown>;
  for (const field of ['image', 'imageSize', 'platform', 'theme', 'language', 'dpi', 'elements']) {
    if (!(field in annotation)) throw new Error(`annotation missing required field: ${field}`);
  }
  const imageSize = annotation.imageSize as Record<string, unknown>;
  if (typeof imageSize?.width !== 'number' || typeof imageSize?.height !== 'number') {
    throw new Error('annotation imageSize must have numeric width and height');
  }
  if (!Array.isArray(annotation.elements)) throw new Error('annotation elements must be an array');
  for (const element of annotation.elements as Record<string, unknown>[]) {
    if (typeof element.id !== 'string' || typeof element.type !== 'string' || typeof element.render !== 'string') {
      throw new Error('annotation element missing id, type, or render');
    }
    const bbox = element.bbox as Record<string, unknown>;
    if (typeof bbox?.x !== 'number' || typeof bbox?.y !== 'number' || typeof bbox?.w !== 'number' || typeof bbox?.h !== 'number') {
      throw new Error(`annotation element ${element.id} has invalid bbox`);
    }
  }
}

export class AnnotationWorkbenchStore {
  private readonly root: string;

  constructor(rootDir: string) {
    this.root = resolve(rootDir);
  }

  private resolvePath(relativePath: string): string {
    const target = resolve(this.root, relativePath);
    if (target !== this.root && !target.startsWith(`${this.root}${sep}`)) {
      throw new Error('path outside dataset root');
    }
    return target;
  }

  async listEntries(): Promise<WorkbenchEntry[]> {
    const entries: WorkbenchEntry[] = [];
    const scan = async (dir: string): Promise<void> => {
      for (const item of await readdir(dir)) {
        const fullPath = join(dir, item);
        if ((await stat(fullPath)).isDirectory()) {
          await scan(fullPath);
          continue;
        }
        if (extname(item).toLowerCase() !== '.json' || item.endsWith('.prediction.json') || item.endsWith('.review.json') || item.endsWith('.ai-review.json') || item.endsWith('.session.json')) continue;
        const annotationPath = relative(this.root, fullPath);
        const annotation = await this.readAnnotation(annotationPath);
        const imagePath = relative(this.root, join(dir, annotation.image));
        try {
          if (!(await stat(this.resolvePath(imagePath))).isFile()) continue;
        } catch {
          continue;
        }
        entries.push({
          annotationPath,
          imagePath,
          image: annotation.image,
          reviewed: !annotation.warnings.includes(DRAFT_WARNING),
        });
      }
    };
    await scan(this.root);
    return entries.sort((a, b) => a.annotationPath.localeCompare(b.annotationPath));
  }

  async readAnnotation(relativePath: string): Promise<AnnotationFile> {
    const parsed: unknown = JSON.parse(await readFile(this.resolvePath(relativePath), 'utf-8'));
    validateAnnotation(parsed);
    return parsed;
  }

  async readImage(relativePath: string): Promise<Buffer> {
    if (!isImagePath(relativePath)) throw new Error('unsupported image type');
    return readFile(this.resolvePath(relativePath));
  }

  async readPrediction(relativePath: string): Promise<AnnotationFile> {
    return this.readAnnotation(`${relativePath}.prediction.json`);
  }

  async readReview(relativePath: string): Promise<AnnotationReviewReport> {
    return JSON.parse(await readFile(this.resolvePath(`${relativePath}.review.json`), 'utf-8')) as AnnotationReviewReport;
  }

  async readAiReview(relativePath: string): Promise<AiReview> {
    return JSON.parse(await readFile(this.resolvePath(`${relativePath}.ai-review.json`), 'utf-8')) as AiReview;
  }

  async analyzeStructure(relativePath: string): Promise<StructureIssue[]> {
    return analyzeAnnotationStructure(await this.readAnnotation(relativePath));
  }

  async previewReview(relativePath: string, annotation: AnnotationFile, prediction?: AnnotationFile): Promise<AnnotationReviewReport> {
    validateAnnotation(annotation);
    if (prediction) validateAnnotation(prediction);
    return buildReviewReport(prediction ?? await this.readPrediction(relativePath), annotation);
  }

  private async writeJson(path: string, value: unknown): Promise<void> {
    const temporary = `${path}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
    await rename(temporary, path);
  }

  async saveAnnotation(relativePath: string, annotation: AnnotationFile): Promise<void> {
    if (extname(relativePath).toLowerCase() !== '.json') throw new Error('annotation file must be JSON');
    validateAnnotation(annotation);
    annotation = normalizeAnnotationTree(annotation);
    const validation = validateAnnotationStructure(annotation);
    if (validation.errors.length > 0) {
      throw new Error(`标注校验失败: ${validation.errors.map((e) => e.message).join('; ')}`);
    }
    const destination = this.resolvePath(relativePath);
    const backup = `${destination}.bak`;
    const prediction = `${destination}.prediction.json`;
    try {
      await stat(backup);
    } catch {
      await copyFile(destination, backup);
    }
    try {
      await stat(prediction);
    } catch {
      await copyFile(destination, prediction);
    }
    annotation.warnings = annotation.warnings.filter((warning) => warning !== DRAFT_WARNING);
    if (!annotation.warnings.includes(REVIEW_WARNING)) annotation.warnings.push(REVIEW_WARNING);
    await this.writeJson(destination, annotation);
    await this.writeJson(`${destination}.review.json`, buildReviewReport(await this.readPrediction(relativePath), annotation));
  }

  async readReviewSession(relativePath: string): Promise<ReviewSession> {
    try {
      const raw = await readFile(this.resolvePath(`${relativePath}.session.json`), 'utf-8');
      return JSON.parse(raw) as ReviewSession;
    } catch {
      return emptyReviewSession();
    }
  }

  async saveReviewAction(relativePath: string, action: ReviewAction): Promise<ReviewSession> {
    const session = await this.readReviewSession(relativePath);
    const updated = applyReviewAction(session, action);
    await this.writeJson(this.resolvePath(`${relativePath}.session.json`), updated);
    return updated;
  }

  async validateAnnotationFile(relativePath: string): Promise<ValidationResult> {
    return validateAnnotationStructure(await this.readAnnotation(relativePath));
  }

  async restoreDraft(relativePath: string): Promise<void> {
    const destination = this.resolvePath(relativePath);
    const prediction = await this.readPrediction(relativePath);
    prediction.warnings = prediction.warnings.filter((warning) => warning !== REVIEW_WARNING);
    if (!prediction.warnings.includes(DRAFT_WARNING)) prediction.warnings.push(DRAFT_WARNING);
    await this.writeJson(destination, prediction);
    await this.writeJson(`${destination}.review.json`, buildReviewReport(prediction, prediction));
  }
}
