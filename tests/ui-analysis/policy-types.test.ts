import { describe, it, expect } from 'vitest';
import type { AssetItem, QualityReport, NodeConfidence, RenderMode } from '../../src/ui-analysis/policy/types.js';
import { computeQualityReport } from '../../src/ui-analysis/policy/index.js';
import {
  computeUnionArea,
  computeUnexplainedArea,
  computeCriticalElementCoverage,
  CRITICAL_ELEMENT_TYPES,
} from '../../src/ui-analysis/policy/quality-metrics.js';

describe('Policy types', () => {
  it('computes quality report from node render modes', () => {
    const nodes = [
      { id: 'n1', type: 'container', bbox: { x: 0, y: 0, w: 100, h: 50 }, render: { mode: 'native' as RenderMode } },
      { id: 'n2', type: 'container', bbox: { x: 0, y: 50, w: 100, h: 50 }, render: { mode: 'native' as RenderMode } },
      { id: 'n3', type: 'image', bbox: { x: 0, y: 100, w: 100, h: 50 }, render: { mode: 'asset' as RenderMode } },
      { id: 'n4', type: 'text', bbox: { x: 0, y: 150, w: 100, h: 50 }, render: { mode: 'semantic-only' as RenderMode } },
    ];
    const report = computeQualityReport({ nodes, totalNodes: 4, imageWidth: 100, imageHeight: 200 });
    expect(report.editableElementRatio).toBe(0.5);
    expect(report.flattenedFallbackRatio).toBe(0.25);
  });

  it('handles empty input', () => {
    const report = computeQualityReport({ nodes: [], totalNodes: 0 });
    expect(report.editableElementRatio).toBe(0);
    expect(report.criticalElementCoverage).toBe(1);
  });

  it('computes real unexplainedAreaRatio from bbox union', () => {
    const nodes = [
      { id: 'n1', type: 'container', bbox: { x: 0, y: 0, w: 50, h: 100 }, render: { mode: 'native' as RenderMode } },
    ];
    const report = computeQualityReport({ nodes, totalNodes: 1, imageWidth: 100, imageHeight: 100 });
    // Half the image is covered -> unexplained = 0.5
    expect(report.unexplainedAreaRatio).toBeCloseTo(0.5, 5);
  });

  it('emits warning when image dimensions are missing', () => {
    const report = computeQualityReport({ nodes: [], totalNodes: 0 });
    expect(report.unexplainedAreaRatio).toBe(0);
    expect(report.warnings).toContain('no-image-dimensions:unexplainedAreaRatio-set-to-zero');
  });

  it('computes criticalElementCoverage from evidence-backed critical nodes', () => {
    const nodes = [
      { id: 'b1', type: 'button', bbox: { x: 0, y: 0, w: 10, h: 10 }, render: { mode: 'native' as RenderMode }, evidence: [{ source: 'cv' }] },
      { id: 'b2', type: 'button', bbox: { x: 10, y: 0, w: 10, h: 10 }, render: { mode: 'native' as RenderMode } },
      { id: 'i1', type: 'input', bbox: { x: 20, y: 0, w: 10, h: 10 }, render: { mode: 'native' as RenderMode }, evidence: [{ source: 'ocr' }] },
      { id: 'c1', type: 'container', bbox: { x: 30, y: 0, w: 10, h: 10 }, render: { mode: 'native' as RenderMode } },
    ];
    const report = computeQualityReport({ nodes: nodes as never[], totalNodes: 4, imageWidth: 100, imageHeight: 100 });
    // 3 critical (2 buttons + 1 input), 2 with evidence -> 2/3
    expect(report.criticalElementCoverage).toBeCloseTo(2 / 3, 5);
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

describe('quality-metrics helpers', () => {
  it('computeUnionArea handles overlapping boxes', () => {
    const boxes = [
      { x: 0, y: 0, w: 100, h: 100 },
      { x: 50, y: 50, w: 100, h: 100 },
    ];
    // Union = 100*100 + 100*100 - 50*50 = 10000 + 10000 - 2500 = 17500
    expect(computeUnionArea(boxes)).toBe(17500);
  });

  it('computeUnexplainedArea returns 0 for full coverage', () => {
    const boxes = [{ x: 0, y: 0, w: 100, h: 100 }];
    expect(computeUnexplainedArea(boxes, 100, 100)).toBe(0);
  });

  it('computeCriticalElementCoverage returns 1 when no critical elements', () => {
    expect(computeCriticalElementCoverage([{ type: 'container', hasEvidence: false }])).toBe(1);
  });

  it('CRITICAL_ELEMENT_TYPES includes button/input/checkbox', () => {
    expect(CRITICAL_ELEMENT_TYPES.has('button')).toBe(true);
    expect(CRITICAL_ELEMENT_TYPES.has('input')).toBe(true);
    expect(CRITICAL_ELEMENT_TYPES.has('checkbox')).toBe(true);
    expect(CRITICAL_ELEMENT_TYPES.has('container')).toBe(false);
  });
});
