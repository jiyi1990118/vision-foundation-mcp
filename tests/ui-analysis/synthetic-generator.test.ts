import { describe, it, expect } from 'vitest';
import { generateSyntheticSample, generateSyntheticDataset } from '../../src/ui-analysis/benchmark/synthetic-generator.js';

describe('Synthetic generator', () => {
  it('generates a login page with known elements', () => {
    const sample = generateSyntheticSample('login', 375, 812);
    expect(sample.image).toBeDefined();
    expect(sample.image.buffer).toBeInstanceOf(Buffer);
    expect(sample.image.width).toBe(375);
    expect(sample.image.height).toBe(812);
    expect(sample.annotation.elements.length).toBeGreaterThan(3);
    // Should have a login button
    const button = sample.annotation.elements.find((e) => e.type === 'button');
    expect(button).toBeDefined();
    expect(button!.text).toBeTruthy();
  });

  it('generates a list page with repeated list items', () => {
    const sample = generateSyntheticSample('list', 375, 812);
    const listItems = sample.annotation.elements.filter((e) => e.type === 'listItem');
    expect(listItems.length).toBeGreaterThanOrEqual(3);
  });

  it('generates a form page with input and checkbox', () => {
    const sample = generateSyntheticSample('form', 375, 812);
    const inputs = sample.annotation.elements.filter((e) => e.type === 'input');
    expect(inputs.length).toBeGreaterThanOrEqual(1);
  });

  it('generates a banner page with title and button', () => {
    const sample = generateSyntheticSample('banner', 375, 812);
    const banner = sample.annotation.elements.find((e) => e.semanticRole === 'banner');
    expect(banner).toBeDefined();
    const titles = sample.annotation.elements.filter((e) => e.type === 'title');
    expect(titles.length).toBeGreaterThanOrEqual(1);
  });

  it('all bboxes are within image bounds', () => {
    const sample = generateSyntheticSample('login', 375, 812);
    for (const el of sample.annotation.elements) {
      expect(el.bbox.x).toBeGreaterThanOrEqual(0);
      expect(el.bbox.y).toBeGreaterThanOrEqual(0);
      expect(el.bbox.x + el.bbox.w).toBeLessThanOrEqual(375);
      expect(el.bbox.y + el.bbox.h).toBeLessThanOrEqual(812);
    }
  });

  it('generates a dataset of N samples', () => {
    const dataset = generateSyntheticDataset(10, 375, 812);
    expect(dataset.samples).toHaveLength(10);
    expect(dataset.samples[0]!.image).toBeDefined();
    expect(dataset.samples[0]!.annotation).toBeDefined();
  });
});
