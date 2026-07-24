import { describe, expect, it } from 'vitest';
import { createPastedElement } from '../../src/ui-analysis/annotation-workbench/static/clipboard.js';

const source = { id: 'el-1', type: 'button', bbox: { x: 100, y: 200, w: 80, h: 32 }, render: 'native', text: '保存' };
const imageSize = { width: 1200, height: 2670 };

describe('createPastedElement', () => {
  it('copies type, text, render, and size with a new id', () => {
    const pasted = createPastedElement(source, 1, imageSize);
    expect(pasted.id).not.toBe(source.id);
    expect(pasted.type).toBe('button');
    expect(pasted.text).toBe('保存');
    expect(pasted.render).toBe('native');
    expect(pasted.bbox.w).toBe(80);
    expect(pasted.bbox.h).toBe(32);
  });

  it('offsets 12px right and down on first paste', () => {
    const pasted = createPastedElement(source, 1, imageSize);
    expect(pasted.bbox.x).toBe(112);
    expect(pasted.bbox.y).toBe(212);
  });

  it('accumulates offset across consecutive pastes', () => {
    const first = createPastedElement(source, 1, imageSize);
    const second = createPastedElement(source, 2, imageSize);
    expect(second.bbox.x).toBe(124);
    expect(second.bbox.y).toBe(224);
  });

  it('clamps to image bounds when offset exceeds width', () => {
    const edge = { ...source, bbox: { x: 1140, y: 200, w: 80, h: 32 } };
    const pasted = createPastedElement(edge, 1, imageSize);
    expect(pasted.bbox.x + pasted.bbox.w).toBeLessThanOrEqual(imageSize.width);
    expect(pasted.bbox.x).toBe(imageSize.width - 80);
  });

  it('clamps to image bounds when offset exceeds height', () => {
    const edge = { ...source, bbox: { x: 100, y: 2650, w: 80, h: 32 } };
    const pasted = createPastedElement(edge, 1, imageSize);
    expect(pasted.bbox.y + pasted.bbox.h).toBeLessThanOrEqual(imageSize.height);
    expect(pasted.bbox.y).toBe(imageSize.height - 32);
  });

  it('does not mutate the source element', () => {
    createPastedElement(source, 1, imageSize);
    expect(source.bbox.x).toBe(100);
    expect(source.bbox.y).toBe(200);
  });
});
