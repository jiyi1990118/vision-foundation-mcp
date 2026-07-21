export { assignRenderModes } from './reconstruction-policy.js';
export type { PolicyOptions } from './reconstruction-policy.js';

export type {
  RenderMode,
  RenderInfo,
  NodeConfidence,
  AssetItem,
  AssetManifest,
  QualityReport,
} from './types.js';

import type { QualityReport, RenderMode } from './types.js';

export function computeQualityReport(
  nodes: Array<{ id: string; render: { mode: RenderMode } }>,
  totalNodes: number,
): QualityReport {
  const editable = nodes.filter((n) => n.render.mode === 'native' || n.render.mode === 'hybrid').length;
  const flattened = nodes.filter((n) => n.render.mode === 'asset').length;
  const denom = Math.max(1, totalNodes);
  return {
    criticalElementCoverage: 0,
    editableElementRatio: totalNodes === 0 ? 0 : editable / denom,
    flattenedFallbackRatio: totalNodes === 0 ? 0 : flattened / denom,
    unexplainedAreaRatio: 0,
    warnings: [],
  };
}
