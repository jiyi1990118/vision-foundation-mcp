import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerVisionAnalyzeTool } from '../../src/tools/vision-analyze.js';
import type { VisionProvider } from '../../src/providers/types.js';
import type { InferenceRequest, InferenceResponse, VisionResult } from '../../src/types/domain.js';

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  structuredContent?: VisionResult;
  isError?: boolean;
}>;

const provider: VisionProvider = {
  name: 'ui-options-test',
  runtime: 'test',
  supportedRuntimes: ['test'],
  supportedSkills: ['classify', 'ocr', 'layout'],
  requirements: { minMemoryMB: 0, gpuRequired: false, modelSizeMB: 0 },
  async load() {},
  async infer(request: InferenceRequest): Promise<InferenceResponse> {
    if (request.prompt.includes('Extract all visible text')) {
      return {
        text: JSON.stringify({
          texts: [
            { text: '菜单中心', position: '10,20,120,40', confidence: 0.99 },
            { text: 'POS分类管理', position: '10,60,140,80', confidence: 0.99 },
            { text: '比萨配料管理', position: '10,100,160,120', confidence: 0.99 },
            { text: '商品管理', position: '300,20,420,40', confidence: 0.99 },
            { text: '名称', position: '300,80,360,100', confidence: 0.99 },
            { text: '价格', position: '420,80,480,100', confidence: 0.99 },
            { text: '编辑', position: '520,120,580,140', confidence: 0.99 },
            { text: '保存', position: '520,180,580,200', confidence: 0.99 },
          ],
          language: 'zh',
        }),
        duration: 1,
      };
    }
    if (request.prompt.includes('Classify this image')) {
      return { text: '{"category":"ui","confidence":0.99}', duration: 1 };
    }
    if (request.prompt.includes('Analyze the visual layout')) {
      return {
        text: '{"description":"two-column layout","layoutType":"columns"}',
        duration: 1,
      };
    }
    return { text: '{"insights":[],"risks":[],"next_actions":[]}', duration: 1 };
  },
  async unload() {},
  isLoaded() { return true; },
};

async function makeInput(): Promise<string> {
  const svg = `<svg width="300" height="200" xmlns="http://www.w3.org/2000/svg">
    <rect width="300" height="200" fill="#ffffff"/>
    <rect x="0" y="0" width="300" height="50" fill="#1677ff"/>
    <rect x="20" y="80" width="100" height="40" rx="8" fill="#eeeeee" stroke="#111111"/>
  </svg>`;
  const buffer = await sharp(Buffer.from(svg)).png().toBuffer();
  return `data:image/png;base64,${buffer.toString('base64')}`;
}

function captureHandler(): ToolHandler {
  let handler: ToolHandler | undefined;
  const server = {
    registerTool(
      _name: string,
      config: { inputSchema: { parse: (input: unknown) => unknown } },
      callback: ToolHandler,
    ) {
      handler = (args) => callback(config.inputSchema.parse(args) as Record<string, unknown>);
    },
  } as unknown as McpServer;
  registerVisionAnalyzeTool(server, [provider]);
  return (args) => handler!(args);
}

const photoProvider: VisionProvider = {
  ...provider,
  name: 'photo-options-test',
  async infer(request: InferenceRequest): Promise<InferenceResponse> {
    if (request.prompt.includes('Classify this image')) {
      return { text: '{"category":"photo","confidence":0.99}', duration: 1 };
    }
    return provider.infer(request);
  },
};

const documentProvider: VisionProvider = {
  ...provider,
  name: 'document-options-test',
  async infer(request: InferenceRequest): Promise<InferenceResponse> {
    if (request.prompt.includes('Classify this image')) {
      return { text: '{"category":"document","confidence":0.9}', duration: 1 };
    }
    return provider.infer(request);
  },
};

function captureHandlerWith(testProvider: VisionProvider): ToolHandler {
  let handler: ToolHandler | undefined;
  const server = {
    registerTool(
      _name: string,
      config: { inputSchema: { parse: (input: unknown) => unknown } },
      callback: ToolHandler,
    ) {
      handler = (args) => callback(config.inputSchema.parse(args) as Record<string, unknown>);
    },
  } as unknown as McpServer;
  registerVisionAnalyzeTool(server, [testProvider]);
  return (args) => handler!(args);
}

