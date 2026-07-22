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
import type { SemanticAST, ASTNode, CodegenRepeat, ComponentType } from '../ir/types.js';

const SIZE_TOLERANCE = 0.15;
const MIN_REPEAT_COUNT = 2;

const REPEATABLE_TYPES: ReadonlySet<ComponentType> = new Set([
  'listItem',
  'card',
  'row',
  'section',
]);

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
  const ordered = children
    .filter((child) => REPEATABLE_TYPES.has(child.type))
    .sort((a, b) => (
      a.type.localeCompare(b.type)
      || a.bbox.w - b.bbox.w
      || a.bbox.h - b.bbox.h
      || a.bbox.y - b.bbox.y
      || a.bbox.x - b.bbox.x
      || a.id.localeCompare(b.id)
    ));
  const groups: ASTNode[][] = [];
  for (const candidate of ordered) {
    const group = groups.find((existing) => (
      existing[0]?.type === candidate.type
      && existing.every((member) => sizesSimilar(member, candidate))
    ));
    if (group !== undefined) {
      group.push(candidate);
    } else {
      groups.push([candidate]);
    }
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
    if (node.children.length >= MIN_REPEAT_COUNT) {
      const candidateGroups = groupSimilarChildren(node.children).filter(
        (g) => g.length >= MIN_REPEAT_COUNT,
      );
      if (candidateGroups.length > 0) {
        const largest = candidateGroups.reduce((best, g) =>
          g.length > best.length ? g : best,
        );
        repeats.push({
          targetId: node.id,
          count: largest.length,
          templateId: largest[0]!.id,
          templateType: largest[0]!.type,
        });
      }
    }
    for (const child of node.children) {
      walk(child);
    }
  };
  walk(ast.root);
  return repeats;
}
