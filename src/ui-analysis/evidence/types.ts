import type { BBox } from '../ir/types.js';

export type EvidenceSource = 'cv' | 'ocr' | 'ui-detector' | 'omniparser' | 'pixel' | 'vlm';

/**
 * Per-source provenance vote. When candidates from multiple sources fuse,
 * each source's independent detection (type + score) is preserved here so
 * downstream consumers can audit which source contributed what.
 */
export interface SourceVote {
  source: EvidenceSource;
  score: number;
  /** The type this source independently detected (may differ from the fused type). */
  type?: string;
}

export interface EvidenceCandidate {
  id: string;
  type: string;
  bbox: BBox;
  score: number;
  sources: EvidenceSource[];
  /** Per-source breakdown of how this fused candidate was assembled. */
  sourceVotes?: SourceVote[];
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
