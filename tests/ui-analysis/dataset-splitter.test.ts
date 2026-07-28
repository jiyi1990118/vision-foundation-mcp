import { describe, expect, it } from 'vitest';
import {
  assignSplits,
  defaultFamilyKey,
  verifyNoLeakage,
  type SplitAssignment,
} from '../../src/ui-analysis/benchmark/splitter.js';
import type { SampleManifest } from '../../src/ui-analysis/benchmark/manifest.js';

function manifest(sampleId: string, annotationFile: string): SampleManifest {
  return {
    sampleId,
    imageFile: `${sampleId}.png`,
    annotationFile,
    imageHash: 'hash',
    annotationHash: 'hash',
    predictionHash: null,
    aiReviewHash: null,
    reviewActionsHash: null,
    reviewed: true,
    split: null,
  };
}

describe('defaultFamilyKey', () => {
  it('groups screenshots by timestamp prefix (same minute)', () => {
    const m1 = manifest('screen_20260717191823_226', 'screen_20260717191823_226.json');
    const m2 = manifest('screen_20260717191825_227', 'screen_20260717191825_227.json');
    const m3 = manifest('screen_20260717191930_230', 'screen_20260717191930_230.json');
    expect(defaultFamilyKey(m1)).toBe(defaultFamilyKey(m2));
    expect(defaultFamilyKey(m1)).not.toBe(defaultFamilyKey(m3));
  });

  it('falls back to sampleId when no timestamp pattern is found', () => {
    const m = manifest('random-screenshot', 'random.json');
    const key = defaultFamilyKey(m);
    expect(key).toBeTruthy();
  });
});

describe('assignSplits', () => {
  it('assigns all samples in the same family to the same split', () => {
    const manifests = [
      manifest('a_20260717191823_1', 'a_20260717191823_1.json'),
      manifest('b_20260717191825_2', 'b_20260717191825_2.json'),
      manifest('c_20260717191930_3', 'c_20260717191930_3.json'),
      manifest('d_20260717191931_4', 'd_20260717191931_4.json'),
      manifest('e_20260717192000_5', 'e_20260717192000_5.json'),
      manifest('f_20260717192001_6', 'f_20260717192001_6.json'),
    ];

    const assignment = assignSplits(manifests, { seed: 42, ratios: { train: 0.6, validation: 0.2, test: 0.2 } });

    // family 1 (a, b) must be in the same split
    expect(assignment['a_20260717191823_1']).toBe(assignment['b_20260717191825_2']);
    // family 2 (c, d) must be in the same split
    expect(assignment['c_20260717191930_3']).toBe(assignment['d_20260717191931_4']);
    // family 3 (e, f) must be in the same split
    expect(assignment['e_20260717192000_5']).toBe(assignment['f_20260717192001_6']);
  });

  it('produces deterministic assignments with the same seed', () => {
    const manifests = [
      manifest('a_20260717191823_1', 'a_20260717191823_1.json'),
      manifest('b_20260717191930_2', 'b_20260717191930_2.json'),
      manifest('c_20260717192000_3', 'c_20260717192000_3.json'),
    ];

    const a1 = assignSplits(manifests, { seed: 42 });
    const a2 = assignSplits(manifests, { seed: 42 });
    expect(a1).toEqual(a2);
  });

  it('only assigns train/validation/test values', () => {
    const manifests = [
      manifest('a_20260717191823_1', 'a_20260717191823_1.json'),
      manifest('b_20260717191930_2', 'b_20260717191930_2.json'),
    ];

    const assignment = assignSplits(manifests, { seed: 1 });
    for (const split of Object.values(assignment)) {
      expect(['train', 'validation', 'test']).toContain(split);
    }
  });

  it('assigns all samples to train when there is only one family', () => {
    const manifests = [
      manifest('a_20260717191823_1', 'a_20260717191823_1.json'),
      manifest('b_20260717191825_2', 'b_20260717191825_2.json'),
    ];

    const assignment = assignSplits(manifests, { seed: 42 });
    expect(assignment['a_20260717191823_1']).toBe('train');
    expect(assignment['b_20260717191825_2']).toBe('train');
  });

  it('respects custom familyKey function', () => {
    const manifests = [
      manifest('x1', 'x1.json'),
      manifest('x2', 'x2.json'),
      manifest('y1', 'y1.json'),
      manifest('y2', 'y2.json'),
    ];

    const assignment = assignSplits(manifests, {
      seed: 42,
      familyKey: (m) => (m.sampleId.startsWith('x') ? 'X' : 'Y'),
      ratios: { train: 0.5, validation: 0.25, test: 0.25 },
    });

    expect(assignment['x1']).toBe(assignment['x2']);
    expect(assignment['y1']).toBe(assignment['y2']);
  });
});

describe('verifyNoLeakage', () => {
  it('passes when each family is entirely in one split', () => {
    const assignment: SplitAssignment = {
      s1: 'train', s2: 'train',
      s3: 'test', s4: 'test',
    };
    const manifests = [
      { ...manifest('s1', 's1.json'), split: 'train' },
      { ...manifest('s2', 's2.json'), split: 'train' },
      { ...manifest('s3', 's3.json'), split: 'test' },
      { ...manifest('s4', 's4.json'), split: 'test' },
    ];

    const result = verifyNoLeakage(manifests, assignment, (m) => m.sampleId.startsWith('s1') || m.sampleId.startsWith('s2') ? 'A' : 'B');
    expect(result.ok).toBe(true);
  });

  it('fails when a family spans multiple splits', () => {
    const assignment: SplitAssignment = {
      s1: 'train', s2: 'test',
    };
    const manifests = [
      { ...manifest('s1', 's1.json'), split: 'train' },
      { ...manifest('s2', 's2.json'), split: 'test' },
    ];

    const result = verifyNoLeakage(manifests, assignment, (m) => 'same-family');
    expect(result.ok).toBe(false);
    expect(result.leakedFamilies).toContain('same-family');
  });
});
