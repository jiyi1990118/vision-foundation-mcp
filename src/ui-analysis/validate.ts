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
export function validateReconstruction(
  spec: UiReconstructionSpec,
  options: { summaryOnly?: boolean } = {},
): void {
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

  const ids = new Set<string>();
  const actualCounts: Record<string, number> = {};
  let actualNodeCount = 0;
  const walk = (node: typeof tree): void => {
    if (typeof node.id !== 'string' || node.id.length === 0) {
      throw new Error('uiReconstruction validation failed: tree node missing "id"');
    }
    if (ids.has(node.id)) {
      throw new Error(`uiReconstruction validation failed: duplicate node id "${node.id}"`);
    }
    ids.add(node.id);
    actualNodeCount++;
    actualCounts[node.type] = (actualCounts[node.type] ?? 0) + 1;
    if (!node.bbox || [node.bbox.x, node.bbox.y, node.bbox.w, node.bbox.h].some((n) => !Number.isFinite(n))) {
      throw new Error(`uiReconstruction validation failed: node "${node.id}" has invalid bbox`);
    }
    if (node.bbox.w < 0 || node.bbox.h < 0) {
      throw new Error(`uiReconstruction validation failed: node "${node.id}" has negative bbox size`);
    }
    if (!Array.isArray(node.children)) {
      throw new Error(`uiReconstruction validation failed: node "${node.id}" children must be an array`);
    }
    for (const child of node.children) walk(child);
  };
  walk(tree);

  const declaredCounts = spec.stats.componentCounts;
  if (!declaredCounts || typeof declaredCounts !== 'object') {
    throw new Error('uiReconstruction validation failed: stats.componentCounts must be an object');
  }
  const declaredTotal = Object.values(declaredCounts).reduce((sum, count) => {
    if (!Number.isInteger(count) || count < 0) {
      throw new Error('uiReconstruction validation failed: stats.componentCounts contains an invalid count');
    }
    return sum + count;
  }, 0);
  if (declaredTotal !== spec.stats.nodeCount) {
    throw new Error('uiReconstruction validation failed: stats.componentCounts do not sum to stats.nodeCount');
  }
  if (options.summaryOnly === true) {
    if (actualNodeCount !== 1 || tree.children.length !== 0) {
      throw new Error('uiReconstruction validation failed: summary tree must contain only the root');
    }
    if (spec.constraints.length !== 0 || spec.images.length !== 0) {
      throw new Error('uiReconstruction validation failed: summary output must omit constraints and images');
    }
    if (
      (spec.responsive?.length ?? 0) > 0
      || (spec.repeats?.length ?? 0) > 0
      || (spec.slots?.length ?? 0) > 0
    ) {
      throw new Error('uiReconstruction validation failed: summary output must omit responsive, repeats, and slots');
    }
  } else {
    if (actualNodeCount !== spec.stats.nodeCount) {
      throw new Error('uiReconstruction validation failed: stats.nodeCount does not match tree');
    }
    const allTypes = new Set([...Object.keys(actualCounts), ...Object.keys(declaredCounts)]);
    for (const type of allTypes) {
      if ((actualCounts[type] ?? 0) !== (declaredCounts[type] ?? 0)) {
        throw new Error('uiReconstruction validation failed: stats.componentCounts do not match tree');
      }
    }
  }

  for (const constraint of spec.constraints) {
    if (!ids.has(constraint.targetId)) {
      throw new Error(`uiReconstruction validation failed: constraint target "${constraint.targetId}" is missing`);
    }
  }
  for (const repeat of spec.repeats ?? []) {
    if (!ids.has(repeat.targetId)) {
      throw new Error(`uiReconstruction validation failed: repeat target "${repeat.targetId}" is missing`);
    }
    if (repeat.templateId !== undefined && !ids.has(repeat.templateId)) {
      throw new Error(`uiReconstruction validation failed: repeat template "${repeat.templateId}" is missing`);
    }
  }
  for (const slot of spec.slots ?? []) {
    if (!ids.has(slot.id)) {
      throw new Error(`uiReconstruction validation failed: slot target "${slot.id}" is missing`);
    }
  }
}
