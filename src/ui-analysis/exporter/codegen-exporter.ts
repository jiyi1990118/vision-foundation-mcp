/**
 * Codegen Exporter - converts a SemanticAST into a framework-agnostic
 * CodegenIR tree. Pure, deterministic, no IO, no model calls.
 *
 * The ASTNode tree is projected onto a CodegenNode tree, preserving factual
 * geometry/text plus id / type / props; children are recursed. Constraints are
 * inferred by reusing the shared constraint engine. Responsive breakpoint
 * rules are inferred when a LayoutIR is supplied (else an empty array).
 * Repeated isomorphic sibling groups are detected by the repeat engine.
 * `slots` defaults to an empty array.
 *
 * @see src/ui-analysis/ir/types.ts  (CodegenIR / CodegenNode contract)
 * @see src/ui-analysis/constraint/constraint-engine.ts  (inferConstraints)
 * @see src/ui-analysis/responsive/responsive-engine.ts  (inferResponsive)
 * @see src/ui-analysis/repeats/repeat-engine.ts  (detectRepeats)
 * @see src/ui-analysis/plugin/types.ts  (Exporter trait)
 */
import type { Exporter } from '../plugin/types.js';
import type {
  ASTNode,
  CodegenIR,
  CodegenNode,
  LayoutIR,
  SemanticAST,
} from '../ir/types.js';
import { inferConstraints } from '../constraint/constraint-engine.js';
import { inferResponsive } from '../responsive/index.js';
import { detectRepeats } from '../repeats/index.js';

function toCodegenNode(node: ASTNode): CodegenNode {
  return {
    id: node.id,
    type: node.type,
    bbox: node.bbox,
    props: node.props,
    ...(node.text !== undefined ? { text: node.text } : {}),
    children: node.children.map(toCodegenNode),
  };
}

/**
 * Project a SemanticAST into a CodegenIR with inferred constraints. When a
 * LayoutIR is supplied, responsive breakpoint rules are inferred from it;
 * otherwise `responsive` defaults to an empty array. Repeated sibling groups
 * are always detected from the AST.
 */
export function toCodegenIr(ast: SemanticAST, layout?: LayoutIR): CodegenIR {
  const repeats = detectRepeats(ast);
  return {
    root: toCodegenNode(ast.root),
    constraints: inferConstraints(ast),
    responsive: layout ? inferResponsive(ast, layout) : [],
    slots: repeats
      .filter((r) => r.templateId !== undefined && r.templateType !== undefined)
      .map((r) => ({ id: r.templateId!, name: `${r.templateType!}Template` })),
    repeats,
  };
}

/** Exporter trait implementation: SemanticAST -> CodegenIR. */
export class CodegenExporter implements Exporter {
  readonly format = 'codegen-ir';
  export(ast: SemanticAST): CodegenIR {
    return toCodegenIr(ast);
  }
}
