import { describe, expect, it } from 'vitest';
import { analyzeAnnotationStructure, buildContainmentCandidates, normalizeAnnotationTree, bboxHash, findingSubjectId, findingSignature, STRUCTURE_RULES } from '../../src/ui-analysis/annotation-workbench/tree.js';
import type { AnnotationFile } from '../../src/ui-analysis/benchmark/annotation-loader.js';

function annotation(): AnnotationFile {
  return {
    image: 'screen.png', imageSize: { width: 100, height: 100 }, platform: 'app', theme: 'light', language: 'en', dpi: 'standard',
    elements: [
      { id: 'page', type: 'page', bbox: { x: 0, y: 0, w: 100, h: 100 }, render: 'native' },
      { id: 'card', type: 'card', bbox: { x: 10, y: 10, w: 80, h: 70 }, render: 'native' },
      { id: 'text', type: 'text', bbox: { x: 20, y: 20, w: 30, h: 10 }, render: 'native', text: 'Hello' },
      { id: 'icon', type: 'icon', bbox: { x: 55, y: 20, w: 12, h: 12 }, render: 'native' },
    ], relations: [], zOrder: [], warnings: [],
  };
}

describe('normalizeAnnotationTree', () => {
  it('assigns each contained element to its smallest containing parent', () => {
    const result = normalizeAnnotationTree(annotation());

    expect(result.elements.find((element) => element.id === 'page')?.children).toEqual(['card']);
    expect(result.elements.find((element) => element.id === 'card')?.children).toEqual(['icon', 'text']);
    expect(result.elements.find((element) => element.id === 'text')?.children).toBeUndefined();
  });

  it('adds containment relations and removes stale children after editing', () => {
    const input = annotation();
    input.elements[1]!.children = ['text', 'missing'];
    input.relations = [{ from: 'page', to: 'text', type: 'contains' }];

    const result = normalizeAnnotationTree(input);

    expect(result.relations).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: 'page', to: 'card', type: 'contains' }),
      expect.objectContaining({ from: 'card', to: 'text', type: 'contains' }),
    ]));
    expect(result.relations).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ from: 'page', to: 'text', type: 'contains' }),
    ]));
  });

  it('preserves human-confirmed containment and marks derived relations', () => {
    const input = annotation();
    input.relations = [{ from: 'page', to: 'text', type: 'contains', source: 'human', reviewStatus: 'confirmed' }];

    const result = normalizeAnnotationTree(input);

    const pageToText = result.relations.find((r) => r.from === 'page' && r.to === 'text');
    expect(pageToText?.source).toBe('human');
    expect(pageToText?.reviewStatus).toBe('confirmed');

    const derivedCardToIcon = result.relations.find((r) => r.from === 'card' && r.to === 'icon');
    expect(derivedCardToIcon?.source).toBe('derived');
  });

  it('does not override human parent with a smaller geometric candidate', () => {
    const input = annotation();
    input.relations = [{ from: 'page', to: 'text', type: 'contains', source: 'human', reviewStatus: 'confirmed' }];

    const result = normalizeAnnotationTree(input);

    const textParents = result.relations.filter((r) => r.type === 'contains' && r.to === 'text');
    expect(textParents.map((r) => r.from)).toEqual(['page']);
  });
});

describe('buildContainmentCandidates', () => {
  it('returns candidate parents without modifying the annotation', () => {
    const input = annotation();
    const candidates = buildContainmentCandidates(input);

    expect(candidates.get('text')).toBe('card');
    expect(candidates.get('icon')).toBe('card');
    expect(candidates.get('page')).toBeUndefined();
  });
});

