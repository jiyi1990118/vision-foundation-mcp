/**
 * Relationship Engine - derives structural relationships from a SemanticAST.
 *
 * Walks the already-built tree and emits a parent map, explicit containment
 * pairs, and text bindings. Pure, deterministic, no IO.
 *
 * @see src/ui-analysis/ir/types.ts
 */
import type { SemanticAST, ASTNode } from '../ir/types.js';

export interface RelationshipResult {
  parents: Record<string, string | null>;
  containment: Array<{ parent: string; child: string }>;
  textBindings: Array<{ nodeId: string; text: string }>;
}

function walk(node: ASTNode, parentId: string | null, out: RelationshipResult): void {
  out.parents[node.id] = parentId;
  if (parentId !== null) {
    out.containment.push({ parent: parentId, child: node.id });
  }
  if (node.text !== undefined && node.text !== '') {
    out.textBindings.push({ nodeId: node.id, text: node.text });
  }
  for (const child of node.children) {
    walk(child, node.id, out);
  }
}

/**
 * Infer relationships (parent links, containment pairs, text bindings) by
 * walking a SemanticAST. The root node maps to a null parent.
 */
export function inferRelationships(ast: SemanticAST): RelationshipResult {
  const out: RelationshipResult = {
    parents: {},
    containment: [],
    textBindings: [],
  };
  walk(ast.root, null, out);
  return out;
}
