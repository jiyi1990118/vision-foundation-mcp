import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const appUrl = new URL('../../src/ui-analysis/annotation-workbench/static/app.js', import.meta.url);
const htmlUrl = new URL('../../src/ui-analysis/annotation-workbench/static/index.html', import.meta.url);

describe('workbench copy/paste wiring', () => {
  it('imports createPastedElement from the clipboard module', async () => {
    const js = await readFile(appUrl, 'utf8');
    expect(js).toContain("import{createPastedElement}from'./clipboard.js'");
  });

  it('adds clipboard and pasteCount to state', async () => {
    const js = await readFile(appUrl, 'utf8');
    expect(js).toContain('clipboard:null');
    expect(js).toContain('pasteCount:0');
  });

  it('defines copyElement and pasteElement functions', async () => {
    const js = await readFile(appUrl, 'utf8');
    expect(js).toContain('function copyElement()');
    expect(js).toContain('function pasteElement()');
  });

  it('guards shortcuts against editable controls', async () => {
    const js = await readFile(appUrl, 'utf8');
    expect(js).toMatch(/['"]INPUT['"]|['"]TEXTAREA['"]|['"]SELECT['"]/);
  });

  it('adds copy and paste buttons to the inspector', async () => {
    const html = await readFile(htmlUrl, 'utf8');
    expect(html).toContain('id="copy-element"');
    expect(html).toContain('id="paste-element"');
  });
});
