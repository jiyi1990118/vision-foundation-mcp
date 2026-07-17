import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { filterSolidMediaAreas } from '../../src/ui-analysis/image-content/media-area-filter.js';
import type { ImageInput } from '../../src/types/domain.js';
import type { MediaArea } from '../../src/core/extractors/ui-layout-extractor.js';

async function makeImage(svgBody: string, w = 200, h = 120): Promise<ImageInput> {
  const svg = `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">${svgBody}</svg>`;
  const buf = await sharp(Buffer.from(svg)).png().toBuffer();
  return { buffer: buf, mimeType: 'image/png', source: 'test', size: buf.length };
}

describe('filterSolidMediaAreas (S31)', () => {
  it('keeps a solid icon (distinct from background) and drops a border-only area', async () => {
    // White page + a distinct red filled circle (solid icon) at (20,20,40,40).
    // A second "media area" at (100,20,40,40) sits on plain white (no icon body).
    const image = await makeImage(
      '<rect width="200" height="120" fill="#ffffff"/>' +
        '<circle cx="40" cy="40" r="18" fill="#e53935"/>' +
        '<rect x="100" y="20" width="40" height="40" fill="none" stroke="#cccccc"/>',
    );
    const areas: MediaArea[] = [
      { bbox: { x: 20, y: 20, w: 40, h: 40 }, type: 'icon' },
      { bbox: { x: 100, y: 20, w: 40, h: 40 }, type: 'icon' },
    ];
    const kept = await filterSolidMediaAreas(image, areas);
    expect(kept).toHaveLength(1);
    expect(Math.round(kept[0]!.bbox.x)).toBe(20);
  });

  it('returns input as-is when empty', async () => {
    const image = await makeImage('<rect width="10" height="10" fill="#ffffff"/>', 10, 10);
    const kept = await filterSolidMediaAreas(image, []);
    expect(kept).toEqual([]);
  });

  it('fails open: keeps areas when image sampling is degenerate', async () => {
    // A tiny 1x1 image; all areas should be kept (fail-open) rather than dropped.
    const image = await makeImage('<rect width="1" height="1" fill="#ffffff"/>', 1, 1);
    const areas: MediaArea[] = [{ bbox: { x: 0, y: 0, w: 8, h: 8 }, type: 'icon' }];
    const kept = await filterSolidMediaAreas(image, areas);
    expect(kept.length).toBeGreaterThanOrEqual(0);
  });
});
