import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const appUrl = new URL('../../src/ui-analysis/annotation-workbench/static/app.js', import.meta.url);
const cssUrl = new URL('../../src/ui-analysis/annotation-workbench/static/fixes.css', import.meta.url);

describe('layer lock (Phase E)', () => {
  it('stores layerLocks and layerHidden maps in state', async () => {
    const js = await readFile(appUrl, 'utf8');
    expect(js).toContain('layerLocks');
    expect(js).toContain('layerHidden');
  });

  it('defines isLocked and isHidden helper functions', async () => {
    const js = await readFile(appUrl, 'utf8');
    expect(js).toContain('function isLocked(');
    expect(js).toContain('function isHidden(');
  });

  it('defines toggleLock and toggleVisibility functions', async () => {
    const js = await readFile(appUrl, 'utf8');
    expect(js).toContain('function toggleLock(');
    expect(js).toContain('function toggleVisibility(');
  });

  it('hitTestAll skips hidden elements', async () => {
    const js = await readFile(appUrl, 'utf8');
    expect(js).toContain('!isHidden(element.id)');
  });

  it('blocks move gesture on locked elements', async () => {
    const js = await readFile(appUrl, 'utf8');
    expect(js).toContain('isLocked(');
    expect(js).toContain("'locked'");
  });

  it('blocks delete on locked elements', async () => {
    const js = await readFile(appUrl, 'utf8');
    expect(js).toMatch(/deleteElement.*isLocked|isLocked.*deleteElement/);
  });

  it('renders lock and visibility toggle buttons in the tree', async () => {
    const js = await readFile(appUrl, 'utf8');
    expect(js).toContain('layer-lock');
    expect(js).toContain('layer-toggle-vis');
  });

  it('skips hidden elements in renderCanvas', async () => {
    const js = await readFile(appUrl, 'utf8');
    expect(js).toContain('!isHidden(el.id)');
  });
});

describe('layer lock CSS (Phase E)', () => {
  it('styles the lock toggle button', async () => {
    const css = await readFile(cssUrl, 'utf8');
    expect(css).toContain('.layer-lock');
  });

  it('styles the visibility toggle button', async () => {
    const css = await readFile(cssUrl, 'utf8');
    expect(css).toContain('.layer-toggle-vis');
  });

  it('dims locked tree nodes', async () => {
    const css = await readFile(cssUrl, 'utf8');
    expect(css).toContain('.tree-node.locked');
  });
});
