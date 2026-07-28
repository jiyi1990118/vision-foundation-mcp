import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const appUrl = new URL('../../src/ui-analysis/annotation-workbench/static/app.js', import.meta.url);
const cssUrl = new URL('../../src/ui-analysis/annotation-workbench/static/fixes.css', import.meta.url);

describe('overlap chooser (Phase E)', () => {
  it('defines a hitTestAll function that returns all overlapping candidates', async () => {
    const js = await readFile(appUrl, 'utf8');
    expect(js).toContain('function hitTestAll(');
  });

  it('stores overlap candidates and chooser index in state', async () => {
    const js = await readFile(appUrl, 'utf8');
    expect(js).toContain('overlapCandidates');
    expect(js).toContain('overlapIndex');
  });

  it('shows an overlap chooser popup when multiple candidates are found', async () => {
    const js = await readFile(appUrl, 'utf8');
    expect(js).toContain('function showOverlapChooser(');
    expect(js).toContain('overlap-chooser');
  });

  it('cycles forward with Tab and backward with Shift+Tab', async () => {
    const js = await readFile(appUrl, 'utf8');
    expect(js).toContain('cycleOverlap');
    expect(js).toContain("'Tab'");
  });

  it('dismisses the chooser with Escape', async () => {
    const js = await readFile(appUrl, 'utf8');
    expect(js).toContain("'Escape'");
    expect(js).toContain('dismissOverlapChooser');
  });

  it('confirms selection with Enter', async () => {
    const js = await readFile(appUrl, 'utf8');
    expect(js).toContain("'Enter'");
    expect(js).toContain('confirmOverlap');
  });

  it('renders the chooser as an SVG overlay near the click point', async () => {
    const js = await readFile(appUrl, 'utf8');
    expect(js).toContain('overlap-chooser');
    expect(js).toContain('overlap-item');
  });
});

describe('overlap chooser CSS (Phase E)', () => {
  it('styles the overlap chooser popup', async () => {
    const css = await readFile(cssUrl, 'utf8');
    expect(css).toContain('.overlap-chooser');
  });

  it('styles individual overlap chooser items with hover state', async () => {
    const css = await readFile(cssUrl, 'utf8');
    expect(css).toContain('.overlap-item');
    expect(css).toContain(':hover');
  });

  it('highlights the active overlap item', async () => {
    const css = await readFile(cssUrl, 'utf8');
    expect(css).toContain('.overlap-item.active');
  });
});
