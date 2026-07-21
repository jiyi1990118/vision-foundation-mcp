import { describe, it, expect } from 'vitest';
import type { EvidenceCandidate } from '../../src/ui-analysis/evidence/types.js';
import { buildCompositionGraph } from '../../src/ui-analysis/composition/index.js';

describe('CompositionGraph', () => {
  it('builds contains edges by bbox containment', () => {
    const candidates: EvidenceCandidate[] = [
      { id: 'card', type: 'card', bbox: { x: 0, y: 0, w: 200, h: 200 }, score: 0.9, sources: ['cv'] },
      { id: 'title', type: 'text', bbox: { x: 10, y: 10, w: 100, h: 20 }, score: 0.95, sources: ['ocr'], text: '标题' },
      { id: 'icon', type: 'icon', bbox: { x: 150, y: 10, w: 30, h: 30 }, score: 0.8, sources: ['cv'] },
    ];
    const graph = buildCompositionGraph(candidates);
    expect(graph.edges).toContainEqual({ from: 'card', to: 'title', type: 'contains' });
    expect(graph.edges).toContainEqual({ from: 'card', to: 'icon', type: 'contains' });
  });

  it('does not create contains edge for non-containing siblings', () => {
    const candidates: EvidenceCandidate[] = [
      { id: 'a', type: 'text', bbox: { x: 0, y: 0, w: 50, h: 20 }, score: 0.9, sources: ['ocr'], text: 'A' },
      { id: 'b', type: 'text', bbox: { x: 60, y: 0, w: 50, h: 20 }, score: 0.9, sources: ['ocr'], text: 'B' },
    ];
    const graph = buildCompositionGraph(candidates);
    expect(graph.edges).not.toContainEqual({ from: 'a', to: 'b', type: 'contains' });
  });
});
