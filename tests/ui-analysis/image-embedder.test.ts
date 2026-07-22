import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { embedImageDataUrls } from '../../src/ui-analysis/image-content/index.js';
import type { ImageContentInfo } from '../../src/ui-analysis/image-content/index.js';
import type { ImageInput } from '../../src/types/domain.js';

async function makeSolidImage(r: number, g: number, b: number): Promise<ImageInput> {
  const buf = await sharp({
    create: { width: 200, height: 200, channels: 3, background: { r, g, b } },
  })
    .png()
    .toBuffer();
  return { buffer: buf, mimeType: 'image/png', source: 'test', size: buf.length };
}

function makeContent(
  index: number,
  type: ImageContentInfo['type'],
  bbox: { x: number; y: number; w: number; h: number },
): ImageContentInfo {
  return {
    index,
    type,
    bbox,
    crop: { ...bbox },
    altText: type === 'icon' ? '图标' : '图片',
  };
}

describe('image-embedder', () => {
  it('embeds a base64 data URL onto each in-bounds content in place', async () => {
    const image = await makeSolidImage(255, 255, 255);
    const contents: ImageContentInfo[] = [
      makeContent(0, 'icon', { x: 10, y: 10, w: 40, h: 40 }),
      makeContent(1, 'image', { x: 60, y: 60, w: 80, h: 80 }),
    ];

    await embedImageDataUrls(image, contents);

    expect(contents[0]!.dataUrl).toMatch(/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/);
    expect(contents[1]!.dataUrl).toMatch(/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/);
  });

  it('clamps out-of-bounds bbox without throwing', async () => {
    const image = await makeSolidImage(0, 0, 0);
    const contents: ImageContentInfo[] = [
      makeContent(0, 'icon', { x: 180, y: 180, w: 100, h: 100 }),
    ];

    await expect(embedImageDataUrls(image, contents)).resolves.toBeUndefined();
    expect(contents[0]!.dataUrl).toMatch(/^data:image\/png;base64,/);
  });

  it('uses the canonical clipped crop for a negative bbox', async () => {
    const image = await makeSolidImage(0, 0, 0);
    const contents: ImageContentInfo[] = [{
      ...makeContent(0, 'icon', { x: -5, y: -3, w: 40, h: 40 }),
      crop: { x: 0, y: 0, w: 35, h: 37 },
    }];
    await embedImageDataUrls(image, contents);
    const encoded = contents[0]!.dataUrl!.slice('data:image/png;base64,'.length);
    const metadata = await sharp(Buffer.from(encoded, 'base64')).metadata();
    expect({ width: metadata.width, height: metadata.height }).toEqual({ width: 35, height: 37 });
  });

  it('skips embedding entirely when maxBytes is too small for any crop', async () => {
    const image = await makeSolidImage(255, 255, 255);
    const contents: ImageContentInfo[] = [
      makeContent(0, 'icon', { x: 10, y: 10, w: 40, h: 40 }),
      makeContent(1, 'image', { x: 60, y: 60, w: 80, h: 80 }),
    ];

    await embedImageDataUrls(image, contents, { maxBytes: 10 });

    expect(contents[0]!.dataUrl).toBeUndefined();
    expect(contents[1]!.dataUrl).toBeUndefined();
  });
});
