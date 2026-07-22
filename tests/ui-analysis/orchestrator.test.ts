import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { runUiAnalysis } from '../../src/ui-analysis/orchestrator.js';
import type { UiLayoutExtraction } from '../../src/core/extractors/ui-layout-extractor.js';
import type { ImageInput } from '../../src/types/domain.js';
import type { VisionProvider } from '../../src/providers/types.js';
import type { ASTNode, CodegenNode } from '../../src/ui-analysis/ir/types.js';

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

function collectNodeTypes(node: ASTNode | CodegenNode, out = new Map<string, string>()): Map<string, string> {
  out.set(node.id, node.type);
  for (const child of node.children) collectNodeTypes(child, out);
  return out;
}

function containsText(node: CodegenNode, text: string): boolean {
  return node.text === text || node.children.some((child) => containsText(child, text));
}

function makeCardListLayout(): UiLayoutExtraction {
  return {
    structure: {
      pageType: 'list',
      layoutType: 'stack',
      regions: [
        { id: 'table', type: 'table', bbox: { x: 0, y: 0, w: 300, h: 300 }, relativeArea: 1, children: [] },
        { id: 'card-1', type: 'card', bbox: { x: 10, y: 10, w: 280, h: 80 }, relativeArea: 0.25, children: [] },
        { id: 'card-2', type: 'card', bbox: { x: 10, y: 110, w: 280, h: 80 }, relativeArea: 0.25, children: [] },
        { id: 'card-3', type: 'card', bbox: { x: 10, y: 210, w: 280, h: 80 }, relativeArea: 0.25, children: [] },
      ],
    },
    components: [],
    texts: [],
    spacing: { averageGap: 20, scale: 'spacious', verticalGaps: [20, 20], horizontalGaps: [] },
    mediaAreas: [],
    summary: '',
  };
}

