/**
 * Convert a SemanticAST into benchmark predicted items.
 *
 * Unlike {@link extractPredictionsFromAst} in runner.ts (which includes every
 * non-page node), this converter filters out `semantic-only` render nodes
 * since those represent inferred placeholders that should not participate in
 * IoU matching against ground-truth annotations.
 */
import type { ASTNode, SemanticAST } from '../ir/types.js';
import type { PredictedItem } from './metrics.js';

export function astToPredictions(ast: SemanticAST): PredictedItem[] {
  const preds: PredictedItem[] = [];
  const walk = (node: ASTNode): void => {
    if (node.type !== 'page') {
      const render = node.props.render;
      const mode =
        render !== null && typeof render === 'object' && 'mode' in render
          ? (render as { mode: string }).mode
          : null;
      if (mode !== 'semantic-only') {
        preds.push({ id: node.id, type: node.type, bbox: node.bbox });
      }
    }
    for (const c of node.children) walk(c);
  };
  walk(ast.root);
  return preds;
}
