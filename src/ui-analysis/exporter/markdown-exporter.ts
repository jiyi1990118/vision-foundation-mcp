/**
 * Markdown Exporter - converts a SemanticAST into a human-readable Markdown
 * document. Pure, deterministic, no IO, no model calls.
 *
 * The tree is rendered as a nested bullet list: each node becomes a bullet
 * carrying its id + type (+ text content when present), followed by a fenced
 * code block annotating the component type and bounding box. Depth controls
 * indentation. A single top-level `#` heading records the AST version.
 *
 * @see src/ui-analysis/ir/types.ts  (SemanticAST / ASTNode contract)
 * @see src/ui-analysis/plugin/types.ts  (Exporter trait)
 */
import type { Exporter } from '../plugin/types.js';
import type { ASTNode, SemanticAST } from '../ir/types.js';

function renderNode(node: ASTNode, depth: number, lines: string[]): void {
  const indent = '  '.repeat(depth);
  const textPart = node.text !== undefined ? ` text: "${node.text}"` : '';
  lines.push(`${indent}- **${node.id}** - \`${node.type}\`${textPart}`);
  lines.push(`${indent}  \`\`\``);
  lines.push(`${indent}  type: ${node.type}`);
  lines.push(
    `${indent}  bbox: { x: ${node.bbox.x}, y: ${node.bbox.y}, w: ${node.bbox.w}, h: ${node.bbox.h} }`,
  );
  lines.push(`${indent}  \`\`\``);
  for (const child of node.children) {
    renderNode(child, depth + 1, lines);
  }
}

/** Convert a SemanticAST into a human-readable Markdown string. */
export function toMarkdown(ast: SemanticAST): string {
  const lines: string[] = [`# UI Semantic AST (v${ast.version})`, ''];
  renderNode(ast.root, 0, lines);
  return lines.join('\n');
}

/** Exporter trait implementation: SemanticAST -> Markdown string. */
export class MarkdownExporter implements Exporter {
  readonly format = 'markdown';
  export(ast: SemanticAST): string {
    return toMarkdown(ast);
  }
}
