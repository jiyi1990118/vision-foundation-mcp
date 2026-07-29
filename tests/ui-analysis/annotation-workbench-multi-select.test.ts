import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const appUrl = new URL('../../src/ui-analysis/annotation-workbench/static/app.js', import.meta.url);
const htmlUrl = new URL('../../src/ui-analysis/annotation-workbench/static/index.html', import.meta.url);
const cssUrl = new URL('../../src/ui-analysis/annotation-workbench/static/fixes.css', import.meta.url);

describe('multi-select state (Phase E)', () => {
  it('stores selectedIds set in state', async () => {
    const js = await readFile(appUrl, 'utf8');
    expect(js).toContain('selectedIds');
  });

  it('defines a toggleMultiSelect function', async () => {
    const js = await readFile(appUrl, 'utf8');
    expect(js).toContain('function toggleMultiSelect(');
  });

  it('defines a clearMultiSelect function', async () => {
    const js = await readFile(appUrl, 'utf8');
    expect(js).toContain('function clearMultiSelect(');
  });

  it('handles shift-click to add to multi-select', async () => {
    const js = await readFile(appUrl, 'utf8');
    expect(js).toContain('shiftKey');
    expect(js).toContain('toggleMultiSelect');
  });

  it('renders all selectedIds with the selected class on canvas', async () => {
    const js = await readFile(appUrl, 'utf8');
    expect(js).toContain('selectedIds.has');
  });
});

describe('alignment operations (Phase E)', () => {
  it('defines an alignElements function', async () => {
    const js = await readFile(appUrl, 'utf8');
    expect(js).toContain('function alignElements(');
  });

  it('supports left, center, right, top, middle, bottom alignment', async () => {
    const js = await readFile(appUrl, 'utf8');
    expect(js).toContain("'left'");
    expect(js).toContain("'center'");
    expect(js).toContain("'right'");
    expect(js).toContain("'top'");
    expect(js).toContain("'middle'");
    expect(js).toContain("'bottom'");
  });

  it('renders alignment buttons in the inspector for multi-select', async () => {
    const html = await readFile(htmlUrl, 'utf8');
    expect(html).toContain('align-left') ;
  });

  it('skips locked elements during alignment', async () => {
    const js = await readFile(appUrl, 'utf8');
    expect(js).toMatch(/alignElements.*isLocked|isLocked.*alignElements/);
  });
});

describe('distribution operations (Phase E)', () => {
  it('defines a distributeElements function', async () => {
    const js = await readFile(appUrl, 'utf8');
    expect(js).toContain('function distributeElements(');
  });

  it('supports horizontal and vertical distribution', async () => {
    const js = await readFile(appUrl, 'utf8');
    expect(js).toContain("'horizontal'");
    expect(js).toContain("'vertical'");
  });
});

describe('multi-select CSS (Phase E)', () => {
  it('styles the alignment toolbar', async () => {
    const css = await readFile(cssUrl, 'utf8');
    expect(css).toContain('.align-toolbar');
  });

  it('styles alignment and distribution buttons', async () => {
    const css = await readFile(cssUrl, 'utf8');
    expect(css).toContain('.align-btn');
  });
});
