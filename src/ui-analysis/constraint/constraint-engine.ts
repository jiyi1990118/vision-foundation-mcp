/**
 * Constraint Engine - infers codegen layout constraints (direction / gap /
 * align) for each container node in a SemanticAST by inspecting the bbox
 * arrangement of its children. Pure, deterministic, no IO.
 *
 * @see src/ui-analysis/ir/types.ts
 */
import type { SemanticAST, ASTNode, CodegenConstraint } from '../ir/types.js';

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!;
}

function spread(nums: number[]): number {
  if (nums.length === 0) return 0;
  return Math.max(...nums) - Math.min(...nums);
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function inferDirection(children: ASTNode[]): 'row' | 'column' | 'grid' {
  if (children.length < 2) return 'column';
  const xs = children.map((c) => c.bbox.x + c.bbox.w / 2);
  const ys = children.map((c) => c.bbox.y + c.bbox.h / 2);
  const xRange = spread(xs);
  const yRange = spread(ys);
  const avgW = children.reduce((a, c) => a + c.bbox.w, 0) / children.length;
  const avgH = children.reduce((a, c) => a + c.bbox.h, 0) / children.length;
  const xAligned = xRange < avgW * 0.5;
  const yAligned = yRange < avgH * 0.5;
  if (xAligned && yAligned) {
    return xRange <= yRange ? 'column' : 'row';
  }
  if (xAligned) return 'column';
  if (yAligned) return 'row';
  return 'grid';
}

function inferGap(children: ASTNode[], direction: 'row' | 'column' | 'grid'): number {
  if (children.length < 2) return 0;
  let sorted: ASTNode[];
  const gaps: number[] = [];
  if (direction === 'row') {
    sorted = [...children].sort((a, b) => a.bbox.x - b.bbox.x);
    for (let i = 1; i < sorted.length; i++) {
      gaps.push(sorted[i]!.bbox.x - (sorted[i - 1]!.bbox.x + sorted[i - 1]!.bbox.w));
    }
  } else if (direction === 'column') {
    sorted = [...children].sort((a, b) => a.bbox.y - b.bbox.y);
    for (let i = 1; i < sorted.length; i++) {
      gaps.push(sorted[i]!.bbox.y - (sorted[i - 1]!.bbox.y + sorted[i - 1]!.bbox.h));
    }
  } else {
    // grid: a single `gap` is inherently lossy (grid needs separate row/column
    // gaps). Emit the vertical (row) gap only as the primary spacing, never the
    // mixed x+y median which produces a meaningless value.
    sorted = [...children].sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x);
    const rows: Array<{ top: number; bottom: number }> = [];
    for (const child of sorted) {
      const top = child.bbox.y;
      const bottom = child.bbox.y + child.bbox.h;
      const row = rows.find((candidate) => top < candidate.bottom && bottom > candidate.top);
      if (row !== undefined) {
        row.top = Math.min(row.top, top);
        row.bottom = Math.max(row.bottom, bottom);
      } else {
        rows.push({ top, bottom });
      }
    }
    rows.sort((a, b) => a.top - b.top);
    for (let i = 1; i < rows.length; i++) {
      gaps.push(rows[i]!.top - rows[i - 1]!.bottom);
    }
  }
  const positive = gaps.filter((g) => g > 0);
  return positive.length > 0 ? round1(median(positive)) : 0;
}

function inferAlign(children: ASTNode[], direction: 'row' | 'column' | 'grid'): string {
  if (children.length === 0) return 'start';
  if (direction === 'row') {
    const tol = median(children.map((c) => c.bbox.h)) * 0.3 || 1;
    const tops = children.map((c) => c.bbox.y);
    const centers = children.map((c) => c.bbox.y + c.bbox.h / 2);
    const bottoms = children.map((c) => c.bbox.y + c.bbox.h);
    if (spread(tops) <= tol) return 'top';
    if (spread(centers) <= tol) return 'center';
    if (spread(bottoms) <= tol) return 'bottom';
    return 'start';
  }
  if (direction === 'column') {
    const tol = median(children.map((c) => c.bbox.w)) * 0.3 || 1;
    const lefts = children.map((c) => c.bbox.x);
    const centers = children.map((c) => c.bbox.x + c.bbox.w / 2);
    const rights = children.map((c) => c.bbox.x + c.bbox.w);
    if (spread(lefts) <= tol) return 'left';
    if (spread(centers) <= tol) return 'center';
    if (spread(rights) <= tol) return 'right';
    return 'start';
  }
  return 'start';
}

/**
 * Infer a CodegenConstraint for every container node with at least two
 * children (arrangement inference requires multiple children).
 */
export function inferConstraints(ast: SemanticAST): CodegenConstraint[] {
  const constraints: CodegenConstraint[] = [];
  const walk = (node: ASTNode): void => {
    if (node.children.length >= 2) {
      const direction = inferDirection(node.children);
      const gap = inferGap(node.children, direction);
      const align = inferAlign(node.children, direction);
      constraints.push({ targetId: node.id, direction, gap, align });
    }
    for (const child of node.children) {
      walk(child);
    }
  };
  walk(ast.root);
  return constraints;
}
