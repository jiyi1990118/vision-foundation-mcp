import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { runUiAnalysis } from '../../src/ui-analysis/orchestrator.js';
import type { UiLayoutExtraction } from '../../src/core/extractors/ui-layout-extractor.js';
import type { ImageInput } from '../../src/types/domain.js';
import type { VisionProvider } from '../../src/providers/types.js';

async function makeImage(): Promise<ImageInput> {
  const svg = `<svg width="300" height="200" xmlns="http://www.w3.org/2000/svg">
    <rect x="0" y="0" width="300" height="200" fill="#ffffff"/>
    <rect x="0" y="0" width="300" height="50" fill="#1677ff"/>
    <circle cx="262" cy="22" r="10" fill="#ffffff"/>
    <rect x="20" y="70" width="120" height="40" rx="8" ry="8" fill="#ffffff" stroke="#d9d9d9"/>
  </svg>`;
  const buf = await sharp(Buffer.from(svg)).png().toBuffer();
  return { buffer: buf, mimeType: 'image/png', source: 'test', size: buf.length };
}

function makeLayout(): UiLayoutExtraction {
  return {
    structure: {
      pageType: 'card',
      layoutType: 'centered',
      regions: [
        { id: 'r0', type: 'header', bbox: { x: 0, y: 0, w: 300, h: 50 }, relativeArea: 0.25, bgColor: '#1677ff', children: [] },
        { id: 'r1', type: 'card', bbox: { x: 20, y: 70, w: 120, h: 40 }, relativeArea: 0.1, bgColor: '#ffffff', children: [] },
      ],
    },
    components: [
      { type: 'button', bbox: { x: 40, y: 80, w: 80, h: 24 }, text: '保存', state: 'default', variant: 'primary' },
    ],
    texts: [{ text: '保存', bbox: { x: 50, y: 84, w: 60, h: 16 }, estimatedLevel: 'body' }],
    spacing: { averageGap: 10, scale: 'comfortable', verticalGaps: [10], horizontalGaps: [10] },
    mediaAreas: [{ bbox: { x: 250, y: 10, w: 24, h: 24 }, type: 'logo', nearbyText: 'Logo' }],
    summary: '',
  };
}

const mockProvider: VisionProvider = {
  name: 'mock',
  runtime: 'mock',
  supportedRuntimes: [],
  supportedSkills: [],
  requirements: { minMemoryMB: 0, gpuRequired: false, modelSizeMB: 0 },
  load: async () => {},
  infer: async (req) => ({ text: `desc:${req.image.source}`, duration: 1 }),
  unload: async () => {},
  isLoaded: () => true,
};

describe('runUiAnalysis orchestrator (S22)', () => {
  it('produces ui, uiSemantics, codegenIr, imageContents and uiReconstruction with styles', async () => {
    const image = await makeImage();
    const result = await runUiAnalysis({
      uiLayoutExtraction: makeLayout(),
      image,
      options: { buildTree: true, exportCodegen: true },
    });

    expect(result.ui).toBeDefined();
    expect(result.ui!.root.type).toBe('page');
    expect(result.uiSemantics).toBeDefined();
    expect(result.codegenIr).toBeDefined();
    expect(result.imageContents).toBeDefined();
    expect(result.imageContents!.length).toBe(1);
    expect(result.uiReconstruction).toBeDefined();
    expect(result.uiReconstruction!.tree.type).toBe('page');

    const header = result.ui!.root.children[0]!;
    expect(header.props.style).toBeDefined();
    expect(header.props.bgColor).toBe('#1677ff');
  });

  it('describes image contents when useLlm is true', async () => {
    const image = await makeImage();
    const result = await runUiAnalysis({
      uiLayoutExtraction: makeLayout(),
      image,
      provider: mockProvider,
      options: { buildTree: true, useLlm: true },
    });

    expect(result.imageContents).toBeDefined();
    expect(result.imageContents![0]!.description).toBeDefined();
  });

  it('omits ui when buildTree is false but still exports codegen', async () => {
    const image = await makeImage();
    const result = await runUiAnalysis({
      uiLayoutExtraction: makeLayout(),
      image,
      options: { buildTree: false, exportCodegen: true },
    });

    expect(result.ui).toBeUndefined();
    expect(result.codegenIr).toBeDefined();
  });

  it('degrades gracefully without an image (no styles, still produces ast)', async () => {
    const result = await runUiAnalysis({
      uiLayoutExtraction: makeLayout(),
      options: { buildTree: true },
    });

    expect(result.ui).toBeDefined();
    expect(result.ui!.root.children[0]!.props.style).toBeUndefined();
    expect(result.uiReconstruction).toBeDefined();
  });
});
