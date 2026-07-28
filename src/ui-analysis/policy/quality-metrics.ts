/**
 * Quality metrics for UI reconstruction.
 *
 * - {@link CRITICAL_ELEMENT_TYPES}: element types whose detection accuracy
 *   is weighted heavily in the quality report.
 * - {@link computeCriticalElementCoverage}: fraction of critical elements
 *   that have evidence backing (from the detector hub projection).
 * - {@link computeUnexplainedArea}: fraction of the image area not covered
 *   by any AST node bbox.
 */
import type { BBox } from '../ir/types.js';

/**
 * Element types whose detection accuracy is weighted heavily in the quality
 * report. These are split into two tiers:
 *
 * 1. Interactive elements (button, input, checkbox, ...) - missing these
 *    means the user cannot interact with the reconstructed UI.
 * 2. Content-bearing elements (card, image, icon, text, table, ...) -
 *    missing these means the reconstruction is visually incomplete.
 *
 * Pure structural containers (page, container, section, grid, ...) are
 * excluded because they are grouping mechanisms, not meaningful content.
 */
export const CRITICAL_ELEMENT_TYPES = new Set([
  // Interactive
  'button',
  'iconButton',
  'input',
  'textarea',
  'select',
  'checkbox',
  'radio',
  'switch',
  'link',
  'tab',
  'dropdown',
  // Content-bearing
  'card',
  'listItem',
  'row',
  'text',
  'title',
  'subtitle',
  'image',
  'avatar',
  'icon',
  'badge',
  'tag',
  'table',
]);

/**
 * Compute the union area of a set of bounding boxes using coordinate
 * compression. Handles overlapping boxes correctly without double-counting.
 *
 * Complexity: O(n^2) in the number of unique coordinates — fine for UI
 * screenshots where n is bounded by the node count (typically < 500).
 */
export function computeUnionArea(boxes: BBox[]): number {
  if (boxes.length === 0) return 0;

  const xs: number[] = [];
  const ys: number[] = [];
  for (const b of boxes) {
    xs.push(b.x, b.x + b.w);
    ys.push(b.y, b.y + b.h);
  }
  const sortedXs = [...new Set(xs)].sort((a, b) => a - b);
  const sortedYs = [...new Set(ys)].sort((a, b) => a - b);

  let totalArea = 0;
  for (let i = 0; i < sortedXs.length - 1; i++) {
    const x0 = sortedXs[i]!;
    const x1 = sortedXs[i + 1]!;
    const stripW = x1 - x0;
    if (stripW <= 0) continue;

    for (let j = 0; j < sortedYs.length - 1; j++) {
      const y0 = sortedYs[j]!;
      const y1 = sortedYs[j + 1]!;
      const stripH = y1 - y0;
      if (stripH <= 0) continue;

      const cellCenterX = (x0 + x1) / 2;
      const cellCenterY = (y0 + y1) / 2;

      for (const b of boxes) {
        if (
          cellCenterX >= b.x &&
          cellCenterX <= b.x + b.w &&
          cellCenterY >= b.y &&
          cellCenterY <= b.y + b.h
        ) {
          totalArea += stripW * stripH;
          break;
        }
      }
    }
  }
  return totalArea;
}

/**
 * Fraction of the image area NOT covered by any bbox.
 * Returns 0 when image dimensions are unknown.
 */
export function computeUnexplainedArea(
  boxes: BBox[],
  imageWidth: number,
  imageHeight: number,
): number {
  const totalArea = imageWidth * imageHeight;
  if (totalArea <= 0) return 0;
  const covered = computeUnionArea(boxes);
  return Math.max(0, 1 - covered / totalArea);
}

/**
 * Fraction of critical element nodes that have evidence backing.
 * Returns 1.0 when there are no critical elements (nothing to cover).
 *
 * @param nodes - All render nodes with their type and evidence status.
 * @returns Coverage ratio in [0, 1].
 */
export function computeCriticalElementCoverage(
  nodes: Array<{ type: string; hasEvidence: boolean }>,
): number {
  const critical = nodes.filter((n) => CRITICAL_ELEMENT_TYPES.has(n.type));
  if (critical.length === 0) return 1;
  const withEvidence = critical.filter((n) => n.hasEvidence).length;
  return withEvidence / critical.length;
}
