import { describe, it, expect } from 'vitest';
import { OnnxDetectorAdapter } from '../../src/ui-analysis/evidence/onnx-detector-adapter.js';

describe('OnnxDetectorAdapter', () => {
  it('returns empty and reports not-loaded when model path does not exist', async () => {
    const adapter = new OnnxDetectorAdapter({ modelPath: '/nonexistent/model.onnx' });
    await adapter.initialize();
    expect(adapter.isLoaded).toBe(false);
    const candidates = await adapter.detect({
      width: 100,
      height: 100,
      data: Buffer.alloc(0),
      stride: 4,
      mimeType: 'image/png',
      source: 'test',
      size: 0,
    } as unknown as never);
    expect(candidates).toHaveLength(0);
  });

  it('parses raw YOLO output into EvidenceCandidate[]', () => {
    const adapter = new OnnxDetectorAdapter({ modelPath: '/nonexistent/model.onnx' });
    // Row layout: [cx, cy, w, h, c0, c1, c2, c3, c4] (4 bbox + 5 class scores)
    const labels = ['button', 'input', 'card', 'checkbox', 'icon'];
    const rawOutput = new Float32Array([
      // detection 1: button, cx=0.1 cy=0.2 w=0.5 h=0.2, score 0.9
      0.1, 0.2, 0.5, 0.2, 0.9, 0.1, 0.05, 0.02, 0.01,
      // detection 2: icon, cx=0.75 cy=0.1 w=0.15 h=0.15, score 0.8
      0.75, 0.1, 0.15, 0.15, 0.05, 0.02, 0.1, 0.05, 0.8,
    ]);
    const candidates = adapter.parseOutput(rawOutput, labels, 200, 200);
    expect(candidates).toHaveLength(2);
    expect(candidates[0]!.type).toBe('button');
    expect(candidates[0]!.sources).toContain('ui-detector');
    expect(candidates[0]!.bbox.w).toBe(100);
    expect(candidates[1]!.type).toBe('icon');
  });

  it('filters low-confidence detections', () => {
    const adapter = new OnnxDetectorAdapter({ modelPath: '/nonexistent/model.onnx', confidenceThreshold: 0.5 });
    const labels = ['button'];
    const rawOutput = new Float32Array([
      0.5, 0.5, 0.2, 0.1, 0.9, // high score
      0.5, 0.5, 0.2, 0.1, 0.3, // low score - filtered
    ]);
    const candidates = adapter.parseOutput(rawOutput, labels, 100, 100);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.score).toBeCloseTo(0.9);
  });
});
