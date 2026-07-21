import { describe, it, expect } from 'vitest';
import type { AssetItem, QualityReport, NodeConfidence, RenderMode } from '../../src/ui-analysis/policy/types.js';
import { computeQualityReport } from '../../src/ui-analysis/policy/index.js';

describe('Policy types', () => {
  it('computes quality report from node render modes', () => {
    const nodes = [
      { id: 'n1', render: { mode: 'native' as RenderMode } },
      { id: 'n2', render: { mode: 'native' as RenderMode } },
      { id: 'n3', render: { mode: 'asset' as RenderMode } },
      { id: 'n4', render: { mode: 'semantic-only' as RenderMode } },
    ];
    const report = computeQualityReport(nodes, 4);
    expect(report.editableElementRatio).toBe(0.5);
    expect(report.flattenedFallbackRatio).toBe(0.25);
  });

  it('handles empty input', () => {
    const report = computeQualityReport([], 0);
    expect(report.editableElementRatio).toBe(0);
    expect(report.criticalElementCoverage).toBe(0);
  });

  it('exposes expected policy type surface', () => {
    const item: AssetItem = {
      id: 'a1',
      kind: 'icon',
      bbox: { x: 0, y: 0, w: 10, h: 10 },
      mimeType: 'image/png',
      uri: 'file:///tmp/a.png',
      sha256: 'deadbeef',
      confidence: 0.9,
    };
    const conf: NodeConfidence = { overall: 0.8, type: 0.7, bounds: 0.6 };
    const report: QualityReport = {
      criticalElementCoverage: 0,
      editableElementRatio: 0,
      flattenedFallbackRatio: 0,
      unexplainedAreaRatio: 0,
      warnings: [],
    };
    expect(item.kind).toBe('icon');
    expect(conf.overall).toBe(0.8);
    expect(report.warnings).toHaveLength(0);
  });
});
