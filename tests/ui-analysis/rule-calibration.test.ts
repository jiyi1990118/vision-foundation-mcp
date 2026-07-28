import { describe, expect, it } from 'vitest';
import {
  calibrateStructureRules,
  aggregateCalibration,
  type RuleCalibrationCounts,
} from '../../src/ui-analysis/annotation-workbench/calibration.js';
import {
  normalizeAnnotationTree,
  analyzeAnnotationStructure,
  findingSignature,
  type StructureIssue,
} from '../../src/ui-analysis/annotation-workbench/tree.js';
import type { AnnotationFile } from '../../src/ui-analysis/benchmark/annotation-loader.js';
import type { ReviewSession, ReviewAction } from '../../src/ui-analysis/annotation-workbench/review-types.js';

function annotation(): AnnotationFile {
  return {
    image: 'screen.png', imageSize: { width: 100, height: 100 }, platform: 'app', theme: 'light', language: 'en', dpi: 'standard',
    elements: [
      { id: 'page', type: 'page', bbox: { x: 0, y: 0, w: 100, h: 100 }, render: 'native' },
      { id: 'card', type: 'card', bbox: { x: 10, y: 10, w: 80, h: 70 }, render: 'native' },
      { id: 'text', type: 'text', bbox: { x: 20, y: 20, w: 30, h: 10 }, render: 'native', text: 'Hello' },
      { id: 'icon', type: 'icon', bbox: { x: 55, y: 20, w: 12, h: 12 }, render: 'native' },
      { id: 'row-a', type: 'row', bbox: { x: 10, y: 82, w: 70, h: 8 }, render: 'native' },
      { id: 'row-b', type: 'row', bbox: { x: 10, y: 91, w: 45, h: 5 }, render: 'native' },
      { id: 'orphan-text', type: 'text', bbox: { x: 101, y: 5, w: 10, h: 5 }, render: 'native', text: 'Outside' },
    ], relations: [], zOrder: [], warnings: [],
  };
}

function action(subjectId: string, actionType: ReviewAction['action'], signature?: string): ReviewAction {
  return {
    id: `a-${subjectId}`,
    subjectKind: 'structure-finding',
    subjectId,
    action: actionType,
    signature,
    createdAt: '2026-07-28T00:00:00.000Z',
  };
}

describe('calibrateStructureRules', () => {
  it('counts raised findings per rule with no review session', () => {
    const ann = normalizeAnnotationTree(annotation());
    const result = calibrateStructureRules(ann, { actions: [] });

    const isolated = result.find((r) => r.code === 'isolated-content')!;
    expect(isolated.raised).toBeGreaterThan(0);
    expect(isolated.confirmed).toBe(0);
    expect(isolated.suppressed).toBe(0);
    expect(isolated.unreviewed).toBe(isolated.raised);
  });

  it('counts confirmed and suppressed findings against review actions', () => {
    const ann = normalizeAnnotationTree(annotation());
    const findings = runFindings(ann);
    const isolated = findings.filter((f) => f.code === 'isolated-content');
    const sibling = findings.filter((f) => f.code === 'sibling-size-inconsistent');

    const session: ReviewSession = {
      actions: [
        action(`isolated-content:${isolated[0]!.elementId}`, 'confirmed', sig(isolated[0]!)),
        action(`sibling-size-inconsistent:${sibling[0]!.elementId}`, 'suppressed', sig(sibling[0]!)),
      ],
    };

    const result = calibrateStructureRules(ann, session);
    const isolatedResult = result.find((r) => r.code === 'isolated-content')!;
    expect(isolatedResult.confirmed).toBe(1);
    expect(isolatedResult.unreviewed).toBe(isolatedResult.raised - 1);

    const siblingResult = result.find((r) => r.code === 'sibling-size-inconsistent')!;
    expect(siblingResult.suppressed).toBe(1);
    expect(siblingResult.unreviewed).toBe(siblingResult.raised - 1);
  });

  it('treats overridden as a true positive (rule caught a real issue)', () => {
    const ann = normalizeAnnotationTree(annotation());
    const findings = runFindings(ann);
    const isolated = findings.filter((f) => f.code === 'isolated-content');

    const session: ReviewSession = {
      actions: [
        action(`isolated-content:${isolated[0]!.elementId}`, 'overridden', sig(isolated[0]!)),
      ],
    };

    const result = calibrateStructureRules(ann, session);
    const isolatedResult = result.find((r) => r.code === 'isolated-content')!;
    expect(isolatedResult.overridden).toBe(1);
    expect(isolatedResult.confirmed).toBe(0);
  });

  it('ignores stale review actions whose signature no longer matches', () => {
    const ann = normalizeAnnotationTree(annotation());
    const findings = runFindings(ann);
    const isolated = findings.filter((f) => f.code === 'isolated-content');

    const session: ReviewSession = {
      actions: [
        action(`isolated-content:${isolated[0]!.elementId}`, 'confirmed', 'stale-signature'),
      ],
    };

    const result = calibrateStructureRules(ann, session);
    const isolatedResult = result.find((r) => r.code === 'isolated-content')!;
    expect(isolatedResult.confirmed).toBe(0);
    expect(isolatedResult.unreviewed).toBe(isolatedResult.raised);
  });
});

describe('aggregateCalibration', () => {
  it('computes precision as confirmed+overridden over reviewed findings', () => {
    const counts: RuleCalibrationCounts[] = [
      { code: 'isolated-content', version: 1, raised: 10, confirmed: 4, overridden: 2, suppressed: 3, rejected: 1, unreviewed: 0 },
    ];
    const result = aggregateCalibration(counts);
    expect(result['isolated-content']!.precision).toBeCloseTo(6 / 10, 3);
    expect(result['isolated-content']!.reviewed).toBe(10);
  });

  it('marks rules with no reviewed findings as uncalibrated', () => {
    const counts: RuleCalibrationCounts[] = [
      { code: 'sibling-size-inconsistent', version: 1, raised: 50, confirmed: 0, overridden: 0, suppressed: 0, rejected: 0, unreviewed: 50 },
    ];
    const result = aggregateCalibration(counts);
    expect(result['sibling-size-inconsistent']!.calibrated).toBe(false);
    expect(result['sibling-size-inconsistent']!.precision).toBe(0);
  });

  it('marks rules below threshold as advisory-only', () => {
    const counts: RuleCalibrationCounts[] = [
      { code: 'isolated-content', version: 1, raised: 10, confirmed: 2, overridden: 0, suppressed: 6, rejected: 2, unreviewed: 0 },
    ];
    const result = aggregateCalibration(counts, { precisionThreshold: 0.5 });
    expect(result['isolated-content']!.calibrated).toBe(true);
    expect(result['isolated-content']!.advisoryOnly).toBe(true);
    expect(result['isolated-content']!.precision).toBeCloseTo(0.2, 3);
  });

  it('marks high-precision rules as non-advisory', () => {
    const counts: RuleCalibrationCounts[] = [
      { code: 'child-outside-parent', version: 1, raised: 10, confirmed: 8, overridden: 1, suppressed: 1, rejected: 0, unreviewed: 0 },
    ];
    const result = aggregateCalibration(counts, { precisionThreshold: 0.5 });
    expect(result['child-outside-parent']!.calibrated).toBe(true);
    expect(result['child-outside-parent']!.advisoryOnly).toBe(false);
    expect(result['child-outside-parent']!.precision).toBeCloseTo(0.9, 3);
  });
});

function runFindings(ann: AnnotationFile): StructureIssue[] {
  return analyzeAnnotationStructure(ann);
}

function sig(finding: StructureIssue): string {
  return findingSignature(finding);
}