function makePopulatedDrawerLayout(): UiLayoutExtraction {
  return {
    structure: {
      pageType: 'navigation',
      layoutType: 'sidebar',
      regions: [
        { id: 'drawer', type: 'content', bbox: { x: 0, y: 0, w: 100, h: 400 }, relativeArea: 0.33, children: [] },
        { id: 'main', type: 'main', bbox: { x: 100, y: 0, w: 200, h: 400 }, relativeArea: 0.67, children: [] },
      ],
    },
    components: [],
    texts: [
      { text: '菜单一', bbox: { x: 10, y: 30, w: 60, h: 20 }, estimatedLevel: 'body' },
      { text: '菜单二', bbox: { x: 10, y: 70, w: 60, h: 20 }, estimatedLevel: 'body' },
    ],
    spacing: { averageGap: 20, scale: 'spacious', verticalGaps: [20], horizontalGaps: [] },
    mediaAreas: [],
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
    expect(result.ui!.root.bbox).toEqual({ x: 0, y: 0, w: 300, h: 200 });
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

  it('rebuilds codegenIr from the final enriched AST', async () => {
    const result = await runUiAnalysis({
      uiLayoutExtraction: makeCardListLayout(),
      options: { exportCodegen: true },
    });

    const uiTypes = collectNodeTypes(result.ui!.root);
    const codegenTypes = collectNodeTypes(result.codegenIr!.root);
    expect(codegenTypes).toEqual(uiTypes);
    expect([...uiTypes.values()]).toContain('list');
    expect([...uiTypes.values()]).toContain('listItem');

    const ids = new Set(uiTypes.keys());
    for (const constraint of result.codegenIr!.constraints) expect(ids.has(constraint.targetId)).toBe(true);
    for (const repeat of result.codegenIr!.repeats) {
      expect(ids.has(repeat.targetId)).toBe(true);
      if (repeat.templateId) expect(ids.has(repeat.templateId)).toBe(true);
    }
    for (const slot of result.codegenIr!.slots) expect(ids.has(slot.id)).toBe(true);
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
    expect(result.codegenIr!.root.bbox).toEqual({ x: 0, y: 0, w: 300, h: 200 });
    expect(containsText(result.codegenIr!.root, '保存')).toBe(true);
  });

  it('rebuilds enriched exports even when the public tree is disabled', async () => {
    const image = await makeImage();
    const result = await runUiAnalysis({
      uiLayoutExtraction: makeCardListLayout(),
      image,
      options: { buildTree: false, exportCodegen: true },
    });

    expect(result.ui).toBeUndefined();
    expect([...collectNodeTypes(result.codegenIr!.root).values()]).toContain('list');
    expect(result.codegenIr!.root.props.style).toBeDefined();
  });

  it('validates explicitly requested exports when strict mode keeps the AST private', async () => {
    const result = await runUiAnalysis({
      uiLayoutExtraction: makeLayout(),
      options: { buildTree: false, exportCodegen: true, strictMode: true },
    });
    expect(result.ui).toBeUndefined();
    expect(result.codegenIr).toBeDefined();
  });

  it('fails strict mode when a private AST cannot produce the requested export', async () => {
    const malformed = makeLayout() as unknown as UiLayoutExtraction & {
      structure: { regions: undefined };
    };
    malformed.structure.regions = undefined;

    await expect(runUiAnalysis({
      uiLayoutExtraction: malformed,
      options: { buildTree: false, exportCodegen: true, strictMode: true },
    })).rejects.toThrow(/codegen/i);
  });

  it('rejects strict mode with no public tree or explicit export to validate', async () => {
    await expect(runUiAnalysis({
      uiLayoutExtraction: makeLayout(),
      options: { buildTree: false, strictMode: true },
    })).rejects.toThrow(/export|buildTree/i);
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

  it('collects skipped enrichment stages into uiReconstruction.diagnostics', async () => {
    const badImage: ImageInput = {
      buffer: Buffer.from('not-an-image'),
      mimeType: 'image/png',
      source: 'bad',
      size: 11,
    };
    const result = await runUiAnalysis({
      uiLayoutExtraction: makeLayout(),
      image: badImage,
      options: { buildTree: true },
    });

    expect(result.uiReconstruction).toBeDefined();
    expect(result.uiReconstruction!.diagnostics).toBeDefined();
    const skipped = result.uiReconstruction!.diagnostics!.skipped;
    expect(skipped).toContain('mediaAreaFilter');
    expect(skipped).toContain('styleExtraction');
    expect(skipped).toContain('overlayDetection');
  });

  it('trims uiReconstruction to a root-only tree when summaryOnly is true', async () => {
    const image = await makeImage();
    const result = await runUiAnalysis({
      uiLayoutExtraction: makeLayout(),
      image,
      options: { buildTree: true, summaryOnly: true },
    });

    expect(result.uiReconstruction).toBeDefined();
    const recon = result.uiReconstruction!;
    expect(recon.tree.children).toEqual([]);
    expect(recon.constraints).toEqual([]);
    expect(recon.images).toEqual([]);
    expect(recon.repeats).toBeUndefined();
    expect(recon.slots).toBeUndefined();
    expect(recon.responsive).toBeUndefined();
    expect(recon.stats.nodeCount).toBeGreaterThan(1);
    expect(result.ui).toBeUndefined();
    expect(result.uiSemantics).toBeUndefined();
    expect(result.codegenIr).toBeUndefined();
    expect(result.figmaJson).toBeUndefined();
    expect(result.uiMarkdown).toBeUndefined();
    expect(result.imageContents).toBeUndefined();
  });

  it('throws when strict mode cannot build a reconstruction', async () => {
    const malformed = makeLayout() as unknown as UiLayoutExtraction & {
      structure: { regions: undefined };
    };
    malformed.structure.regions = undefined;

    await expect(runUiAnalysis({
      uiLayoutExtraction: malformed,
      options: { strictMode: true },
    })).rejects.toThrow(/uiReconstruction/);
  });

  it('stops immediately when the request is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(runUiAnalysis({
      uiLayoutExtraction: makeLayout(),
      signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('does not rewrite an ordinary populated sidebar partition as a drawer', async () => {
    const result = await runUiAnalysis({ uiLayoutExtraction: makePopulatedDrawerLayout() });
    const sidebar = result.ui!.root.children.find((node) => node.props.regionId === 'drawer');
    expect(sidebar?.type).not.toBe('drawer');
    expect(sidebar?.props.overlay).toBeUndefined();
    expect(sidebar?.children).toHaveLength(2);
  });

  it('does not infer overlays when component detection is disabled', async () => {
    const layout = makePopulatedDrawerLayout();
    layout.structure.layoutType = 'stack';
    layout.structure.regions[1]!.bbox = { x: 0, y: 0, w: 300, h: 400 };
    const result = await runUiAnalysis({
      uiLayoutExtraction: layout,
      options: { detectComponent: false },
    });
    const panel = result.ui!.root.children.find((node) => node.props.regionId === 'drawer');
    expect(panel?.type).not.toBe('drawer');
    expect(panel?.props.overlay).toBeUndefined();
  });
});
