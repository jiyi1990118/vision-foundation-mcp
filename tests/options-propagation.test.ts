import { describe, expect, it } from 'vitest';
import { SkillPipeline } from '../src/core/skill-pipeline.js';
import type { VisionProvider } from '../src/providers/types.js';
import type { ExecutionPlan } from '../src/types/skills.js';
import type { ImageInput, InferenceRequest, InferenceResponse } from '../src/types/domain.js';

class RecordingProvider implements VisionProvider {
  constructor(readonly name = 'recording', readonly supportedSkills = ['summary']) {}

  readonly runtime = 'test';
  readonly supportedRuntimes = ['test'];
  readonly requirements = { minMemoryMB: 0, gpuRequired: false, modelSizeMB: 0 };
  requests: InferenceRequest[] = [];

  async load(): Promise<void> {}
  async unload(): Promise<void> {}
  isLoaded(): boolean { return true; }
  async infer(req: InferenceRequest): Promise<InferenceResponse> {
    this.requests.push(req);
    if (req.prompt.startsWith('OCR')) {
      return { text: JSON.stringify({ texts: [{ text: this.name }], language: 'en' }), duration: 1 };
    }
    if (req.prompt.includes('Classify')) {
      return { text: JSON.stringify({ category: 'ui', confidence: 0.9 }), duration: 1 };
    }
    return { text: JSON.stringify({ description: this.name }), duration: 1 };
  }
}

const image: ImageInput = {
  buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  mimeType: 'image/png',
  source: 'test',
  size: 4,
};

function makePlan(overrides: Partial<ExecutionPlan> = {}): ExecutionPlan {
  return {
    provider: 'recording',
    runtime: 'test',
    preprocess: [],
    skills: [
      {
        skill: 'summary',
        prompt: 'Summarize',
        schema: { required: ['description'] },
        priority: 0,
      },
    ],
    postprocess: ['merge'],
    timeout: 30000,
    retry: { max: 0, strategy: 'none' },
    ...overrides,
  };
}

describe('request option propagation', () => {
  it('passes plan maxTokens to provider inference requests', async () => {
    const provider = new RecordingProvider();
    const pipeline = new SkillPipeline(provider);

    await pipeline.execute(makePlan({ maxTokens: 42 }), image);

    expect(provider.requests[0]?.maxTokens).toBe(42);
  });

  it('passes plan cache flag to provider inference requests', async () => {
    const provider = new RecordingProvider();
    const pipeline = new SkillPipeline(provider);

    await pipeline.execute(makePlan({ cache: false }), image);

    expect(provider.requests[0]?.cache).toBe(false);
  });

  it('uses a per-skill provider override for matching skill tasks', async () => {
    const defaultProvider = new RecordingProvider('vlm', ['summary', 'ocr']);
    const ocrProvider = new RecordingProvider('ocr-provider', ['ocr']);
    const pipeline = new SkillPipeline(defaultProvider, { ocr: ocrProvider });

    await pipeline.execute(makePlan({
      skills: [
        { skill: 'ocr', prompt: 'OCR text', schema: { required: ['texts'] }, priority: 0 },
        { skill: 'summary', prompt: 'Summarize', schema: { required: ['description'] }, priority: 1 },
      ],
    }), image);

    expect(ocrProvider.requests).toHaveLength(1);
    expect(defaultProvider.requests).toHaveLength(1);
    expect(defaultProvider.requests[0]?.prompt).toBe('Summarize');
    expect(ocrProvider.requests[0]?.prompt).toBe('OCR text');
  });

  it('injects OCR text into dependent summary prompts only', async () => {
    const defaultProvider = new RecordingProvider('vlm', ['classify', 'summary', 'ocr']);
    const ocrProvider = new RecordingProvider('菜单中心\n比萨配料管理', ['ocr']);
    const pipeline = new SkillPipeline(defaultProvider, { ocr: ocrProvider });

    await pipeline.execute(makePlan({
      skills: [
        { skill: 'ocr', prompt: 'OCR text', schema: { required: ['texts'] }, priority: 0 },
        { skill: 'classify', prompt: 'Classify image', schema: { required: ['category'] }, priority: 1 },
        { skill: 'summary', prompt: 'Summarize image', schema: { required: ['description'] }, priority: 2, dependsOn: ['ocr'] },
      ],
    }), image);

    const classifyRequest = defaultProvider.requests.find((req) => req.prompt.startsWith('Classify'))!;
    const summaryRequest = defaultProvider.requests.find((req) => req.prompt.startsWith('Summarize'))!;
    expect(classifyRequest.prompt).not.toContain('OCR context');
    expect(summaryRequest.prompt).toContain('OCR context');
    expect(summaryRequest.prompt).toContain('比萨配料管理');
  });

  it('keeps injected OCR context short enough for small VLM context windows', async () => {
    const defaultProvider = new RecordingProvider('vlm', ['summary', 'ocr']);
    const longOcrText = Array.from({ length: 600 }, (_, index) => `字段${index}`).join('\n');
    const ocrProvider = new RecordingProvider(longOcrText, ['ocr']);
    const pipeline = new SkillPipeline(defaultProvider, { ocr: ocrProvider });

    await pipeline.execute(makePlan({
      skills: [
        { skill: 'ocr', prompt: 'OCR text', schema: { required: ['texts'] }, priority: 0 },
        { skill: 'summary', prompt: 'Summarize image', schema: { required: ['description'] }, priority: 1, dependsOn: ['ocr'] },
      ],
    }), image);

    expect(defaultProvider.requests[0]?.prompt.length).toBeLessThan(2400);
    expect(defaultProvider.requests[0]?.prompt).toContain('[truncated');
  });
});
