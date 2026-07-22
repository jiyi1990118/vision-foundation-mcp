import { describe, it, expect } from 'vitest';
import { DetectorHub } from '../../src/ui-analysis/evidence/detector-hub.js';
import type { EvidenceCandidate } from '../../src/ui-analysis/evidence/types.js';

const mockCandidates: EvidenceCandidate[] = [
  { id: 'cv1', type: 'button', bbox: { x: 0, y: 0, w: 100, h: 40 }, score: 0.9, sources: ['cv'] },
  { id: 'ocr1', type: 'text', bbox: { x: 10, y: 10, w: 80, h: 20 }, score: 0.95, sources: ['ocr'], text: '登录' },
];

describe('DetectorHub', () => {
  it('runs multiple detectors and collects results', async () => {
    const hub = new DetectorHub();
    hub.register('cv', async () => [mockCandidates[0]!]);
    hub.register('ocr', async () => [mockCandidates[1]!]);

    const results = await hub.runAll();
    expect(results).toHaveLength(2);
    expect(results.find((c) => c.sources.includes('cv'))).toBeDefined();
    expect(results.find((c) => c.sources.includes('ocr'))).toBeDefined();
  });

  it('continues when a detector fails', async () => {
    const hub = new DetectorHub();
    hub.register('cv', async () => [mockCandidates[0]!]);
    hub.register('broken', async () => { throw new Error('model not found'); });

    const results = await hub.runAll();
    expect(results).toHaveLength(1);
    expect(results[0]!.sources).toContain('cv');
  });

  it('respects timeout for slow detectors', async () => {
    const hub = new DetectorHub({ timeoutMs: 50 });
    hub.register('fast', async () => [mockCandidates[0]!]);
    hub.register('slow', async () => {
      await new Promise((r) => setTimeout(r, 200));
      return [mockCandidates[1]!];
    });

    const results = await hub.runAll();
    expect(results).toHaveLength(1);
    expect(results[0]!.sources).toContain('cv');
  });

  it('returns empty when no detectors registered', async () => {
    const hub = new DetectorHub();
    const results = await hub.runAll();
    expect(results).toHaveLength(0);
  });

  it('supports abort signal', async () => {
    const controller = new AbortController();
    const hub = new DetectorHub({ signal: controller.signal });
    hub.register('cv', async () => {
      await new Promise((r) => setTimeout(r, 100));
      return [mockCandidates[0]!];
    });

    controller.abort();
    const results = await hub.runAll();
    expect(results).toHaveLength(0);
  });
});
