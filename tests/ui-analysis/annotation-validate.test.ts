import { describe, expect, it } from 'vitest';
import { validateAnnotation } from '../../src/ui-analysis/annotation-workbench/validate.js';
import type { AnnotationFile } from '../../src/ui-analysis/benchmark/annotation-loader.js';

function validAnnotation(): AnnotationFile {
  return {
    image: 'screen.png',
    imageSize: { width: 100, height: 200 },
    platform: 'app',
    theme: 'light',
    language: 'en',
    dpi: 'standard',
    elements: [
      { id: 'page', type: 'page', bbox: { x: 0, y: 0, w: 100, h: 200 }, render: 'native', children: ['card'] },
      { id: 'card', type: 'card', bbox: { x: 10, y: 10, w: 80, h: 70 }, render: 'native', children: ['text'] },
      { id: 'text', type: 'text', bbox: { x: 20, y: 20, w: 30, h: 10 }, render: 'native', text: 'Hi' },
    ],
    relations: [{ from: 'page', to: 'card', type: 'contains' }, { from: 'card', to: 'text', type: 'contains' }],
    zOrder: [],
    warnings: [],
  };
}

describe('validateAnnotation', () => {
  it('passes a valid annotation with consistent tree', () => {
    const result = validateAnnotation(validAnnotation());
    expect(result.errors).toEqual([]);
  });

  it('reports duplicate element IDs', () => {
    const input = validAnnotation();
    input.elements.push({ ...input.elements[1]!, id: 'card' });
    const result = validateAnnotation(input);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'duplicate-id', elementId: 'card' }),
    ]));
  });

  it('reports bbox outside image bounds', () => {
    const input = validAnnotation();
    input.elements[2]!.bbox = { x: 90, y: 190, w: 30, h: 20 };
    const result = validateAnnotation(input);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'bbox-out-of-bounds', elementId: 'text' }),
    ]));
  });

  it('reports a containment cycle', () => {
    const input = validAnnotation();
    input.elements[0]!.children = ['card'];
    input.elements[1]!.children = ['page'];
    input.relations = [
      { from: 'page', to: 'card', type: 'contains' },
      { from: 'card', to: 'page', type: 'contains' },
    ];
    const result = validateAnnotation(input);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'containment-cycle' }),
    ]));
  });

  it('reports children and contains mismatch', () => {
    const input = validAnnotation();
    input.elements[1]!.children = ['text', 'missing-child'];
    const result = validateAnnotation(input);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'child-not-in-contains', elementId: 'card', detail: 'missing-child' }),
    ]));
  });

  it('reports a relation referencing a missing element', () => {
    const input = validAnnotation();
    input.relations.push({ from: 'page', to: 'ghost', type: 'contains' });
    const result = validateAnnotation(input);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'relation-endpoint-missing', detail: 'ghost' }),
    ]));
  });

  it('reports multiple page roots', () => {
    const input = validAnnotation();
    input.elements.push({ id: 'page2', type: 'page', bbox: { x: 0, y: 0, w: 50, h: 50 }, render: 'native' });
    const result = validateAnnotation(input);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'multiple-page-roots' }),
    ]));
  });

  it('reports a child with two containment parents', () => {
    const input = validAnnotation();
    input.elements.push({ id: 'wrapper', type: 'container', bbox: { x: 5, y: 5, w: 90, h: 90 }, render: 'native' });
    input.relations.push({ from: 'wrapper', to: 'text', type: 'contains' });
    const result = validateAnnotation(input);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'multiple-parents', elementId: 'text' }),
    ]));
  });
});
