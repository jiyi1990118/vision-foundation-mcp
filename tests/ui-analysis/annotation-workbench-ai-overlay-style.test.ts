import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const fixesPath = new URL('../../src/ui-analysis/annotation-workbench/static/fixes.css', import.meta.url);

describe('annotation workbench AI overlay', () => {
  it('keeps AI suggestion boxes transparent', async () => {
    const source = await readFile(fixesPath, 'utf8');
    const rule = source.match(/\.box\.ai\s*\{[^}]*\}/)?.[0] ?? '';

    expect(rule).toContain('fill: transparent;');
    expect(rule).not.toContain('#7A5BC70D');
  });
});
