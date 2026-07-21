export type { RelationType, RelationEdge, CompositionGraph } from './types.js';
export { bboxContains } from './types.js';

import type { EvidenceCandidate } from '../evidence/types.js';
import type { CompositionGraph, RelationEdge } from './types.js';
import { bboxContains } from './types.js';

export function buildCompositionGraph(candidates: EvidenceCandidate[]): CompositionGraph {
  const edges: RelationEdge[] = [];
  for (const outer of candidates) {
    for (const inner of candidates) {
      if (outer.id === inner.id) continue;
      if (bboxContains(outer.bbox, inner.bbox)) {
        edges.push({ from: outer.id, to: inner.id, type: 'contains' });
      }
    }
  }
  return { nodes: candidates, edges };
}
