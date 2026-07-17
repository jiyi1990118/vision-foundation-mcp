/**
 * Responsive Engine - infers responsive breakpoint hints (sidebar collapse,
 * grid stack, table horizontal scroll, column merge) from a SemanticAST and
 * its LayoutIR. Pure, deterministic, no IO.
 *
 * Each hit emits one `CodegenResponsiveRule`; duplicate (breakpoint, layout)
 * pairs are deduplicated. An empty / minimal layout yields no rules.
 *
 * @see ../ir/types.js            (SemanticAST / ASTNode / LayoutIR / CodegenResponsiveRule)
 * @see ../constraint/constraint-engine.js  (inferConstraints for grid detection)
 */
import type {
  ASTNode,
  CodegenResponsiveRule,
  LayoutIR,
  SemanticAST,
} from '../ir/types.js';
import { inferConstraints } from '../constraint/constraint-engine.js';

function hasSidebarRegion(layout: LayoutIR): boolean {
  return layout.regions.some((r) => r.type === 'sidebar');
}

function hasSidebarAst(ast: SemanticAST): boolean {
  const pageW = ast.root.bbox.w;
  if (pageW <= 0) return false;
  let hit = false;
  const walk = (node: ASTNode): void => {
    if (
      node.type === 'sidebar' &&
      node.bbox.x < pageW * 0.3 &&
      node.bbox.w < pageW * 0.3
    ) {
      hit = true;
    }
    for (const child of node.children) walk(child);
  };
  walk(ast.root);
  return hit;
}

function hasTable(ast: SemanticAST, layout: LayoutIR): boolean {
  if (layout.regions.some((r) => r.type === 'table')) return true;
  let hit = false;
  const walk = (node: ASTNode): void => {
    if (node.type === 'table') hit = true;
    for (const child of node.children) walk(child);
  };
  walk(ast.root);
  return hit;
}

function hasStackableGrid(ast: SemanticAST): boolean {
  const dirById = new Map<string, 'row' | 'column' | 'grid'>();
  for (const c of inferConstraints(ast)) {
    if (c.direction) dirById.set(c.targetId, c.direction);
  }
  let hit = false;
  const walk = (node: ASTNode): void => {
    if (dirById.get(node.id) === 'grid' && node.children.length > 2) hit = true;
    for (const child of node.children) walk(child);
  };
  walk(ast.root);
  return hit;
}

/**
 * Infer responsive breakpoint rules for the given AST + layout. Returns an
 * empty array when no responsive signal is present.
 */
export function inferResponsive(
  ast: SemanticAST,
  layout: LayoutIR,
): CodegenResponsiveRule[] {
  const rules: CodegenResponsiveRule[] = [];
  const seen = new Set<string>();
  const add = (breakpoint: string, layoutName: string): void => {
    const key = `${breakpoint}:${layoutName}`;
    if (seen.has(key)) return;
    seen.add(key);
    rules.push({ breakpoint, layout: layoutName });
  };

  if (hasSidebarRegion(layout) || hasSidebarAst(ast)) {
    add('mobile', 'sidebar-collapse');
  }
  if (hasStackableGrid(ast)) {
    add('mobile', 'stack-vertically');
  }
  if (hasTable(ast, layout)) {
    add('mobile', 'horizontal-scroll');
  }
  if (layout.layoutType === 'columns' && layout.regions.length > 2) {
    add('tablet', 'merge-columns');
  }

  return rules;
}
