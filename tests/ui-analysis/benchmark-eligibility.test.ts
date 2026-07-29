import { describe, expect, it } from 'vitest';
import {
  isBenchmarkEligible,
  isSidecarFile,
  hasOpenHighSeverityFindings,
} from '../../src/ui-analysis/benchmark/annotation-loader.js';
import type { AnnotationFile } from '../../src/ui-analysis/benchmark/annotation-loader.js';
import type { ReviewSession } from '../../src/ui-analysis/annotation-workbench/review-types.js';

const DRAFT_WARNING = 'pipeline-generated draft annotation - not human verified';
const REVIEWED_WARNING = 'human-reviewed: local-workbench';

function annotation(warnings: string[] = []): AnnotationFile {
  return {
    image: 'screen.png',
    imageSize: { width: 100, height: 100 },
    platform: 'app', theme: 'light', language: 'en', dpi: 'standard',
    elements: [{ id: 'page', type: 'page', bbox: { x: 0, y: 0, w: 100, h: 100 }, render: 'native' }],
    relations: [], zOrder: [], warnings,
  };
}

// A button mounted directly under the page root triggers the medium-severity
// `isolated-content` structure finding (subject id `isolated-content:btn`).
function annotationWithMediumFinding(): AnnotationFile {
  return {
    image: 'screen.png',
    imageSize: { width: 100, height: 100 },
    platform: 'app', theme: 'light', language: 'en', dpi: 'standard',
    elements: [
      { id: 'page', type: 'page', bbox: { x: 0, y: 0, w: 100, h: 100 }, render: 'native', children: ['btn'] },
      { id: 'btn', type: 'button', bbox: { x: 10, y: 10, w: 20, h: 10 }, render: 'native', text: 'OK' },
    ],
    relations: [{ from: 'page', to: 'btn', type: 'contains', source: 'human' }],
    zOrder: [], warnings: [REVIEWED_WARNING],
  };
}

const BTN_SIGNATURE = '2:isolated-content:btn:10,10,20,10:button';

function sessionWith(action: 'confirmed' | 'overridden' | 'suppressed'): ReviewSession {
  return {
    actions: [{
      id: 'a1',
      subjectKind: 'structure-finding',
      subjectId: 'isolated-content:btn',
      action,
      signature: BTN_SIGNATURE,
      createdAt: '2026-07-29T00:00:00.000Z',
    }],
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
    const result = isBenchmarkEligible(annotation([REVIEWED_WARNING]));
    expect(result.eligible).toBe(true);
  });

  it('admits annotations with no structure findings', () => {
    const result = isBenchmarkEligible(annotation([REVIEWED_WARNING]));
    expect(result.eligible).toBe(true);
    expect(hasOpenHighSeverityFindings(annotation([REVIEWED_WARNING]))).toBe(false);
  });

  it('rejects annotations with unreviewed medium-severity findings (no session)', () => {
    const ann = annotationWithMediumFinding();
    expect(hasOpenHighSeverityFindings(ann)).toBe(true);
    const result = isBenchmarkEligible(ann);
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('open-high-severity-findings');
  });

  it('rejects annotations with unreviewed medium-severity findings (empty session)', () => {
    const ann = annotationWithMediumFinding();
    expect(hasOpenHighSeverityFindings(ann, { actions: [] })).toBe(true);
    const result = isBenchmarkEligible(ann, { actions: [] });
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('open-high-severity-findings');
  });

  it('admits annotations when all medium findings are suppressed', () => {
    const ann = annotationWithMediumFinding();
    const session = sessionWith('suppressed');
    expect(hasOpenHighSeverityFindings(ann, session)).toBe(false);
    expect(isBenchmarkEligible(ann, session).eligible).toBe(true);
  });

  it('admits annotations when all medium findings are confirmed', () => {
    const ann = annotationWithMediumFinding();
    const session = sessionWith('confirmed');
    expect(hasOpenHighSeverityFindings(ann, session)).toBe(false);
    expect(isBenchmarkEligible(ann, session).eligible).toBe(true);
  });

  it('admits annotations when all medium findings are overridden', () => {
    const ann = annotationWithMediumFinding();
    const session = sessionWith('overridden');
    expect(hasOpenHighSeverityFindings(ann, session)).toBe(false);
    expect(isBenchmarkEligible(ann, session).eligible).toBe(true);
  });

  it('reopens a finding when the stored signature is stale (bbox changed)', () => {
    const ann = annotationWithMediumFinding();
    const staleSession: ReviewSession = {
      actions: [{
        id: 'a1',
        subjectKind: 'structure-finding',
        subjectId: 'isolated-content:btn',
        action: 'suppressed',
        signature: '2:isolated-content:btn:99,99,99,99:button',
        createdAt: '2026-07-29T00:00:00.000Z',
      }],
    };
    expect(hasOpenHighSeverityFindings(ann, staleSession)).toBe(true);
    expect(isBenchmarkEligible(ann, staleSession).eligible).toBe(false);
  });

  it('still rejects drafts even when findings would also be open', () => {
    const ann = annotationWithMediumFinding();
    ann.warnings = [DRAFT_WARNING];
    const result = isBenchmarkEligible(ann);
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain('draft');
  });
});
