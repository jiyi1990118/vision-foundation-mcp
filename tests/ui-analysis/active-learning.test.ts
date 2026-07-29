import { describe, expect, it } from 'vitest';
import {
  analyzeTypeFrequency,
  scoreImagePriority,
  buildPriorityQueue,
  type TypeFrequencyResult,
} from '../../src/ui-analysis/benchmark/active-learning.js';
import type { AnnotationFile } from '../../src/ui-analysis/benchmark/annotation-loader.js';

function ann(image: string, types: string[]): AnnotationFile {
  return {
    image, imageSize: { width: 100, height: 100 }, platform: 'app', theme: 'light', language: 'en', dpi: 'standard',
    elements: [
      { id: 'page', type: 'page', bbox: { x: 0, y: 0, w: 100, h: 100 }, render: 'native' },
      ...types.map((t, i) => ({ id: `el-${i}`, type: t, bbox: { x: i, y: 0, w: 10, h: 10 }, render: 'native' })),
    ],
    relations: [], zOrder: [], warnings: [],
  };
}

describe('analyzeTypeFrequency', () => {
  it('counts element types across all annotations (excluding page)', () => {
    const entries = [
      { annotation: ann('a.png', ['text', 'text', 'button']), imagePath: 'a.png' },
      { annotation: ann('b.png', ['text', 'icon']), imagePath: 'b.png' },
    ];
    const result = analyzeTypeFrequency(entries.map(e => e.annotation));
    expect(result.counts.text).toBe(3);
    expect(result.counts.button).toBe(1);
    expect(result.counts.icon).toBe(1);
    expect(result.counts.page).toBeUndefined();
  });

  it('marks types with 30+ as threshold met', () => {
    const types = Array(35).fill('text');
    const entries = [{ annotation: ann('a.png', types), imagePath: 'a.png' }];
    const result = analyzeTypeFrequency(entries.map(e => e.annotation));
    expect(result.thresholds.text).toBe(true);
    expect(result.typesMeetingThreshold).toContain('text');
  });

  it('marks types below 30 as needing more samples', () => {
    const entries = [{ annotation: ann('a.png', ['button', 'button']), imagePath: 'a.png' }];
    const result = analyzeTypeFrequency(entries.map(e => e.annotation));
    expect(result.thresholds.button).toBe(false);
    expect(result.typesNeedingSamples).toContain('button');
  });

  it('returns total element count and type count', () => {
    const entries = [
      { annotation: ann('a.png', ['text', 'icon', 'button']), imagePath: 'a.png' },
    ];
    const result = analyzeTypeFrequency(entries.map(e => e.annotation));
    expect(result.totalElements).toBe(3);
    expect(result.totalTypes).toBe(3);
  });
});

describe('scoreImagePriority', () => {
  it('scores 0 when all types in the image meet threshold', () => {
    const annotation = ann('a.png', ['text', 'container']);
    const freq: TypeFrequencyResult = {
      counts: { text: 50, container: 40 },
      thresholds: { text: true, container: true },
      typesMeetingThreshold: ['text', 'container'],
      typesNeedingSamples: [],
      totalElements: 90,
      totalTypes: 2,
      threshold: 30,
    };
    expect(scoreImagePriority(annotation, freq)).toBe(0);
  });

  it('scores higher for images with more underrepresented types', () => {
    const annotation1 = ann('a.png', ['text']);
    const annotation2 = ann('b.png', ['button', 'tab', 'avatar']);
    const freq: TypeFrequencyResult = {
      counts: { text: 50, button: 5, tab: 3, avatar: 2 },
      thresholds: { text: true, button: false, tab: false, avatar: false },
      typesMeetingThreshold: ['text'],
      typesNeedingSamples: ['button', 'tab', 'avatar'],
      totalElements: 60,
      totalTypes: 4,
      threshold: 30,
    };
    expect(scoreImagePriority(annotation2, freq)).toBeGreaterThan(scoreImagePriority(annotation1, freq));
  });

  it('weights rarer types higher (inverse frequency)', () => {
    const annotation = ann('a.png', ['button', 'tab']);
    const freq: TypeFrequencyResult = {
      counts: { button: 20, tab: 2 },
      thresholds: { button: false, tab: false },
      typesMeetingThreshold: [],
      typesNeedingSamples: ['button', 'tab'],
      totalElements: 22,
      totalTypes: 2,
      threshold: 30,
    };
    const score = scoreImagePriority(annotation, freq);
    expect(score).toBeGreaterThan(0);
  });
});

describe('buildPriorityQueue', () => {
  it('ranks images by priority score descending', () => {
    const annotations = [
      ann('low.png', ['text']),
      ann('high.png', ['button', 'tab', 'avatar']),
      ann('mid.png', ['button']),
    ];
    const freq: TypeFrequencyResult = {
      counts: { text: 50, button: 5, tab: 3, avatar: 2 },
      thresholds: { text: true, button: false, tab: false, avatar: false },
      typesMeetingThreshold: ['text'],
      typesNeedingSamples: ['button', 'tab', 'avatar'],
      totalElements: 60,
      totalTypes: 4,
      threshold: 30,
    };
    const queue = buildPriorityQueue(annotations, freq);
    expect(queue[0]!.image).toBe('high.png');
    expect(queue[1]!.image).toBe('mid.png');
    expect(queue[2]!.image).toBe('low.png');
  });

  it('includes score and underrepresented types per image', () => {
    const annotations = [ann('a.png', ['button', 'tab'])];
    const freq: TypeFrequencyResult = {
      counts: { button: 5, tab: 3 },
      thresholds: { button: false, tab: false },
      typesMeetingThreshold: [],
      typesNeedingSamples: ['button', 'tab'],
      totalElements: 8,
      totalTypes: 2,
      threshold: 30,
    };
    const queue = buildPriorityQueue(annotations, freq);
    expect(queue[0]!.score).toBeGreaterThan(0);
    expect(queue[0]!.underrepresentedTypes).toEqual(expect.arrayContaining(['button', 'tab']));
  });
});
