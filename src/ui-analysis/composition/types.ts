import type { BBox } from '../ir/types.js';
import type { EvidenceCandidate } from '../evidence/types.js';

export type RelationType =
  | 'contains'
  | 'overlaps'
  | 'alignedWith'
  | 'labels'
  | 'decorates'
  | 'occludes'
  | 'backgroundOf';

export interface RelationEdge {
  from: string;
  to: string;
  type: RelationType;
}

export interface CompositionGraph {
  nodes: EvidenceCandidate[];
  edges: RelationEdge[];
}

export function bboxContains(outer: BBox, inner: BBox): boolean {
  return (
    outer.x <= inner.x &&
    outer.y <= inner.y &&
    outer.x + outer.w >= inner.x + inner.w &&
    outer.y + outer.h >= inner.y + inner.h
  );
}
