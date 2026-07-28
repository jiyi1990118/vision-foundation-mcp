import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildManifest,
  exportDataset,
  type SampleManifest,
  type DatasetExport,
} from '../../src/ui-analysis/benchmark/manifest.js';
import type { AnnotationFile } from '../../src/ui-analysis/benchmark/annotation-loader.js';

const ANNOTATION: AnnotationFile = {
  image: 'screen.png',
  imageSize: { width: 100, height: 100 },
  platform: 'app', theme: 'light', language: 'en', dpi: 'standard',
  elements: [
    { id: 'page', type: 'page', bbox: { x: 0, y: 0, w: 100, h: 100 }, render: 'native' },
    { id: 'btn', type: 'button', bbox: { x: 10, y: 10, w: 50, h: 30 }, render: 'native', text: 'OK' },
  ],
  relations: [], zOrder: [], warnings: ['human-reviewed: local-workbench'],
};

const PREDICTION: AnnotationFile = {
  ...ANNOTATION,
  warnings: ['pipeline-generated draft annotation - not human verified'],
};

const AI_REVIEW = { source: 'smolvlm2', status: 'done', proposals: [] };
const SESSION = { actions: [{ id: 'a1', subjectKind: 'structure-finding', subjectId: 'isolated-content:btn', action: 'confirmed', createdAt: '2026-07-28T00:00:00.000Z' }] };

describe('buildManifest', () => {
  let dir: string;

  beforeEach(() => {
    dir = join(tmpdir(), `manifest-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('computes sha256 hashes for image, annotation, prediction, ai-review, and session', () => {
    writeFileSync(join(dir, 'screen.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(join(dir, 'screen.json'), JSON.stringify(ANNOTATION));
    writeFileSync(join(dir, 'screen.json.prediction.json'), JSON.stringify(PREDICTION));
    writeFileSync(join(dir, 'screen.json.ai-review.json'), JSON.stringify(AI_REVIEW));
    writeFileSync(join(dir, 'screen.json.session.json'), JSON.stringify(SESSION));

    const manifest = buildManifest(dir, 'screen.json');

    expect(manifest.sampleId).toBe('screen');
    expect(manifest.imageHash).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.annotationHash).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.predictionHash).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.aiReviewHash).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.reviewActionsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.reviewed).toBe(true);
    expect(manifest.split).toBeNull();
  });

  it('marks unreviewed annotations with reviewed=false', () => {
    writeFileSync(join(dir, 'screen.png'), Buffer.alloc(4));
    writeFileSync(join(dir, 'screen.json'), JSON.stringify({ ...ANNOTATION, warnings: ['pipeline-generated draft annotation - not human verified'] }));

    const manifest = buildManifest(dir, 'screen.json');
    expect(manifest.reviewed).toBe(false);
  });

  it('omits ai-review and session hashes when sidecars are absent', () => {
    writeFileSync(join(dir, 'screen.png'), Buffer.alloc(4));
    writeFileSync(join(dir, 'screen.json'), JSON.stringify(ANNOTATION));

    const manifest = buildManifest(dir, 'screen.json');
    expect(manifest.aiReviewHash).toBeNull();
    expect(manifest.reviewActionsHash).toBeNull();
  });

  it('changes annotation hash when content changes', () => {
    writeFileSync(join(dir, 'screen.png'), Buffer.alloc(4));
    writeFileSync(join(dir, 'screen.json'), JSON.stringify(ANNOTATION));
    const m1 = buildManifest(dir, 'screen.json');

    writeFileSync(join(dir, 'screen.json'), JSON.stringify({ ...ANNOTATION, language: 'en' }));
    const m2 = buildManifest(dir, 'screen.json');

    // same content (language already 'en') -> same hash
    expect(m2.annotationHash).toBe(m1.annotationHash);

    writeFileSync(join(dir, 'screen.json'), JSON.stringify({ ...ANNOTATION, language: 'zh' }));
    const m3 = buildManifest(dir, 'screen.json');
    expect(m3.annotationHash).not.toBe(m1.annotationHash);
  });
});

describe('exportDataset', () => {
  let dir: string;

  beforeEach(() => {
    dir = join(tmpdir(), `export-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('exports each sample with separated human-final, prediction, ai-review, review-actions, and manifest fields', () => {
    writeFileSync(join(dir, 'screen.png'), Buffer.from([0x89, 0x50]));
    writeFileSync(join(dir, 'screen.json'), JSON.stringify(ANNOTATION));
    writeFileSync(join(dir, 'screen.json.prediction.json'), JSON.stringify(PREDICTION));
    writeFileSync(join(dir, 'screen.json.ai-review.json'), JSON.stringify(AI_REVIEW));
    writeFileSync(join(dir, 'screen.json.session.json'), JSON.stringify(SESSION));

    const exported = exportDataset(dir);

    expect(exported).toHaveLength(1);
    const sample = exported[0]!;
    expect(sample.sampleId).toBe('screen');
    expect(sample.humanFinal).toEqual(ANNOTATION);
    expect(sample.pipelinePrediction).toEqual(PREDICTION);
    expect(sample.aiPreReview).toEqual(AI_REVIEW);
    expect(sample.reviewActions).toEqual(SESSION);
    expect(sample.manifest.imageHash).toMatch(/^[0-9a-f]{64}$/);
    expect(sample.manifest.reviewed).toBe(true);
  });

  it('only exports reviewed samples (excludes drafts)', () => {
    writeFileSync(join(dir, 'reviewed.png'), Buffer.alloc(2));
    writeFileSync(join(dir, 'reviewed.json'), JSON.stringify({ ...ANNOTATION, image: 'reviewed.png' }));
    writeFileSync(join(dir, 'draft.png'), Buffer.alloc(2));
    writeFileSync(join(dir, 'draft.json'), JSON.stringify({ ...ANNOTATION, image: 'draft.png', warnings: ['pipeline-generated draft annotation - not human verified'] }));

    const exported = exportDataset(dir);
    expect(exported).toHaveLength(1);
    expect(exported[0]!.sampleId).toBe('reviewed');
  });

  it('produces stable hashes across two export calls (traceability)', () => {
    writeFileSync(join(dir, 'screen.png'), Buffer.from([0x01, 0x02]));
    writeFileSync(join(dir, 'screen.json'), JSON.stringify(ANNOTATION));
    writeFileSync(join(dir, 'screen.json.prediction.json'), JSON.stringify(PREDICTION));

    const e1 = exportDataset(dir)[0]!;
    const e2 = exportDataset(dir)[0]!;
    expect(e2.manifest.annotationHash).toBe(e1.manifest.annotationHash);
    expect(e2.manifest.predictionHash).toBe(e1.manifest.predictionHash);
    expect(e2.manifest.imageHash).toBe(e1.manifest.imageHash);
  });
});
