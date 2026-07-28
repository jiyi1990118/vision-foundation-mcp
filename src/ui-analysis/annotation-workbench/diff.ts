import type { AnnotationElement, AnnotationFile } from '../benchmark/annotation-loader.js';

export type DifferenceCategory = 'missed' | 'false_positive' | 'wrong_type' | 'wrong_bbox' | 'wrong_text' | 'wrong_structure' | 'unknown';
export type DifferenceSeverity = 'high' | 'medium' | 'low';
export type DifferenceReviewStatus = 'auto' | 'confirmed' | 'overridden';

export interface AnnotationDifference {
  id: string;
  category: DifferenceCategory;
  predictionId?: string;
  annotationId?: string;
  iou?: number;
  severity: DifferenceSeverity;
  confidence: number;
  reviewStatus: DifferenceReviewStatus;
  note?: string;
  ruleHints: string[];
}

export interface AnnotationReviewReport {
  differences: AnnotationDifference[];
}

interface Match {
  prediction: AnnotationElement;
  annotation: AnnotationElement;
  iou: number;
}

const INTERACTIVE_TYPES = new Set(['button', 'iconButton', 'input', 'textarea', 'select', 'checkbox', 'radio', 'switch', 'tab']);
const CONFUSED_TYPE_PAIRS = new Set([
  'icon:text', 'header:navbar', 'footer:navbar', 'container:card', 'container:section',
  'container:row', 'card:section', 'card:row', 'section:row', 'button:input',
]);

function boxIou(a: AnnotationElement['bbox'], b: AnnotationElement['bbox']): number {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.w, b.x + b.w);
  const bottom = Math.min(a.y + a.h, b.y + b.h);
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
  const union = a.w * a.h + b.w * b.h - intersection;
  return union > 0 ? intersection / union : 0;
}

function normalizedText(element: AnnotationElement): string {
  return element.text?.replace(/\s+/g, ' ').trim() ?? '';
}

function typePair(a: string, b: string): string {
  return [a, b].sort().join(':');
}

function isStructureChange(prediction: AnnotationElement, annotation: AnnotationElement): boolean {
  return prediction.semanticRole !== annotation.semanticRole
    || JSON.stringify(prediction.children ?? []) !== JSON.stringify(annotation.children ?? []);
}

function categorize(match: Match): DifferenceCategory | undefined {
  if (isStructureChange(match.prediction, match.annotation)) return 'wrong_structure';
  if (match.prediction.type !== match.annotation.type) return 'wrong_type';
  if (normalizedText(match.prediction) !== normalizedText(match.annotation)) return 'wrong_text';
  if (match.iou < 0.85) return 'wrong_bbox';
  return undefined;
}

function severity(category: DifferenceCategory, prediction?: AnnotationElement, annotation?: AnnotationElement, iou?: number): DifferenceSeverity {
  const types = [prediction?.type, annotation?.type].filter((type): type is string => type !== undefined);
  if ((category === 'missed' || category === 'false_positive') && types.some((type) => INTERACTIVE_TYPES.has(type))) return 'high';
  if (category === 'wrong_type' && prediction && annotation && CONFUSED_TYPE_PAIRS.has(typePair(prediction.type, annotation.type))) return 'high';
  if (iou !== undefined && iou < 0.5) return 'high';
  if (category === 'wrong_bbox' && iou !== undefined && iou >= 0.7) return 'low';
  return 'medium';
}

function hints(category: DifferenceCategory, prediction?: AnnotationElement, annotation?: AnnotationElement): string[] {
  if (category === 'missed') return [`review recall for ${annotation?.type ?? 'unknown'} detection`];
  if (category === 'false_positive') return [`review precision for ${prediction?.type ?? 'unknown'} detection`];
  if (category === 'wrong_type') return [`review ${prediction?.type ?? 'unknown'} to ${annotation?.type ?? 'unknown'} type disambiguation`];
  if (category === 'wrong_bbox') return ['review bbox refinement and region merging'];
  if (category === 'wrong_text') return ['review OCR-to-element text binding'];
  if (category === 'wrong_structure') return ['review containment and semantic-role inference'];
  return [];
}

function difference(id: string, category: DifferenceCategory, prediction?: AnnotationElement, annotation?: AnnotationElement, iou?: number): AnnotationDifference {
  return {
    id,
    category,
    ...(prediction ? { predictionId: prediction.id } : {}),
    ...(annotation ? { annotationId: annotation.id } : {}),
    ...(iou !== undefined ? { iou } : {}),
    severity: severity(category, prediction, annotation, iou),
    confidence: iou ?? 1,
    reviewStatus: 'auto',
    ruleHints: hints(category, prediction, annotation),
  };
}

export function buildReviewReport(prediction: AnnotationFile, annotation: AnnotationFile): AnnotationReviewReport {
  const candidates: Match[] = [];
  for (const predicted of prediction.elements) {
    for (const human of annotation.elements) {
      const iou = boxIou(predicted.bbox, human.bbox);
      if (iou >= 0.5) candidates.push({ prediction: predicted, annotation: human, iou });
    }
  }
  candidates.sort((a, b) => b.iou - a.iou || a.prediction.id.localeCompare(b.prediction.id) || a.annotation.id.localeCompare(b.annotation.id));

  const matchedPrediction = new Set<string>();
  const matchedAnnotation = new Set<string>();
  const differences: AnnotationDifference[] = [];
  for (const match of candidates) {
    if (matchedPrediction.has(match.prediction.id) || matchedAnnotation.has(match.annotation.id)) continue;
    matchedPrediction.add(match.prediction.id);
    matchedAnnotation.add(match.annotation.id);
    const category = categorize(match);
    if (category) differences.push(difference(`match:${match.prediction.id}:${match.annotation.id}`, category, match.prediction, match.annotation, match.iou));
  }
  for (const predicted of prediction.elements) {
    if (!matchedPrediction.has(predicted.id)) differences.push(difference(`prediction:${predicted.id}`, 'false_positive', predicted));
  }
  for (const human of annotation.elements) {
    if (!matchedAnnotation.has(human.id)) differences.push(difference(`annotation:${human.id}`, 'missed', undefined, human));
  }
  differences.sort((a, b) => a.id.localeCompare(b.id));
  return { differences };
}
