import { describe, expect, it } from 'vitest';
import { applyReviewAction, emptyReviewSession, reviewStatusFor, type ReviewAction } from '../../src/ui-analysis/annotation-workbench/review-types.js';

function action(subjectId: string, type: ReviewAction['action'], signature?: string): ReviewAction {
  return { id: `a-${subjectId}`, subjectKind: 'structure-finding', subjectId, action: type, createdAt: '2026-07-24T00:00:00Z', ...(signature ? { signature } : {}) };
}

describe('review session', () => {
  it('returns undefined status for an unreviewed subject', () => {
    expect(reviewStatusFor(emptyReviewSession(), 'structure-finding', 'f1')).toBeUndefined();
  });

  it('records and resolves a confirmed action', () => {
    const session = applyReviewAction(emptyReviewSession(), action('f1', 'confirmed'));
    expect(reviewStatusFor(session, 'structure-finding', 'f1')).toBe('confirmed');
  });

  it('replaces the previous action for the same subject', () => {
    const session = applyReviewAction(emptyReviewSession(), action('f1', 'confirmed'));
    const updated = applyReviewAction(session, action('f1', 'suppressed'));
    expect(reviewStatusFor(updated, 'structure-finding', 'f1')).toBe('suppressed');
    expect(updated.actions).toHaveLength(1);
  });
});

describe('signature staleness', () => {
  it('returns confirmed status when signature matches', () => {
    const sig = '1:isolated-content:text:10,20,30,10:text';
    const session = applyReviewAction(emptyReviewSession(), action('isolated-content:text', 'suppressed', sig));
    expect(reviewStatusFor(session, 'structure-finding', 'isolated-content:text', sig)).toBe('suppressed');
  });

  it('returns undefined when signature mismatches (element changed)', () => {
    const oldSig = '1:isolated-content:text:10,20,30,10:text';
    const newSig = '1:isolated-content:text:50,60,30,10:text';
    const session = applyReviewAction(emptyReviewSession(), action('isolated-content:text', 'suppressed', oldSig));
    expect(reviewStatusFor(session, 'structure-finding', 'isolated-content:text', newSig)).toBeUndefined();
  });

  it('returns undefined when rule version changes', () => {
    const oldSig = '1:isolated-content:text:10,20,30,10:text';
    const newSig = '2:isolated-content:text:10,20,30,10:text';
    const session = applyReviewAction(emptyReviewSession(), action('isolated-content:text', 'suppressed', oldSig));
    expect(reviewStatusFor(session, 'structure-finding', 'isolated-content:text', newSig)).toBeUndefined();
  });

  it('skips staleness check when action has no signature (backward compat)', () => {
    const session = applyReviewAction(emptyReviewSession(), action('f1', 'suppressed'));
    expect(reviewStatusFor(session, 'structure-finding', 'f1', 'any-signature')).toBe('suppressed');
  });

  it('skips staleness check when no signature is provided', () => {
    const sig = '1:isolated-content:text:10,20,30,10:text';
    const session = applyReviewAction(emptyReviewSession(), action('f1', 'suppressed', sig));
    expect(reviewStatusFor(session, 'structure-finding', 'f1')).toBe('suppressed');
  });
});