describe('vision.analyze UI output options', () => {
  it('filters disabled UI extraction branches throughout structuredContent', async () => {
    const response = await captureHandler()({
      image: await makeInput(),
      scene: 'ui',
      skills: ['classify', 'ocr'],
      options: {
        detect_layout: false,
        detect_component: false,
        detect_text: false,
        detect_icon: false,
        detect_theme: false,
      },
    });
    expect(response.isError).not.toBe(true);
    const result = response.structuredContent!.result;
    const layout = result.uiLayout as {
      structure: { regions: unknown[] };
      components: unknown[];
      texts: unknown[];
      mediaAreas: unknown[];
    };
    expect(layout.structure.regions).toEqual([]);
    expect(layout.components).toEqual([]);
    expect(layout.texts).toEqual([]);
    expect(layout.mediaAreas).toEqual([]);
    expect(result.design).toBeUndefined();
    const semanticUi = result.ui as { root: { children: Array<{ type: string; children: unknown[] }> } };
    expect(semanticUi.root.children.every((node) => (
      !['button', 'input', 'text', 'icon', 'image', 'avatar'].includes(node.type)
      && node.children.length === 0
    ))).toBe(true);
    expect(result.layout).toBeUndefined();
    expect(result.ocr).toBeDefined();
    const parse = result.parse as {
      uiLayout?: { regions: unknown[]; components: unknown[]; texts: unknown[] };
      design?: unknown;
      layout?: unknown;
      ocr?: unknown;
    };
    expect(parse.uiLayout?.regions).toEqual([]);
    expect(parse.uiLayout?.components).toEqual([]);
    expect(parse.uiLayout?.texts).toEqual([]);
    expect(parse.design).toBeUndefined();
    expect(parse.layout).toBeUndefined();
    expect(parse.ocr).toBeDefined();
  });

  it('returns only the compact reconstruction among UI-analysis branches in summary mode', async () => {
    const response = await captureHandler()({
      image: await makeInput(),
      scene: 'ui',
      skills: ['classify', 'ocr'],
      options: {
        summary_only: true,
        export_codegen: true,
        export_figma: true,
        export_markdown: true,
        embed_images: true,
        use_llm: true,
      },
    });
    expect(response.isError).not.toBe(true);
    const result = response.structuredContent!.result;
    expect(result.uiReconstruction).toBeDefined();
    expect((result.uiReconstruction as { tree: { children: unknown[] } }).tree.children).toEqual([]);
    for (const key of ['ui', 'layout', 'uiSemantics', 'codegenIr', 'figmaJson', 'uiMarkdown', 'imageContents', 'uiLayout', 'design']) {
      expect(result[key]).toBeUndefined();
    }
    expect(result.ocr).toBeDefined();
    const parse = result.parse as { layout?: unknown; uiLayout?: unknown; design?: unknown; ocr?: unknown };
    expect(parse.layout).toBeUndefined();
    expect(parse.uiLayout).toBeUndefined();
    expect(parse.design).toBeUndefined();
    expect(parse.ocr).toBeDefined();
  });

  it('honors explicit exports when the public AST is disabled', async () => {
    const response = await captureHandler()({
      image: await makeInput(),
      scene: 'ui',
      skills: ['classify', 'ocr'],
      options: { build_tree: false, export_codegen: true },
    });
    expect(response.isError).not.toBe(true);
    const result = response.structuredContent!.result;
    expect(result.ui).toBeUndefined();
    expect(result.uiReconstruction).toBeUndefined();
    expect(result.codegenIr).toBeDefined();
  });

  it('reports incompatible strict mode when neither a tree nor an export is requested', async () => {
    const response = await captureHandler()({
      image: await makeInput(),
      scene: 'ui',
      skills: ['classify'],
      options: { build_tree: false, strict_mode: true },
    });
    expect(response.isError).toBe(true);
    expect(response.structuredContent).toMatchObject({
      error: { code: 'INTERNAL_ERROR' },
    });
  });

  it.each([
    ['detect_text', { detect_text: false }],
    ['detect_component', { detect_component: false }],
  ])('suppresses OCR-derived layout when %s is disabled', async (_name, toggle) => {
    const response = await captureHandler()({
      image: await makeInput(),
      scene: 'ui',
      skills: ['classify', 'ocr'],
      options: toggle,
    });
    expect(response.isError).not.toBe(true);
    const result = response.structuredContent!.result;
    expect(result.layout).toBeUndefined();
    expect((result.parse as { layout?: unknown }).layout).toBeUndefined();
    expect(result.ocr).toBeDefined();
  });

  it('preserves an explicitly requested layout skill result in summary mode', async () => {
    const response = await captureHandler()({
      image: await makeInput(),
      scene: 'ui',
      skills: ['classify', 'ocr', 'layout'],
      options: { summary_only: true },
    });
    expect(response.isError).not.toBe(true);
    expect(response.structuredContent!.result.layout).toEqual({
      description: 'two-column layout',
      layoutType: 'columns',
    });
    expect((response.structuredContent!.result.parse as { layout?: unknown }).layout).toBeUndefined();
  });

  it('does not apply UI-only strict compatibility checks to non-UI requests', async () => {
    const response = await captureHandlerWith(photoProvider)({
      image: await makeInput(),
      skills: ['classify'],
      options: { build_tree: false, strict_mode: true },
    });
    expect(response.isError).not.toBe(true);
  });

  it('fails strict mode when a requested UI export is unavailable for a non-UI result', async () => {
    const response = await captureHandlerWith(photoProvider)({
      image: await makeInput(),
      skills: ['classify'],
      options: { build_tree: false, export_codegen: true, strict_mode: true },
    });
    expect(response.isError).toBe(true);
    expect(response.structuredContent).toMatchObject({
      error: { code: 'INTERNAL_ERROR', message: expect.stringMatching(/codegen/i) },
    });
  });

  it('uses OCR-promoted final UI category for strict reconstruction gating', async () => {
    const response = await captureHandlerWith(documentProvider)({
      image: await makeInput(),
      skills: ['classify', 'ocr'],
      options: { strict_mode: true },
    });
    expect(response.isError).not.toBe(true);
    expect(response.structuredContent?.category).toBe('ui');
    expect(response.structuredContent?.result.uiReconstruction).toBeDefined();
  });
});
