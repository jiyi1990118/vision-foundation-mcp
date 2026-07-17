/**
 * Strict-mode structural validation for {@link UiReconstructionSpec}
 * (Stream S24 G-B1).
 *
 * Pure structural checks only (no JSON Schema / ajv dependency). Throws a
 * plain `Error` on the first missing or malformed required field so callers
 * can surface the failure instead of degrading silently. Designed to be
 * invoked from the orchestrator when `strict_mode` is enabled.
 *
 * Required fields: `page`, `tree`, `constraints`, `images`, `stats`.
 * `tree` must carry `type` / `bbox` / `children`; `stats.nodeCount` must be
 * greater than zero (an empty tree is treated as a failed reconstruction).
 *
 * @see ./reconstruction/index.js  (UiReconstructionSpec source of truth)
 */
import type { UiReconstructionSpec } from './reconstruction/index.js';

/**
 * Validate that a {@link UiReconstructionSpec} carries the required recovery
 * fields and that the tree is non-empty. Throws on the first violation.
 */
export function validateReconstruction(spec: UiReconstructionSpec): void {
  if (!spec || typeof spec !== 'object') {
    throw new Error('uiReconstruction validation failed: spec is not an object');
  }
  if (!spec.page) {
    throw new Error('uiReconstruction validation failed: missing required field "page"');
  }
  if (!spec.tree) {
    throw new Error('uiReconstruction validation failed: missing required field "tree"');
  }
  if (!Array.isArray(spec.constraints)) {
    throw new Error('uiReconstruction validation failed: "constraints" must be an array');
  }
  if (!Array.isArray(spec.images)) {
    throw new Error('uiReconstruction validation failed: "images" must be an array');
  }
  if (!spec.stats || typeof spec.stats !== 'object') {
    throw new Error('uiReconstruction validation failed: missing required field "stats"');
  }

  const tree = spec.tree;
  if (typeof tree.type !== 'string' || tree.type.length === 0) {
    throw new Error('uiReconstruction validation failed: tree missing "type"');
  }
  if (!tree.bbox || typeof tree.bbox !== 'object') {
    throw new Error('uiReconstruction validation failed: tree missing "bbox"');
  }
  if (!Array.isArray(tree.children)) {
    throw new Error('uiReconstruction validation failed: tree "children" must be an array');
  }

  if (typeof spec.stats.nodeCount !== 'number' || spec.stats.nodeCount <= 0) {
    throw new Error('uiReconstruction validation failed: stats.nodeCount must be > 0 (empty tree)');
  }
}
