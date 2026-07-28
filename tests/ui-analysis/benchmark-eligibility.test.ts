import { describe, expect, it } from 'vitest';
import { isBenchmarkEligible, isSidecarFile } from '../../src/ui-analysis/benchmark/annotation-loader.js';
import type { AnnotationFile } from '../../src/ui-analysis/benchmark/annotation-loader.js';

const DRAFT_WARNING = 'pipeline-generated draft annotation - not human verified';

function annotation(warnings: string[] = []): AnnotationFile {
  return {
    image: 'screen.png',
    imageSize: { width: 100, height: 100 },
    platform: 'app', theme: 'light', language: 'en', dpi: 'standard',
    elements: [{ id: 'page', type: 'page', bbox: { x: 0, y: 0, w: 100, h: 100 }, render: 'native' }],
    relations: [], zOrder: [], warnings,
  };
}

describe('isSidecarFile', () => {
  it('excludes prediction, review, ai-review, session, and bak files', () => {
    expect(isSidecarFile('screen.json.prediction.json')).toBe(true);
    expect(isSidecarFile('screen.json.review.json')).toBe(true);
    expect(isSidecarFile('screen.json.ai-review.json')).toBe(true);
    expect(isSidecarFile('screen.json.session.json')).toBe(true);
    expect(isSidecarFile('screen.json.bak')).toBe(true);
  });

  it('admits regular annotation files', () => {
    expect(isSidecarFile('screen.json')).toBe(false);
  });
});

describe('isBenchmarkEligible', () => {
  it('rejects draft annotations', () => {
    const result = isBenchmarkEligible(annotation([DRAFT_WARNING]));
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain('draft');
  });

  it('admits reviewed annotations without draft warning', () => {
    const result = isBenchmarkEligible(annotation(['human-reviewed: local-workbench']));
    expect(result.eligible).toBe(true);
  });
});
