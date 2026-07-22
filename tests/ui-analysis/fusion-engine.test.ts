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
});
