/**
 * Evidence projection: match fused detection candidates to AST nodes and
 * attach per-node evidence metadata.
 *
 * After the DetectorHub fuses candidates from CV / OCR / UI-detector /
 * OmniParser, this module walks the SemanticAST and finds the best-IoU
 * candidate(s) for each node. The result is attached to
 * `node.props.evidence` as a private field consumed by the quality report
 * (critical-element coverage) and downstream diagnostics.
 *
 * Matching strategy:
 *   - For each AST node, compute IoU against every candidate.
 *   - Candidates with IoU >= threshold are linked to the node.
 *   - Type-matched candidates are preferred (same type ranks higher).
 *   - A candidate may link to multiple nodes (a detection can cover both a
 *     parent container and a child leaf); this is intentional so the quality
 *     report can determine whether *any* evidence backs each node.
 */
import type { SemanticAST, ASTNode, BBox } from '../ir/types.js';
import type { EvidenceCandidate, EvidenceSource, SourceVote } from './types.js';

export interface NodeEvidence {
  candidateId: string;
  sources: EvidenceSource[];
  score: number;
  matchIoU: number;
  typeMatch: boolean;
  sourceVotes?: SourceVote[];
  text?: string;
  state?: string;
  conflictReason?: string;
}

export interface ProjectionOptions {
  /** Minimum IoU to link a candidate to a node. Default 0.3. */
  iouThreshold?: number;
}

const DEFAULT_IOU_THRESHOLD = 0.3;

function bboxIoU(a: BBox, b: BBox): number {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  const interW = Math.max(0, x1 - x0);
  const interH = Math.max(0, y1 - y0);
  const intersection = interW * interH;
  const union = a.w * a.h + b.w * b.h - intersection;
  return union > 0 ? intersection / union : 0;
}

function toNodeEvidence(
  candidate: EvidenceCandidate,
  iou: number,
  typeMatch: boolean,
): NodeEvidence {
  const evidence: NodeEvidence = {
    candidateId: candidate.id,
    sources: candidate.sources,
    score: candidate.score,
    matchIoU: iou,
    typeMatch,
  };
  if (candidate.sourceVotes !== undefined && candidate.sourceVotes.length > 0) {
    evidence.sourceVotes = candidate.sourceVotes;
  }
  if (candidate.text !== undefined) evidence.text = candidate.text;
  if (candidate.state !== undefined) evidence.state = candidate.state;
  if (candidate.conflictReason !== undefined) evidence.conflictReason = candidate.conflictReason;
  return evidence;
}

/**
 * Match fused candidates to AST nodes. Returns a map of nodeId -> NodeEvidence[].
 * Each node's evidence list is sorted by (typeMatch desc, IoU desc) so the
 * best evidence is first.
 */
export function projectEvidenceToNodes(
  candidates: EvidenceCandidate[],
  ast: SemanticAST,
  options?: ProjectionOptions,
): Map<string, NodeEvidence[]> {
  const threshold = options?.iouThreshold ?? DEFAULT_IOU_THRESHOLD;
  const result = new Map<string, NodeEvidence[]>();

  if (candidates.length === 0) return result;

  const walk = (node: ASTNode): void => {
    const linked: NodeEvidence[] = [];
    for (const candidate of candidates) {
      const iou = bboxIoU(node.bbox, candidate.bbox);
      if (iou >= threshold) {
        const typeMatch = candidate.type === node.type;
        linked.push(toNodeEvidence(candidate, iou, typeMatch));
      }
    }
    if (linked.length > 0) {
      linked.sort((a, b) => {
        if (a.typeMatch !== b.typeMatch) return a.typeMatch ? -1 : 1;
        return b.matchIoU - a.matchIoU;
      });
      result.set(node.id, linked);
    }
    for (const child of node.children) walk(child);
  };

  walk(ast.root);
  return result;
}

/**
 * Inject evidence metadata into AST nodes in place.
 * Sets `node.props.evidence` to the linked NodeEvidence[] for each matched
 * node. Nodes with no evidence are left untouched.
 */
export function injectEvidenceIntoAst(
  ast: SemanticAST,
  evidenceMap: Map<string, NodeEvidence[]>,
): void {
  const walk = (node: ASTNode): void => {
    const evidence = evidenceMap.get(node.id);
    if (evidence !== undefined) {
      node.props.evidence = evidence;
    }
    for (const child of node.children) walk(child);
  };
  walk(ast.root);
}

/**
 * Collect all nodes that have evidence backing, optionally filtered by type.
 */
export function nodesWithEvidence(
  ast: SemanticAST,
  typeFilter?: Set<string>,
): { id: string; type: string }[] {
  const result: { id: string; type: string }[] = [];
  const walk = (node: ASTNode): void => {
    const hasEvidence = Array.isArray(node.props.evidence) && (node.props.evidence as unknown[]).length > 0;
    if (hasEvidence && (typeFilter === undefined || typeFilter.has(node.type))) {
      result.push({ id: node.id, type: node.type });
    }
    for (const child of node.children) walk(child);
  };
  walk(ast.root);
  return result;
}
