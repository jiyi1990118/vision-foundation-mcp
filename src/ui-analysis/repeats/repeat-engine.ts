/**
 * Repeat Engine - detects repeated isomorphic sibling nodes (list items) in a
 * SemanticAST and emits `CodegenRepeat` entries so downstream agents can
 * recognize "this is a list of N similar items" and generate `.map()` etc.
 *
 * For every container node with at least two children, children are grouped by
 * shared `type` AND similar bbox dimensions (width/height each within ±15%
 * relative tolerance, `|a-b|/max(a,b) <= 0.15`). Any group of size >= 2 is a
 * repeat candidate. When a container yields multiple candidate groups, only
 * the largest is reported (one repeat per container) to avoid noise. Pure,
 * deterministic, no IO.
 *
 * @see ../ir/types.js            (SemanticAST / ASTNode / CodegenRepeat)
 * @see ../constraint/constraint-engine.js  (sibling-arrangement traversal pattern)
 */
import type { SemanticAST, ASTNode, CodegenRepeat } from '../ir/types.js';

const SIZE_TOLERANCE = 0.15;

function relativeDiff(a: number, b: number): number {
  const max = Math.max(a, b);
  if (max <= 0) return 0;
  return Math.abs(a - b) / max;
}

function sizesSimilar(a: ASTNode, b: ASTNode): boolean {
  return (
    relativeDiff(a.bbox.w, b.bbox.w) <= SIZE_TOLERANCE &&
    relativeDiff(a.bbox.h, b.bbox.h) <= SIZE_TOLERANCE
  );
}

function groupSimilarChildren(children: ASTNode[]): ASTNode[][] {
  const groups: ASTNode[][] = [];
  const assigned = new Set<number>();
  for (let i = 0; i < children.length; i++) {
    if (assigned.has(i)) continue;
    const seed = children[i]!;
    const group: ASTNode[] = [seed];
    assigned.add(i);
    for (let j = i + 1; j < children.length; j++) {
      if (assigned.has(j)) continue;
      const candidate = children[j]!;
      if (candidate.type === seed.type && sizesSimilar(seed, candidate)) {
        group.push(candidate);
        assigned.add(j);
      }
    }
    groups.push(group);
  }
  return groups;
}

/**
 * Detect repeated isomorphic sibling groups across every container in the AST.
 * Returns an empty array for an empty / minimal tree.
 */
export function detectRepeats(ast: SemanticAST): CodegenRepeat[] {
  const repeats: CodegenRepeat[] = [];
  const walk = (node: ASTNode): void => {
    if (node.children.length >= 2) {
      const candidateGroups = groupSimilarChildren(node.children).filter(
        (g) => g.length >= 2,
      );
      if (candidateGroups.length > 0) {
        const largest = candidateGroups.reduce((best, g) =>
          g.length > best.length ? g : best,
        );
        repeats.push({ targetId: node.id, count: largest.length });
      }
    }
    for (const child of node.children) {
      walk(child);
    }
  };
  walk(ast.root);
  return repeats;
}