describe('analyzeAnnotationStructure', () => {
  it('reports isolated content directly under page and inconsistent sibling rows', () => {
    const input = annotation();
    input.elements.push(
      { id: 'row-a', type: 'row', bbox: { x: 10, y: 82, w: 70, h: 8 }, render: 'native' },
      { id: 'row-b', type: 'row', bbox: { x: 10, y: 91, w: 45, h: 5 }, render: 'native' },
      { id: 'floating-text', type: 'text', bbox: { x: 5, y: 85, w: 20, h: 10 }, render: 'native', text: 'Floating' },
    );

    const issues = analyzeAnnotationStructure(normalizeAnnotationTree(input));

    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'isolated-content', elementId: 'floating-text' }),
      expect.objectContaining({ code: 'sibling-size-inconsistent', elementId: 'row-b' }),
    ]));
  });

  it('reports same-type siblings whose bbox overlap exceeds threshold', () => {
    const input = annotation();
    input.elements.push(
      { id: 'button-a', type: 'button', bbox: { x: 20, y: 40, w: 30, h: 24 }, render: 'native' },
      { id: 'button-b', type: 'button', bbox: { x: 22, y: 42, w: 30, h: 18 }, render: 'native' },
    );

    const issues = analyzeAnnotationStructure(normalizeAnnotationTree(input));

    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'sibling-overlap', elementId: 'button-b', parentId: 'card' }),
    ]));
  });
});

describe('STRUCTURE_RULES registry', () => {
  it('registers exactly three rules with version and confidence', () => {
    const codes = STRUCTURE_RULES.map((rule) => rule.code);
    expect(codes).toEqual(['isolated-content', 'sibling-overlap', 'sibling-size-inconsistent']);
    for (const rule of STRUCTURE_RULES) {
      expect(rule.version).toBeGreaterThanOrEqual(1);
      expect(rule.confidence).toBeGreaterThan(0);
      expect(rule.confidence).toBeLessThanOrEqual(1);
      expect(rule.description.length).toBeGreaterThan(0);
      expect(typeof rule.advisoryOnly).toBe('boolean');
    }
  });

  it('marks uncalibrated rules advisory-only and calibrated rules enforced', () => {
    for (const rule of STRUCTURE_RULES) {
      if (rule.code === 'sibling-size-inconsistent') {
        expect(rule.advisoryOnly).toBe(false);
      } else {
        expect(rule.advisoryOnly).toBe(true);
      }
    }
  });
});

describe('finding signature helpers', () => {
  it('bboxHash rounds and joins bbox values', () => {
    expect(bboxHash({ x: 10.4, y: 20.6, w: 30.1, h: 40.9 })).toBe('10,21,30,41');
  });

  it('findingSubjectId is stable across bbox changes', () => {
    const base = { code: 'isolated-content', elementId: 'text', version: 2, severity: 'medium', confidence: 0.7, message: '', bboxHash: '10,20,30,10', type: 'text' } as const;
    const moved = { ...base, bboxHash: '50,60,30,10' };
    expect(findingSubjectId(base)).toBe(findingSubjectId(moved));
  });

  it('findingSignature changes when bbox or type changes', () => {
    const base = { code: 'isolated-content', elementId: 'text', version: 2, severity: 'medium', confidence: 0.7, message: '', bboxHash: '10,20,30,10', type: 'text' } as const;
    const moved = { ...base, bboxHash: '50,60,30,10' };
    const retyped = { ...base, type: 'button' };
    expect(findingSignature(base)).not.toBe(findingSignature(moved));
    expect(findingSignature(base)).not.toBe(findingSignature(retyped));
  });

  it('findingSignature changes when rule version changes', () => {
    const v1 = { code: 'isolated-content', elementId: 'text', version: 1, severity: 'medium', confidence: 0.7, message: '', bboxHash: '10,20,30,10', type: 'text' } as const;
    const v2 = { ...v1, version: 2 };
    expect(findingSignature(v1)).not.toBe(findingSignature(v2));
  });

  it('analyzeAnnotationStructure populates version, confidence, bboxHash, type, and evidence', () => {
    const input = annotation();
    input.elements.push(
      { id: 'floating-text', type: 'text', bbox: { x: 5, y: 85, w: 20, h: 10 }, render: 'native', text: 'Floating' },
    );

    const issues = analyzeAnnotationStructure(normalizeAnnotationTree(input));
    const floating = issues.find((issue) => issue.code === 'isolated-content' && issue.elementId === 'floating-text');

    expect(floating).toBeDefined();
    expect(floating!.version).toBeGreaterThanOrEqual(1);
    expect(floating!.confidence).toBeGreaterThan(0);
    expect(floating!.bboxHash).toBe('5,85,20,10');
    expect(floating!.type).toBe('text');
    expect(floating!.evidence).toBeTruthy();
  });
});
