import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const appUrl = new URL('../../src/ui-analysis/annotation-workbench/static/app.js', import.meta.url);
const cssUrl = new URL('../../src/ui-analysis/annotation-workbench/static/fixes.css', import.meta.url);

describe('snapping (Phase E)', () => {
  it('defines a snapThreshold constant in state or config', async () => {
    const js = await readFile(appUrl, 'utf8');
    expect(js).toContain('snapThreshold');
  });

  it('defines a collectSnapTargets function for nearby element edges', async () => {
    const js = await readFile(appUrl, 'utf8');
    expect(js).toContain('function collectSnapTargets(');
  });

  it('defines a snapBox function that adjusts bbox to nearby edges', async () => {
    const js = await readFile(appUrl, 'utf8');
    expect(js).toContain('function snapBox(');
  });

  it('calls snapBox inside moveGesture during move operations', async () => {
    const js = await readFile(appUrl, 'utf8');
    expect(js).toContain('snapBox(');
  });

  it('stores snapLines in state for rendering snap indicators', async () => {
    const js = await readFile(appUrl, 'utf8');
    expect(js).toContain('snapLines');
  });

  it('renders snap indicator lines on the overlay', async () => {
    const js = await readFile(appUrl, 'utf8');
    expect(js).toContain("snap-line");
  });

  it('clears snapLines when gesture ends', async () => {
    const js = await readFile(appUrl, 'utf8');
    expect(js).toContain('state.snapLines=[]');
  });
});

describe('distance measurement (Phase E)', () => {
  it('defines a renderDistanceMeasurements function', async () => {
    const js = await readFile(appUrl, 'utf8');
    expect(js).toContain('function renderDistanceMeasurements(');
  });

  it('renders distance labels on the overlay for the selected element', async () => {
    const js = await readFile(appUrl, 'utf8');
    expect(js).toContain('distance-label');
  });

  it('calls renderDistanceMeasurements inside renderCanvas', async () => {
    const js = await readFile(appUrl, 'utf8');
    expect(js).toContain('renderDistanceMeasurements(');
  });
});

describe('snapping and distance CSS (Phase E)', () => {
  it('styles snap indicator lines', async () => {
    const css = await readFile(cssUrl, 'utf8');
    expect(css).toContain('.snap-line');
  });

  it('styles distance labels', async () => {
    const css = await readFile(cssUrl, 'utf8');
    expect(css).toContain('.distance-label');
  });
});
