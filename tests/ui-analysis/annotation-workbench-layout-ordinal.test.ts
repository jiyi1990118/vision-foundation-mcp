import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const stylesUrl = new URL('../../src/ui-analysis/annotation-workbench/static/styles.css', import.meta.url);
const appUrl = new URL('../../src/ui-analysis/annotation-workbench/static/app.js', import.meta.url);

describe('workbench layout and screenshot ordinals', () => {
  it('uses the balanced 220/300 three-column grid', async () => {
    const css = await readFile(stylesUrl, 'utf8');
    expect(css).toContain('grid-template-columns:220px minmax(420px,1fr) 300px');
  });

  it('renders a two-digit ordinal before each screenshot filename', async () => {
    const js = await readFile(appUrl, 'utf8');
    expect(js).toContain("String(i+1).padStart(2,'0')");
  });
});
