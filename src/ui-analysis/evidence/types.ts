import type { BBox } from '../ir/types.js';

export type EvidenceSource = 'cv' | 'ocr' | 'ui-detector' | 'omniparser' | 'pixel' | 'vlm';

export interface EvidenceCandidate {
  id: string;
  type: string;
  bbox: BBox;
  score: number;
  sources: EvidenceSource[];
  text?: string;
  state?: string;
  variant?: string;
  conflictReason?: string;
}

export interface EvidenceIR {
  candidates: EvidenceCandidate[];
}

export function isValidBBox(bbox: BBox): boolean {
  return (
    Number.isFinite(bbox.x) &&
    Number.isFinite(bbox.y) &&
    Number.isFinite(bbox.w) &&
    Number.isFinite(bbox.h) &&
    bbox.w > 0 &&
    bbox.h > 0
  );
}
