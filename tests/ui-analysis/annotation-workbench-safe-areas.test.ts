import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const appUrl = new URL('../../src/ui-analysis/annotation-workbench/static/app.js', import.meta.url);
const htmlUrl = new URL('../../src/ui-analysis/annotation-workbench/static/index.html', import.meta.url);
const cssUrl = new URL('../../src/ui-analysis/annotation-workbench/static/fixes.css', import.meta.url);

describe('device safe-area overlays (Phase E)', () => {
  it('defines a SAFE_AREAS constant mapping device keys to insets', async () => {
    const js = await readFile(appUrl, 'utf8');
    expect(js).toContain('SAFE_AREAS');
    expect(js).toContain("'390x844'");
    expect(js).toContain('top:');
    expect(js).toContain('bottom:');
  });

  it('defines a renderSafeAreas function', async () => {
    const js = await readFile(appUrl, 'utf8');
    expect(js).toContain('function renderSafeAreas(');
  });

  it('renders safe-area overlay rectangles with class safe-area', async () => {
    const js = await readFile(appUrl, 'utf8');
    expect(js).toContain("'safe-area'");
  });

  it('renders safe-area labels', async () => {
    const js = await readFile(appUrl, 'utf8');
    expect(js).toContain('safe-area-label');
  });

  it('calls renderSafeAreas inside renderCanvas for non-original device', async () => {
    const js = await readFile(appUrl, 'utf8');
    expect(js).toContain('renderSafeAreas(');
  });
});

describe('custom device preset (Phase E)', () => {
  it('includes a custom option in the device-preview select', async () => {
    const html = await readFile(htmlUrl, 'utf8');
    expect(html).toContain('value="custom"');
  });

  it('handles custom device input with a prompt for dimensions', async () => {
    const js = await readFile(appUrl, 'utf8');
    expect(js).toContain("'custom'");
    expect(js).toContain('customDevice');
  });

  it('stores customDevice in state', async () => {
    const js = await readFile(appUrl, 'utf8');
    expect(js).toContain('customDevice');
  });
});

describe('safe-area CSS (Phase E)', () => {
  it('styles safe-area overlay rectangles', async () => {
    const css = await readFile(cssUrl, 'utf8');
    expect(css).toContain('.safe-area');
  });

  it('styles safe-area labels', async () => {
    const css = await readFile(cssUrl, 'utf8');
    expect(css).toContain('.safe-area-label');
  });
});
