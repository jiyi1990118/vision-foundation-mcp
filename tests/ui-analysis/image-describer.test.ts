import { describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { describeImageContents } from '../../src/ui-analysis/image-content/index.js';
import type { ImageContentInfo } from '../../src/ui-analysis/image-content/index.js';
import type { VisionProvider } from '../../src/providers/types.js';
import type { ImageInput, InferenceRequest, InferenceResponse } from '../../src/types/domain.js';

async function makeSolidImage(r: number, g: number, b: number): Promise<ImageInput> {
  const buf = await sharp({
    create: { width: 200, height: 200, channels: 3, background: { r, g, b } },
  })
    .png()
    .toBuffer();
  return { buffer: buf, mimeType: 'image/png', source: 'test', size: buf.length };
}

function makeContent(index: number, type: ImageContentInfo['type'], bbox: { x: number; y: number; w: number; h: number }): ImageContentInfo {
  return {
    index,
    type,
    bbox,
    crop: { ...bbox },
    altText: type === 'icon' ? '图标' : '图片',
  };
}

function makeMockProvider(inferImpl: (req: InferenceRequest) => Promise<InferenceResponse>) {
  return {
    name: 'mock',
    runtime: 'mock',
    supportedRuntimes: ['mock'],
    supportedSkills: ['classify', 'summary'],
    requirements: { minMemoryMB: 0, gpuRequired: false, modelSizeMB: 0 },
    isLoaded: () => true,
    load: vi.fn(async () => {}),
    unload: vi.fn(async () => {}),
    infer: vi.fn(inferImpl),
  };
}

describe('image-describer', () => {
  it('writes VLM descriptions onto each content in place', async () => {
    const image = await makeSolidImage(255, 255, 255);
    const contents: ImageContentInfo[] = [
      makeContent(0, 'icon', { x: 10, y: 10, w: 40, h: 40 }),
      makeContent(1, 'image', { x: 60, y: 60, w: 80, h: 80 }),
    ];
    const responses = ['蓝色搜索图标', '用户头像占位图'];
    const provider = makeMockProvider(async () => ({
      text: responses.shift() ?? '',
      duration: 0,
    }));

    await describeImageContents(provider as unknown as VisionProvider, image, contents);

    expect(contents[0]!.description).toBe('蓝色搜索图标');
    expect(contents[1]!.description).toBe('用户头像占位图');
    expect(provider.infer.mock.calls).toHaveLength(2);
    expect(provider.load).not.toHaveBeenCalled();
  });

  it('skips a region whose infer fails without breaking others', async () => {
    const image = await makeSolidImage(255, 255, 255);
    const contents: ImageContentInfo[] = [
      makeContent(0, 'icon', { x: 10, y: 10, w: 40, h: 40 }),
      makeContent(1, 'image', { x: 60, y: 60, w: 80, h: 80 }),
    ];
    const provider = makeMockProvider(async (req) => {
      if (req.image.source === 'crop:0') throw new Error('infer boom');
      return { text: '风景照片', duration: 0 };
    });

    await describeImageContents(provider as unknown as VisionProvider, image, contents);

    expect(contents[0]!.description).toBeUndefined();
    expect(contents[1]!.description).toBe('风景照片');
    expect(provider.infer.mock.calls).toHaveLength(2);
  });

  it('ignores empty VLM output', async () => {
    const image = await makeSolidImage(0, 0, 0);
    const contents: ImageContentInfo[] = [makeContent(0, 'icon', { x: 5, y: 5, w: 30, h: 30 })];
    const provider = makeMockProvider(async () => ({ text: '   ', duration: 0 }));

    await describeImageContents(provider as unknown as VisionProvider, image, contents);

    expect(contents[0]!.description).toBeUndefined();
  });

  it('respects maxItems to cap the number of infer calls', async () => {
    const image = await makeSolidImage(255, 255, 255);
    const contents: ImageContentInfo[] = Array.from({ length: 5 }, (_, i) =>
      makeContent(i, 'icon', { x: 10 + i * 30, y: 10, w: 20, h: 20 }),
    );
    const provider = makeMockProvider(async () => ({ text: '图标', duration: 0 }));

    await describeImageContents(provider as unknown as VisionProvider, image, contents, { maxItems: 2 });

    expect(provider.infer.mock.calls).toHaveLength(2);
    expect(contents[0]!.description).toBe('图标');
    expect(contents[1]!.description).toBe('图标');
    expect(contents[2]!.description).toBeUndefined();
  });

  it('loads the provider when not already loaded', async () => {
    const image = await makeSolidImage(255, 255, 255);
    const contents: ImageContentInfo[] = [makeContent(0, 'icon', { x: 10, y: 10, w: 40, h: 40 })];
    const provider = makeMockProvider(async () => ({ text: '齿轮设置图标', duration: 0 }));
    provider.isLoaded = () => false;

    await describeImageContents(provider as unknown as VisionProvider, image, contents);

    expect(provider.load).toHaveBeenCalledTimes(1);
    expect(contents[0]!.description).toBe('齿轮设置图标');
  });
});
