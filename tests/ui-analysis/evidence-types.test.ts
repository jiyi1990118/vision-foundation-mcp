import { describe, it, expect } from 'vitest';
import type { EvidenceCandidate, EvidenceIR, EvidenceSource } from '../../src/ui-analysis/evidence/types.js';
import { buildEvidenceIR } from '../../src/ui-analysis/evidence/index.js';

describe('EvidenceIR', () => {
  it('builds EvidenceIR from candidates with normalized coords', () => {
    const candidates: EvidenceCandidate[] = [
      {
        id: 'c1',
        type: 'button',
        bbox: { x: 10, y: 20, w: 100, h: 40 },
        score: 0.9,
        sources: ['cv'],
      },
      {
        id: 'c2',
        type: 'text',
        bbox: { x: 15, y: 30, w: 90, h: 20 },
        score: 0.95,
        sources: ['ocr'],
        text: '登录',
      },
    ];
    const ir = buildEvidenceIR(candidates);
    expect(ir.candidates).toHaveLength(2);
    expect(ir.candidates[0]!.id).toBe('c1');
    expect(ir.candidates[1]!.text).toBe('登录');
  });

  it('filters candidates with invalid bbox', () => {
    const candidates: EvidenceCandidate[] = [
      { id: 'c1', type: 'button', bbox: { x: 0, y: 0, w: 0, h: 0 }, score: 0.9, sources: ['cv'] },
      { id: 'c2', type: 'button', bbox: { x: 10, y: 20, w: 100, h: 40 }, score: 0.9, sources: ['cv'] },
    ];
    const ir = buildEvidenceIR(candidates);
    expect(ir.candidates).toHaveLength(1);
    expect(ir.candidates[0]!.id).toBe('c2');
  });
});
