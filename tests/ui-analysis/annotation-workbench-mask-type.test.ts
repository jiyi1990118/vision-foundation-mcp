import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const appUrl = new URL('../../src/ui-analysis/annotation-workbench/static/app.js', import.meta.url);
const cssUrl = new URL('../../src/ui-analysis/annotation-workbench/static/fixes.css', import.meta.url);

describe('workbench mask (scrim) element type', () => {
  it('registers the mask type name', async () => {
    const js = await readFile(appUrl, 'utf8');
    expect(js).toContain("mask:'遮盖层'");
  });

  it('gives mask a dark scrim color', async () => {
    const js = await readFile(appUrl, 'utf8');
    expect(js).toContain("mask:'#334155'");
  });

  it('adds the element type as a box class so .box.mask applies', async () => {
    const js = await readFile(appUrl, 'utf8');
    expect(js).toContain('`${el.type} ${el.id===state.selectedId');
  });

  it('groups mask under the overlay (浮层) category', async () => {
    const js = await readFile(appUrl, 'utf8');
    expect(js).toContain("['dialog','drawer','bottomSheet','mask']");
  });

  it('styles mask as a semi-transparent dark scrim with purple dashed border', async () => {
    const css = await readFile(cssUrl, 'utf8');
    expect(css).toContain('.box.mask');
    expect(css).toContain('rgba(15, 23, 42, 0.35)');
    expect(css).toContain('#7A5BC7');
  });
});
