export { assignRenderModes } from './reconstruction-policy.js';
export type { PolicyOptions } from './reconstruction-policy.js';

export type {
  RenderMode,
  RenderInfo,
  NodeConfidence,
  AssetItem,
  AssetManifest,
  QualityReport,
  QualityReportInput,
  QualityReportNode,
} from './types.js';

export {
  CRITICAL_ELEMENT_TYPES,
  computeUnionArea,
  computeUnexplainedArea,
  computeCriticalElementCoverage,
} from './quality-metrics.js';

import type { QualityReport, QualityReportInput } from './types.js';
import { computeUnexplainedArea, computeCriticalElementCoverage } from './quality-metrics.js';

/**
 * Compute the reconstruction quality report from the final enriched AST.
 *
 * - `criticalElementCoverage`: fraction of critical elements (button/input/
 *   checkbox/…) with detector-hub evidence backing.
 * - `editableElementRatio`: fraction of nodes in native/hybrid mode.
 * - `flattenedFallbackRatio`: fraction of nodes in asset mode.
 * - `unexplainedAreaRatio`: fraction of the image not covered by any node.
 *
 * When image dimensions are unavailable, `unexplainedAreaRatio` is 0 and a
 * warning is emitted.
 */
export function computeQualityReport(input: QualityReportInput): QualityReport {
  const { nodes, totalNodes, imageWidth, imageHeight } = input;
  const warnings: string[] = [];

  const editable = nodes.filter((n) => n.render.mode === 'native' || n.render.mode === 'hybrid').length;
  const flattened = nodes.filter((n) => n.render.mode === 'asset').length;
  const denom = Math.max(1, totalNodes);

  const hasImage = imageWidth !== undefined && imageHeight !== undefined;
  // Exclude the page root from the union area: its bbox always spans the
  // full image, so including it would make unexplainedAreaRatio trivially 0.
  // The metric should measure how much of the image is covered by actual
  // content/element nodes, not by the page container.
  const contentBboxes = nodes
    .filter((n) => n.type !== 'page')
    .map((n) => n.bbox);
  const unexplainedAreaRatio = hasImage
    ? computeUnexplainedArea(contentBboxes, imageWidth!, imageHeight!)
    : 0;
  if (!hasImage) {
    warnings.push('no-image-dimensions:unexplainedAreaRatio-set-to-zero');
  }

  return {
    criticalElementCoverage: computeCriticalElementCoverage(
      nodes.map((n) => ({
        type: n.type,
        hasEvidence: Array.isArray(n.evidence) && n.evidence.length > 0,
      })),
    ),
    editableElementRatio: totalNodes === 0 ? 0 : editable / denom,
    flattenedFallbackRatio: totalNodes === 0 ? 0 : flattened / denom,
    unexplainedAreaRatio,
    warnings,
  };
}
