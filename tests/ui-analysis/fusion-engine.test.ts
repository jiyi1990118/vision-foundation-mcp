import { describe, it, expect } from 'vitest';
import { fuseEvidence } from '../../src/ui-analysis/evidence/fusion-engine.js';
import type { EvidenceCandidate } from '../../src/ui-analysis/evidence/types.js';

describe('EvidenceFusionEngine', () => {
  it('NMS: suppresses lower-score duplicate of same type', () => {
    const candidates: EvidenceCandidate[] = [
      { id: 'a', type: 'button', bbox: { x: 10, y: 20, w: 100, h: 40 }, score: 0.9, sources: ['cv'] },
      { id: 'b', type: 'button', bbox: { x: 12, y: 22, w: 98, h: 38 }, score: 0.7, sources: ['ui-detector'] },
    ];
    const result = fuseEvidence(candidates, { iouThreshold: 0.5 });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.id).toBe('a');
    expect(result.candidates[0]!.sources).toContain('cv');
  });

  it('WBF: merges highly overlapping candidates from different sources', () => {
    const candidates: EvidenceCandidate[] = [
      { id: 'a', type: 'button', bbox: { x: 10, y: 20, w: 100, h: 40 }, score: 0.9, sources: ['cv'] },
      { id: 'b', type: 'button', bbox: { x: 12, y: 22, w: 98, h: 38 }, score: 0.85, sources: ['ui-detector'] },
    ];
    const result = fuseEvidence(candidates, { iouThreshold: 0.5, wbfThreshold: 0.7 });
    expect(result.candidates).toHaveLength(1);
    const merged = result.candidates[0]!;
    expect(merged.sources).toEqual(expect.arrayContaining(['cv', 'ui-detector']));
    // Merged score should be between the two
    expect(merged.score).toBeGreaterThanOrEqual(0.85);
    expect(merged.score).toBeLessThanOrEqual(0.9);
  });

  it('keeps non-overlapping candidates of different types', () => {
    const candidates: EvidenceCandidate[] = [
      { id: 'a', type: 'button', bbox: { x: 0, y: 0, w: 50, h: 30 }, score: 0.9, sources: ['cv'] },
      { id: 'b', type: 'text', bbox: { x: 0, y: 40, w: 50, h: 20 }, score: 0.8, sources: ['ocr'] },
    ];
    const result = fuseEvidence(candidates, { iouThreshold: 0.5 });
    expect(result.candidates).toHaveLength(2);
  });

  it('keeps overlapping candidates of different types (no cross-type suppression)', () => {
    const candidates: EvidenceCandidate[] = [
      { id: 'a', type: 'button', bbox: { x: 0, y: 0, w: 100, h: 50 }, score: 0.9, sources: ['cv'] },
      { id: 'b', type: 'text', bbox: { x: 5, y: 10, w: 90, h: 20 }, score: 0.8, sources: ['ocr'] },
    ];
    const result = fuseEvidence(candidates, { iouThreshold: 0.5 });
    expect(result.candidates).toHaveLength(2);
  });

  it('preserves text content from OCR candidates during merge', () => {
    const candidates: EvidenceCandidate[] = [
      { id: 'a', type: 'text', bbox: { x: 0, y: 0, w: 100, h: 20 }, score: 0.9, sources: ['cv'] },
      { id: 'b', type: 'text', bbox: { x: 2, y: 1, w: 98, h: 19 }, score: 0.95, sources: ['ocr'], text: '登录' },
    ];
    const result = fuseEvidence(candidates, { iouThreshold: 0.5, wbfThreshold: 0.7 });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.text).toBe('登录');
  });

  it('handles empty input', () => {
    const result = fuseEvidence([], { iouThreshold: 0.5 });
    expect(result.candidates).toHaveLength(0);
  });

  it('merges sourceVotes from different sources during WBF', () => {
    const candidates: EvidenceCandidate[] = [
      {
        id: 'a', type: 'button', bbox: { x: 10, y: 20, w: 100, h: 40 }, score: 0.9, sources: ['cv'],
        sourceVotes: [{ source: 'cv', score: 0.9, type: 'button' }],
      },
      {
        id: 'b', type: 'button', bbox: { x: 12, y: 22, w: 98, h: 38 }, score: 0.85, sources: ['ui-detector'],
        sourceVotes: [{ source: 'ui-detector', score: 0.85, type: 'button' }],
      },
    ];
    const result = fuseEvidence(candidates, { iouThreshold: 0.5, wbfThreshold: 0.7 });
    expect(result.candidates).toHaveLength(1);
    const votes = result.candidates[0]!.sourceVotes!;
    expect(votes).toHaveLength(2);
    const sources = votes.map((v) => v.source).sort();
    expect(sources).toEqual(['cv', 'ui-detector']);
  });

  it('deduplicates sourceVotes by source keeping highest score', () => {
    const candidates: EvidenceCandidate[] = [
      {
        id: 'a', type: 'button', bbox: { x: 10, y: 20, w: 100, h: 40 }, score: 0.9, sources: ['cv'],
        sourceVotes: [{ source: 'cv', score: 0.9, type: 'button' }],
      },
      {
        id: 'b', type: 'button', bbox: { x: 12, y: 22, w: 98, h: 38 }, score: 0.85, sources: ['cv', 'ui-detector'],
        sourceVotes: [
          { source: 'cv', score: 0.7, type: 'container' },
          { source: 'ui-detector', score: 0.85, type: 'button' },
        ],
      },
    ];
    const result = fuseEvidence(candidates, { iouThreshold: 0.5, wbfThreshold: 0.7 });
    const votes = result.candidates[0]!.sourceVotes!;
    const cvVote = votes.find((v) => v.source === 'cv');
    expect(cvVote!.score).toBe(0.9);
    expect(cvVote!.type).toBe('button');
    expect(votes).toHaveLength(2);
  });

  it('flags cross-type overlap with conflictReason', () => {
    const candidates: EvidenceCandidate[] = [
      { id: 'a', type: 'button', bbox: { x: 0, y: 0, w: 100, h: 50 }, score: 0.9, sources: ['cv'] },
      { id: 'b', type: 'input', bbox: { x: 5, y: 5, w: 95, h: 45 }, score: 0.8, sources: ['ui-detector'] },
    ];
    const result = fuseEvidence(candidates, { iouThreshold: 0.5 });
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0]!.conflictReason).toContain('cross-type-overlap');
    expect(result.candidates[1]!.conflictReason).toContain('cross-type-overlap');
  });

  it('does not flag conflict for non-overlapping different-type candidates', () => {
    const candidates: EvidenceCandidate[] = [
      { id: 'a', type: 'button', bbox: { x: 0, y: 0, w: 50, h: 30 }, score: 0.9, sources: ['cv'] },
      { id: 'b', type: 'input', bbox: { x: 100, y: 100, w: 50, h: 30 }, score: 0.8, sources: ['ui-detector'] },
    ];
    const result = fuseEvidence(candidates, { iouThreshold: 0.5 });
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0]!.conflictReason).toBeUndefined();
    expect(result.candidates[1]!.conflictReason).toBeUndefined();
  });
});
