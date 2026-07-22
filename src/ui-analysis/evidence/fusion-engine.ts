import type { BBox } from '../ir/types.js';
import type { EvidenceCandidate, EvidenceIR } from './types.js';

export interface FusionOptions {
  iouThreshold: number;
  wbfThreshold?: number;
}

function bboxIou(a: BBox, b: BBox): number {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  const intersection = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const areaA = a.w * a.h;
  const areaB = b.w * b.h;
  const union = areaA + areaB - intersection;
  return union > 0 ? intersection / union : 0;
}

function weightedMerge(a: EvidenceCandidate, b: EvidenceCandidate): EvidenceCandidate {
  const totalScore = a.score + b.score;
  const wa = a.score / totalScore;
  const wb = b.score / totalScore;
  const mergedBbox: BBox = {
    x: a.bbox.x * wa + b.bbox.x * wb,
    y: a.bbox.y * wa + b.bbox.y * wb,
    w: a.bbox.w * wa + b.bbox.w * wb,
    h: a.bbox.h * wa + b.bbox.h * wb,
  };
  const mergedScore = (a.score + b.score) / 2;
  const sources = Array.from(new Set([...a.sources, ...b.sources]));
  const result: EvidenceCandidate = {
    id: a.id,
    type: a.type,
    bbox: mergedBbox,
    score: mergedScore,
    sources,
  };
  // Preserve text from whichever has it (prefer higher score)
  const textSource = a.score >= b.score ? a : b;
  if (textSource.text !== undefined) result.text = textSource.text;
  if (textSource.state !== undefined) result.state = textSource.state;
  if (textSource.variant !== undefined) result.variant = textSource.variant;
  return result;
}

export function fuseEvidence(candidates: EvidenceCandidate[], options: FusionOptions): EvidenceIR {
  const { iouThreshold, wbfThreshold } = options;
  if (candidates.length === 0) return { candidates: [] };

  // Group by type
  const byType = new Map<string, EvidenceCandidate[]>();
  for (const c of candidates) {
    const group = byType.get(c.type);
    if (group === undefined) {
      byType.set(c.type, [c]);
    } else {
      group.push(c);
    }
  }

  const result: EvidenceCandidate[] = [];

  for (const [, group] of byType) {
    // Sort by score descending
    const sorted = [...group].sort((a, b) => b.score - a.score);
    const used = new Set<string>();

    for (let i = 0; i < sorted.length; i++) {
      if (used.has(sorted[i]!.id)) continue;
      let current = sorted[i]!;

      for (let j = i + 1; j < sorted.length; j++) {
        if (used.has(sorted[j]!.id)) continue;
        const other = sorted[j]!;
        const iou = bboxIou(current.bbox, other.bbox);

        if (wbfThreshold !== undefined && iou >= wbfThreshold) {
          // WBF: merge
          current = weightedMerge(current, other);
          used.add(other.id);
        } else if (iou >= iouThreshold) {
          // NMS: suppress lower score
          used.add(other.id);
        }
      }
      result.push(current);
    }
  }

  return { candidates: result };
}
