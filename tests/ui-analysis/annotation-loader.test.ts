import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SemanticAST, ASTNode } from '../../src/ui-analysis/ir/types.js';
import {
  loadAnnotation,
  loadDataset,
  loadDatasetWithExclusions,
  annotationToGroundTruth,
} from '../../src/ui-analysis/benchmark/annotation-loader.js';
import { astToPredictions } from '../../src/ui-analysis/benchmark/ast-to-predictions.js';
import { computeMetrics } from '../../src/ui-analysis/benchmark/metrics.js';

const SAMPLE_ANNOTATION = {
  image: 'screenshot_001.png',
  imageSize: { width: 375, height: 812 },
  platform: 'app',
  theme: 'light',
  language: 'zh',
  dpi: 'high',
  elements: [
    { id: 'e1', type: 'section', bbox: { x: 0, y: 0, w: 375, h: 120 }, render: 'hybrid', children: ['e2'] },
    { id: 'e2', type: 'button', bbox: { x: 10, y: 10, w: 100, h: 36 }, render: 'native', text: 'Click' },
    { id: 'e3', type: 'image', bbox: { x: 10, y: 60, w: 80, h: 80 }, render: 'asset' },
  ],
  relations: [{ from: 'e1', to: 'e2', type: 'contains' }],
  zOrder: [{ id: 'e1', z: 0 }],
  warnings: [],
};

function makeAst(): SemanticAST {
  const button: ASTNode = {
    id: 'n1', type: 'button', bbox: { x: 10, y: 10, w: 100, h: 36 },
    props: { render: { mode: 'native' } }, children: [],
  };
  const image: ASTNode = {
    id: 'n2', type: 'image', bbox: { x: 10, y: 60, w: 80, h: 80 },
    props: { render: { mode: 'asset' } }, children: [],
  };
  const semantic: ASTNode = {
    id: 'n3', type: 'text', bbox: { x: 200, y: 200, w: 50, h: 20 },
    props: { render: { mode: 'semantic-only' } }, children: [],
  };
  const root: ASTNode = {
    id: 'root', type: 'page', bbox: { x: 0, y: 0, w: 375, h: 812 },
    props: {}, children: [button, image, semantic],
  };
  return { root };
}

describe('annotation-loader', () => {
  it('loadAnnotation parses a valid annotation file', () => {
    const dir = join(tmpdir(), `anno-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'test.json');
    writeFileSync(file, JSON.stringify(SAMPLE_ANNOTATION));
    try {
      const ann = loadAnnotation(file);
      expect(ann.image).toBe('screenshot_001.png');
      expect(ann.imageSize.width).toBe(375);
      expect(ann.platform).toBe('app');
      expect(ann.elements).toHaveLength(3);
      expect(ann.elements[0].id).toBe('e1');
      expect(ann.relations).toHaveLength(1);
      expect(ann.warnings).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loadAnnotation throws on missing required field', () => {
    const dir = join(tmpdir(), `anno-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'bad.json');
    const bad = { ...SAMPLE_ANNOTATION } as Record<string, unknown>;
    delete bad.platform;
    writeFileSync(file, JSON.stringify(bad));
    try {
      expect(() => loadAnnotation(file)).toThrow('platform');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loadDataset scans directory and pairs annotations with images', () => {
    const dir = join(tmpdir(), `ds-test-${Date.now()}`);
    const appDir = join(dir, 'app');
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(appDir, 'screenshot_001.json'), JSON.stringify(SAMPLE_ANNOTATION));
    writeFileSync(join(appDir, 'screenshot_001.png'), Buffer.alloc(8));
    try {
      const entries = loadDataset(dir);
      expect(entries).toHaveLength(1);
      expect(entries[0].annotation.image).toBe('screenshot_001.png');
      expect(existsSync(entries[0].imagePath)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loadDataset skips annotations without matching images', () => {
    const dir = join(tmpdir(), `ds-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'orphan.json'), JSON.stringify(SAMPLE_ANNOTATION));
    try {
      const entries = loadDataset(dir);
      expect(entries).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loadDatasetWithExclusions counts invalid annotations without aborting the scan', () => {
    const dir = join(tmpdir(), `ds-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'valid.json'), JSON.stringify(SAMPLE_ANNOTATION));
    writeFileSync(join(dir, 'screenshot_001.png'), Buffer.alloc(8));
    writeFileSync(join(dir, 'invalid.json'), JSON.stringify({ ...SAMPLE_ANNOTATION, imageSize: { width: 'bad', height: 812 } }));
    try {
      const result = loadDatasetWithExclusions(dir);
      expect(result.entries).toHaveLength(1);
      expect(result.excluded).toContainEqual({ file: 'invalid.json', reason: 'invalid: annotation imageSize must have numeric width and height' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('annotationToGroundTruth extracts id/type/bbox', () => {
    const gt = annotationToGroundTruth(SAMPLE_ANNOTATION as never);
    expect(gt).toHaveLength(3);
    expect(gt[0]).toEqual({ id: 'e1', type: 'section', bbox: { x: 0, y: 0, w: 375, h: 120 } });
  });
});

describe('ast-to-predictions', () => {
  it('converts AST nodes to predictions, filtering semantic-only', () => {
    const ast = makeAst();
    const preds = astToPredictions(ast);
    expect(preds).toHaveLength(2);
    expect(preds[0].type).toBe('button');
    expect(preds[1].type).toBe('image');
  });

  it('excludes page root node', () => {
    const ast = makeAst();
    const preds = astToPredictions(ast);
    expect(preds.find((p) => p.type === 'page')).toBeUndefined();
  });

  it('converts a reconstruction tree when wrapped as a SemanticAST root', () => {
    const reconstruction = { tree: makeAst().root };
    const preds = astToPredictions({ root: reconstruction.tree });
    expect(preds).toHaveLength(2);
  });
});

describe('end-to-end benchmark matching', () => {
  it('computes metrics from annotation + AST predictions', () => {
    const gt = annotationToGroundTruth(SAMPLE_ANNOTATION as never);
    const ast = makeAst();
    const preds = astToPredictions(ast);
    const metrics = computeMetrics(gt, preds, {
      iouThreshold: 0.5,
      imageWidth: 375,
      imageHeight: 812,
    });
    // button and image match perfectly; section does not (no matching pred)
    expect(metrics.matchedCount).toBe(2);
    expect(metrics.gtCount).toBe(3);
    expect(metrics.predCount).toBe(2);
    expect(metrics.recall).toBeCloseTo(2 / 3, 3);
    expect(metrics.precision).toBe(1);
  });
});
