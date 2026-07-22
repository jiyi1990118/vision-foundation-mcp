import { describe, it, expect } from 'vitest';
import { runBenchmark, extractPredictionsFromAst } from '../../src/ui-analysis/benchmark/runner.js';
import type { ASTNode } from '../../src/ui-analysis/ir/types.js';

describe('extractPredictionsFromAst', () => {
  it('flattens AST nodes into predicted items', () => {
    const root: ASTNode = {
      id: 'page', type: 'page', bbox: { x: 0, y: 0, w: 375, h: 800 }, props: {},
      children: [
        { id: 'b1', type: 'button', bbox: { x: 10, y: 10, w: 100, h: 40 }, props: {}, text: 'OK', children: [] },
        { id: 't1', type: 'text', bbox: { x: 10, y: 60, w: 80, h: 20 }, props: {}, text: 'Hello', children: [] },
      ],
    };
    const preds = extractPredictionsFromAst(root);
    expect(preds).toHaveLength(2);
    expect(preds[0]!.type).toBe('button');
    expect(preds[1]!.type).toBe('text');
    // page node itself should be excluded
    expect(preds.find((p) => p.type === 'page')).toBeUndefined();
  });
});

describe('runBenchmark (no-annotation mode)', () => {
  it('produces a coverage report without ground truth', async () => {
    const result = await runBenchmark({
      images: [],
      mode: 'no-annotation',
      imageWidth: 375,
      imageHeight: 812,
    });
    expect(result.mode).toBe('no-annotation');
    expect(result.summary).toBeDefined();
    expect(result.images).toHaveLength(0);
  });
});

describe('runBenchmark (annotated mode)', () => {
  it('computes metrics when annotations provided', async () => {
    const fakeAnnotation = {
      image: 'test.png',
      imageSize: { width: 200, height: 200 },
      elements: [
        { id: 'e1', type: 'button', bbox: { x: 10, y: 10, w: 80, h: 30 } },
        { id: 'e2', type: 'text', bbox: { x: 10, y: 50, w: 60, h: 20 } },
      ],
    };
    const fakePredictions = [
      { id: 'p1', type: 'button', bbox: { x: 12, y: 11, w: 78, h: 28 } },
      { id: 'p2', type: 'text', bbox: { x: 11, y: 51, w: 59, h: 19 } },
    ];
    const result = await runBenchmark({
      images: [{
        image: 'test.png',
        imageWidth: 200,
        imageHeight: 200,
        annotations: fakeAnnotation,
        predictions: fakePredictions,
      }],
      mode: 'annotated',
      imageWidth: 200,
      imageHeight: 200,
    });
    expect(result.mode).toBe('annotated');
    expect(result.images).toHaveLength(1);
    expect(result.images[0]!.metrics).toBeDefined();
    expect(result.images[0]!.metrics.recall).toBe(1.0);
    expect(result.images[0]!.metrics.f1).toBe(1.0);
    expect(result.summary).toBeDefined();
    expect(result.summary.meanRecall).toBe(1.0);
  });
});
